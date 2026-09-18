"use strict";

const { createBatch } = require("../../storage/scan_store");
const { upsertJob } = require("../../storage/job_store");
const { getActiveSearchPlan } = require("../../storage/candidate_store");
const {
  ensureProgressCard,
  bindProgressCardThread,
  findMessageDiscoveryJobContext
} = require("../../core/candidate_progress");
const { canonicalBossJobSourceId } = require("../../core/boss_job_identity");

function createMessageDiscoveryJobContextResolver({
  db,
  profileId,
  messageReader,
  detailReader,
  now = () => new Date().toISOString()
} = {}) {
  const normalizedProfileId = positiveInteger(profileId, "profileId");
  if (!db) throw new TypeError("db is required");
  if (typeof messageReader?.readSelectedJobTarget !== "function") {
    throw new TypeError("messageReader.readSelectedJobTarget is required");
  }
  if (typeof messageReader?.assertActiveBindings !== "function") {
    throw new TypeError("messageReader.assertActiveBindings is required");
  }
  if (typeof detailReader?.readSelectedJobDetail !== "function") {
    throw new TypeError("detailReader.readSelectedJobDetail is required");
  }

  return async function resolveMessageDiscoveryJobContext({ target, selected, candidate = null, signal = null } = {}) {
    const plan = getActiveSearchPlan(db, normalizedProfileId);
    if (!plan) {
      throw contextError("MESSAGE_DISCOVERY_ACTIVE_PLAN_REQUIRED", "an active search plan is required");
    }
    const jobTarget = trustedJobTarget(await messageReader.readSelectedJobTarget(selected, signal));
    const localSourceId = canonicalBossJobSourceId(jobTarget.jobId);
    await messageReader.assertActiveBindings();
    const known = candidateMatches(candidate, {
      profileId: normalizedProfileId,
      planId: plan.id,
      sourceId: localSourceId
    })
      ? candidate
      : findMessageDiscoveryJobContext(db, {
        profileId: normalizedProfileId,
        planId: plan.id,
        sourceId: localSourceId
      });
    if (known?.contextComplete) {
      return bindContext(known, target?.conversationKey, "local_cache", now());
    }

    let rawDetail;
    try {
      rawDetail = await detailReader.readSelectedJobDetail({
        communicationTabId: target?.tabId,
        selected,
        jobTarget,
        signal
      });
    } catch (error) {
      if (error?.code !== "BOSS_MESSAGE_DETAIL_UNAVAILABLE") throw error;
      return bindContext(
        persistUnavailableContext(plan, localSourceId, jobTarget, selected, target),
        target?.conversationKey,
        "message_discovery_unavailable",
        now()
      );
    }
    const detail = trustedDetail(rawDetail, jobTarget);
    const batchId = createBatch(db, "boss", "message-discovery-detail", "message discovery detail", {
      profileId: normalizedProfileId,
      searchPlanId: plan.id,
      filterSnapshot: { mode: "message-discovery-detail", sourceId: detail.sourceId }
    });
    const jobId = upsertJob(db, {
      ...detail,
      source: "boss",
      keyword: "message-discovery-detail",
      url: detail.canonicalUrl,
      qualityTags: [],
      analysis: {
        provider: "message-discovery-detail",
        semanticStatus: "pending",
        decisionSource: "analysis_pending",
        recommendation: null
      }
    }, batchId);
    const complete = findMessageDiscoveryJobContext(db, {
      profileId: normalizedProfileId,
      planId: plan.id,
      sourceId: detail.sourceId
    });
    if (!complete?.contextComplete) {
      throw contextError("MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE", "job context is incomplete");
    }
    return bindContext(complete, target?.conversationKey, "message_discovery_detail", now());
  };

  function bindContext(context, threadKey, contextSource, occurredAt) {
    let card = ensureProgressCard(db, {
      profileId: normalizedProfileId,
      planId: context.planId,
      jobId: context.jobId,
      source: "boss",
      now: occurredAt
    });
    card = bindProgressCardThread(db, {
      cardId: card.id,
      threadKey,
      now: occurredAt
    });
    return {
      cardId: card.id,
      card,
      job: contextJob(context),
      threadKey: card.threadKey,
      contextSource
    };
  }

  function persistUnavailableContext(plan, sourceId, jobTarget, selected, target) {
    const title = boundedText(selected?.positionName || target?.positionTitle, 240);
    const company = boundedText(selected?.companyName || target?.company, 240);
    if (!title) throw contextError("MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE", "removed job identity is incomplete");
    const batchId = createBatch(db, "boss", "message-discovery-unavailable", "removed message job", {
      profileId: normalizedProfileId,
      searchPlanId: plan.id,
      filterSnapshot: { mode: "message-discovery-unavailable", sourceId }
    });
    upsertJob(db, {
      source: "boss", sourceId, keyword: "message-discovery-unavailable", title, company,
      location: boundedText(selected?.city || target?.city, 120),
      salary: boundedText(selected?.salary || target?.salary, 120),
      experience: "", education: "", bossActiveText: "", url: jobTarget.canonicalUrl,
      tags: [], description: "", qualityTags: ["source_unavailable"],
      analysis: { provider: "message-discovery-unavailable", semanticStatus: "unavailable",
        decisionSource: "source_unavailable", recommendation: null, sourceAvailability: "offline" }
    }, batchId);
    const context = findMessageDiscoveryJobContext(db, {
      profileId: normalizedProfileId, planId: plan.id, sourceId
    });
    if (!context?.contextComplete) throw contextError("MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE", "removed job context is unavailable");
    return context;
  }
}

function candidateMatches(candidate, expected) {
  return candidate?.contextComplete === true
    && Number(candidate.profileId) === expected.profileId
    && Number(candidate.planId) === expected.planId
    && String(candidate.sourceId || "") === expected.sourceId;
}

function trustedJobTarget(value) {
  const jobId = String(value?.jobId || "").trim();
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(jobId)) {
    throw contextError("MESSAGE_DISCOVERY_JOB_TARGET_INVALID", "job target is invalid");
  }
  return { ...value, jobId };
}

function trustedDetail(value, target) {
  const rawSourceId = String(value?.sourceId || "").trim();
  if (rawSourceId !== target.jobId) {
    throw contextError("MESSAGE_DISCOVERY_JOB_TARGET_MISMATCH", "job detail target does not match");
  }
  const sourceId = canonicalBossJobSourceId(rawSourceId);
  const canonicalUrl = canonicalBossJobUrl(value?.canonicalUrl, rawSourceId);
  const description = String(value?.description || "").trim();
  if (description.length < 120) {
    throw contextError("MESSAGE_DISCOVERY_JOB_DETAIL_INCOMPLETE", "job detail is incomplete");
  }
  return {
    sourceId,
    canonicalUrl,
    title: boundedText(value?.title, 240),
    company: boundedText(value?.company, 240),
    location: boundedText(value?.location, 120),
    salary: boundedText(value?.salary, 120),
    experience: boundedText(value?.experience, 120),
    education: boundedText(value?.education, 120),
    bossActiveText: boundedText(value?.bossActiveText, 120),
    tags: Array.isArray(value?.tags)
      ? [...new Set(value.tags.map((item) => boundedText(item, 120)).filter(Boolean))].slice(0, 40)
      : [],
    description: description.slice(0, 12000)
  };
}

function canonicalBossJobUrl(value, sourceId) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw contextError("MESSAGE_DISCOVERY_JOB_URL_INVALID", "job detail URL is invalid");
  }
  const expectedPath = `/job_detail/${sourceId}.html`;
  if (url.origin !== "https://www.zhipin.com"
    || url.pathname !== expectedPath
    || url.search
    || url.hash
    || url.username
    || url.password) {
    throw contextError("MESSAGE_DISCOVERY_JOB_URL_INVALID", "job detail URL is invalid");
  }
  return `https://www.zhipin.com${expectedPath}`;
}

function contextJob(context) {
  return {
    id: context.jobId,
    source: context.source,
    sourceId: context.sourceId,
    title: context.title,
    company: context.company,
    salary: context.salary,
    location: context.city,
    experience: context.experience,
    education: context.education,
    bossActiveText: context.bossActiveText,
    url: context.url,
    tags: context.tags,
    description: context.description,
    qualityTags: context.qualityTags,
    analysis: context.analysis,
    observationId: context.observationId,
    batchId: context.batchId
  };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw contextError("MESSAGE_DISCOVERY_INPUT_INVALID", `${name} must be a positive integer`);
  }
  return number;
}

function boundedText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function contextError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  createMessageDiscoveryJobContextResolver
};
