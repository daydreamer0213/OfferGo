const { getCandidateProfile, getSearchPlan, listCandidateResumeVersions, listCandidateFacts,
  getCandidateResumeDocument } = require("../../storage/candidate_store");
const { listCandidateAnswerMemories, listCandidateFactRevisions } = require("../../storage/message_learning_store");
const { listCandidateEvidence } = require('../../storage/candidate_evidence_store');
const { selectRelevantCandidateMaterial } = require('../../core/candidate_evidence');
const { mergeCandidateFacts, currentCandidateMaterial, factStatus } = require('../../core/candidate_fact_policy');
const { listDecisionPool, listJobIdentities, listJobSummaries } = require("../../storage/job_store");
const { createResumeOptimization, getResumeOptimization, listResumeOptimizations,
  saveResumeOptimizationDraft, activateResumeOptimization, findEditableResumeCopy } = require("../../storage/resume_optimization_store");
const { prepareResumeTextForModel } = require("../../core/resume_privacy");
const {
  buildResumeEvidenceCatalog,
  restoreResumeSuggestionAnchors,
  validateResumeOptimizationDraft,
  validateResumeActivationText,
  renderOptimizedResume,
  selectRepresentativeResumeJobs
} = require("../../core/resume_optimization");
const { createFunnelAnalysisService } = require("../funnel_analysis");

function createResumeOptimizationService({ db, adapter = null, funnelAnalysisService = null } = {}) {
  if (!db) throw new Error("resume optimization service requires db");
  const funnelAnalysis = funnelAnalysisService || createFunnelAnalysisService({ db });

  return Object.freeze({
    createDraft,
    copyDraft,
    getDraft,
    listDrafts,
    saveDraft,
    activateDraft,
    dashboard
  });

  async function createDraft(input = {}) {
    const profileId = requiredId(input.profileId, "profileId");
    const plan = ownedPlan(profileId, input.planId);
    const source = ownedSource(profileId, input.sourceResumeVersionId);
    const mode = input.mode || 'direction';
    if (!['general', 'job_specific', 'direction'].includes(mode)) throw serviceError('RESUME_OPTIMIZATION_MODE_INVALID', '请选择简历优化方式');
    let targetDirection = '';
    let jobs = [];
    if (mode !== 'general') {
      const pool = listDecisionPool(db, { planId: plan.id }).filter(isCompleteJob);
      if (mode === 'job_specific') {
        const selected = pool.find(job => job.id === requiredId(input.jobId, 'jobId'));
        if (!selected) throw serviceError('RESUME_OPTIMIZATION_JOB_NOT_OWNED', '请选择当前方案中资料完整的岗位');
        jobs = [selected];
        targetDirection = selected.title;
      } else {
        targetDirection = ownedDirection(plan, input.targetDirection);
        jobs = selectRepresentativeResumeJobs(pool, { targetDirection, limit: 5 });
      }
    }
    if (mode !== 'general' && !jobs.length) {
      throw serviceError("RESUME_OPTIMIZATION_NO_COMPLETE_JD", "当前方向还没有可核验的完整岗位信息，暂时不能生成定向简历");
    }
    if (!adapter || typeof adapter.generateResumeOptimization !== "function") {
      throw serviceError("RESUME_OPTIMIZATION_MODEL_UNAVAILABLE", "当前深度分析模型不可用，请先检查模型设置");
    }

    const profile = getCandidateProfile(db, profileId);
    const identityNames = [profile?.displayName, profile?.profile?.candidate?.name]
      .map((value) => String(value || "").trim()).filter(Boolean);
    const prepared = prepareResumeTextForModel(source.text, {
      identity: { names: identityNames },
      originalFileName: source.fileName,
      strict: true
    });
    const { facts, evidence, materialPolicy } = currentMaterial(profileId, jobs[0] || {});
    const query = jobs.map(job => job.description).join('\n') || prepared.text;
    const candidateEvidence = selectRelevantCandidateMaterial(evidence, {
      query, job: jobs[0] || {}, limit: 12, maxChars: 16000
    });
    const answers = selectRelevantCandidateMaterial(currentCandidateMaterial(applicableAnswers(listCandidateAnswerMemories(db, {
      profileId,
      activeOnly: true,
      source: "user_edited_reply",
      limit: 500
    }), jobs), materialPolicy), { query, job: jobs[0] || {}, limit: 12, maxChars: 16000 });
    const funnelDiagnosis = compactDiagnosis(funnelAnalysis.getDashboard({ profileId, planId: plan.id }));
    const evidenceCatalog = buildResumeEvidenceCatalog({
      sourceText: prepared.text,
      jobs,
      facts,
      answerMemories: answers,
      candidateEvidence,
      diagnosis: funnelDiagnosis
    });
    const modelInput = {
      mode,
      candidateEvidence,
      sourceResume: {
        id: source.id,
        documentId: source.documentId,
        contentHash: source.contentHash,
        text: prepared.text
      },
      targetDirection,
      jobs: jobs.map(modelJob),
      candidateFacts: facts,
      answerMemories: answers,
      funnelDiagnosis,
      evidenceCatalog
    };
    const raw = await adapter.generateResumeOptimization(modelInput);
    const restored = restoreResumeSuggestionAnchors(raw, { sourceText: source.text, modelText: prepared.text });
    // Suggestion IDs are local form keys, not model-supplied evidence references.
    if (Array.isArray(restored?.suggestions)) {
      restored.suggestions = restored.suggestions.map((item, index) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? { ...item, id: `S${index + 1}` } : item);
    }
    const validated = validateResumeOptimizationDraft(restored, {
      sourceText: source.text,
      evidenceCatalog
    });
    const generatedText = renderOptimizedResume(source.text, validated.suggestions);
    return createResumeOptimization(db, {
      mode,
      profileId,
      planId: plan.id,
      sourceResumeVersionId: source.id,
      targetDirection,
      targetJobIds: jobs.map((job) => job.id),
      evidenceCatalog,
      headline: validated.headline,
      suggestions: validated.suggestions,
      generatedText,
      modelIdentity: {
        provider: String(adapter.provider || "unknown"),
        model: String(adapter.model || "")
      }
    });
  }

  function copyDraft({ profileId, planId, draftId } = {}) {
    const owned = getDraft({ profileId, draftId });
    if (!owned) throw serviceError('RESUME_OPTIMIZATION_NOT_FOUND', '简历版本不存在');
    const plan = ownedPlan(owned.profileId, planId);
    if (owned.planId !== plan.id) throw serviceError('RESUME_OPTIMIZATION_PLAN_MISMATCH', '请从这份简历所属的方案继续编辑');
    if (owned.status !== 'activated' || owned.draftFormat !== 'whole_draft') {
      throw serviceError('RESUME_OPTIMIZATION_CLOSED', '请选择已启用的完整简历版本');
    }
    const existing = findEditableResumeCopy(db, { profileId: owned.profileId, planId: plan.id, draftId: owned.id });
    if (existing) return existing;
    return createResumeOptimization(db, {
      profileId: owned.profileId, planId: plan.id, sourceResumeVersionId: owned.sourceResumeVersionId,
      mode: owned.mode, targetDirection: owned.targetDirection, targetJobIds: owned.targetJobIds,
      generatedText: owned.generatedText, finalText: owned.finalText,
      headline: owned.headline, suggestions: owned.changeLedger, evidenceCatalog: owned.evidenceCatalog,
      modelIdentity: { ...owned.modelIdentity, copiedFromDraftId: owned.id }
    });
  }

  function getDraft({ profileId, draftId, optimizationId } = {}) {
    return getResumeOptimization(db, {
      profileId: requiredId(profileId, "profileId"),
      optimizationId: requiredId(draftId || optimizationId, "draftId")
    });
  }

  function listDrafts({ profileId, limit = 30 } = {}) {
    return listResumeOptimizations(db, requiredId(profileId, "profileId"), limit);
  }

  function saveDraft({ profileId, planId, draftId, optimizationId, finalText } = {}) {
    const owned = getDraft({ profileId, draftId: draftId || optimizationId });
    if (!owned) throw serviceError("RESUME_OPTIMIZATION_NOT_FOUND", "定向简历草稿不存在");
    const plan = ownedPlan(owned.profileId, planId);
    if (owned.planId !== plan.id) {
      throw serviceError("RESUME_OPTIMIZATION_PLAN_MISMATCH", "这份定向简历不属于当前投递方案，请返回原方案修改");
    }
    if (owned.status !== "draft") throw serviceError("RESUME_OPTIMIZATION_CLOSED", "已启用的定向简历不能继续修改");
    const saved = saveResumeOptimizationDraft(db, {
      profileId: owned.profileId,
      planId: plan.id,
      optimizationId: owned.id,
      finalText
    });
    return { ...saved, integrity: integrityFor(saved, saved.finalText) };
  }

  function activateDraft({ profileId, planId, draftId, optimizationId, finalText } = {}) {
    const owned = getDraft({ profileId, draftId: draftId || optimizationId });
    if (!owned) throw serviceError("RESUME_OPTIMIZATION_NOT_FOUND", "定向简历草稿不存在");
    const plan = ownedPlan(owned.profileId, planId);
    if (owned.planId !== plan.id) {
      throw serviceError("RESUME_OPTIMIZATION_PLAN_MISMATCH", "这份定向简历不属于当前投递方案，请返回原方案启用");
    }
    let integrity = null;
    if (owned.status === "draft") {
      integrity = integrityFor(owned, finalText);
      if (!integrity.valid) {
        const error = serviceError("RESUME_ACTIVATION_INTEGRITY_FAILED", "当前简历仍有需要修改的问题，尚未启用");
        error.issues = publicIssues(integrity.errors);
        throw error;
      }
    }
    const activated = activateResumeOptimization(db, {
      profileId: owned.profileId,
      planId: plan.id,
      optimizationId: owned.id,
      finalText,
      version: {
        name: owned.mode === 'general' ? '通用整理版' : owned.targetDirection ? `${owned.targetDirection}定向版` : "定向简历",
        targetRoles: owned.targetDirection ? [owned.targetDirection] : [],
        summary: owned.headline || "基于目标岗位证据生成并由用户确认的定向版本。"
      }
    });
    return { ...activated, integrity };
  }

  function dashboard({ profileId, planId, draftId = null } = {}) {
    const profile = requiredId(profileId, "profileId");
    const plan = ownedPlan(profile, planId);
    const jobs = listDecisionPool(db, { planId: plan.id }).filter(isCompleteJob);
    const directions = Array.isArray(plan.plan?.directions) ? plan.plan.directions : [];
    const sampleJobsByDirection = Object.fromEntries(directions.map((direction) => [direction,
      selectRepresentativeResumeJobs(jobs, { targetDirection: direction, limit: 5 })
        .map((job) => ({ id: Number(job.id), title: job.title, company: job.company }))
    ]));
    const drafts = listResumeOptimizations(db, profile, 30).filter((draft) => draft.planId === plan.id);
    const selectedDraft = draftId
      ? getResumeOptimization(db, { profileId: profile, optimizationId: draftId })
      : drafts[0] || null;
    const scopedDraft = selectedDraft?.planId === plan.id ? selectedDraft : null;
    return {
      profile: getCandidateProfile(db, profile),
      plan,
      resumes: listCandidateResumeVersions(db, profile),
      jobs,
      directions,
      sampleJobsByDirection,
      drafts,
      selectedDraft: scopedDraft,
      selectedJobs: scopedDraft ? rowsForJobIds(scopedDraft.targetJobIds) : [],
      selectedIntegrity: scopedDraft?.status === "draft"
        ? integrityFor(scopedDraft, scopedDraft.finalText)
        : null,
      funnelDiagnosis: compactDiagnosis(funnelAnalysis.getDashboard({ profileId: profile, planId: plan.id }))
    };
  }

  function integrityFor(draft, finalText) {
    const source = ownedSource(draft.profileId, draft.sourceResumeVersionId);
    const profile = getCandidateProfile(db, draft.profileId);
    const jobs = integrityJobs(draft.targetJobIds);
    const job = jobs[0] || {};
    const { facts, evidence, materialPolicy } = currentMaterial(draft.profileId, job);
    const answers = currentCandidateMaterial(applicableAnswers(listCandidateAnswerMemories(db, {
      profileId: draft.profileId,
      activeOnly: true,
      source: "user_edited_reply",
      limit: 500
    }), jobs), materialPolicy);
    return validateResumeActivationText({
      sourceText: source.text,
      sourceEvidenceText: currentCandidateMaterial([{ text: source.text, source: 'active_resume' }], materialPolicy)
        .map(item => item.text).join('\n'),
      generatedText: draft.generatedText,
      finalText,
      candidateName: profile?.profile?.candidate?.name || profile?.displayName || "",
      facts,
      candidateEvidence: selectRelevantCandidateMaterial(evidence, {
        query: finalText, job, limit: 12, maxChars: 16000
      }),
      answerMemories: answers,
      suggestions: draft.changeLedger
    });
  }

  function currentMaterial(profileId, job) {
    const allEvidence = listCandidateEvidence(db, { profileId });
    const factRevisions = listCandidateFactRevisions(db, { profileId, limit: 2000 });
    const now = new Date().toISOString();
    const facts = mergeCandidateFacts(listCandidateFacts(db, profileId, { job }), allEvidence, { job, factRevisions })
      .filter(fact => factStatus(now, { ...fact, key: fact.factKey || fact.key }).status === 'valid');
    const materialPolicy = { now, facts, factRevisions };
    return { facts, evidence: currentCandidateMaterial(allEvidence, materialPolicy), materialPolicy };
  }
  function integrityJobs(ids) {
    return Array.isArray(ids) ? listJobIdentities(db, ids) : [];
  }

  function ownedPlan(profileId, planId) {
    const plan = getSearchPlan(db, requiredId(planId, "planId"));
    if (!plan || plan.profileId !== profileId) {
      throw serviceError("RESUME_OPTIMIZATION_PLAN_NOT_OWNED", "搜索计划不存在或不属于当前候选人");
    }
    return plan;
  }

  function ownedSource(profileId, versionId) {
    const id = requiredId(versionId, "sourceResumeVersionId");
    const row = getCandidateResumeDocument(db, { profileId, resumeVersionId: id });
    if (!row) throw serviceError("RESUME_OPTIMIZATION_SOURCE_NOT_OWNED", "源简历不存在或不属于当前候选人");
    return {
      id: Number(row.id),
      documentId: row.documentId,
      name: row.name,
      fileName: row.fileName,
      contentHash: row.contentHash,
      text: row.text
    };
  }

  function ownedDirection(plan, value) {
    const direction = String(value || "").trim();
    const directions = Array.isArray(plan.plan?.directions)
      ? plan.plan.directions.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    if (!direction || !directions.includes(direction)) {
      throw serviceError("RESUME_OPTIMIZATION_DIRECTION_NOT_OWNED", "目标投递方向不属于当前搜索计划");
    }
    return direction;
  }

  function rowsForJobIds(ids) {
    const rows = new Map(listJobSummaries(db, ids).map((row) => [row.id, row]));
    return ids.map((id) => rows.get(Number(id))).filter(Boolean);
  }
}

function isCompleteJob(job) {
  const description = String(job?.description || "").trim();
  return description.length >= 20 && job?.analysis?.semanticStatus === "complete";
}

function modelJob(job) {
  return {
    id: Number(job.id),
    title: String(job.title || ""),
    company: String(job.company || ""),
    description: String(job.description || ""),
    analysis: job.analysis || {}
  };
}

function applicableAnswers(answers, jobs) {
  const jobIds = new Set(jobs.flatMap((job) => [job.id, job.sourceId].map((value) => String(value || "")).filter(Boolean)));
  const companies = new Set(jobs.map((job) => String(job.company || "").trim()).filter(Boolean));
  return answers.filter((answer) => {
    const scope = answer.scope || { kind: "global", key: "" };
    if (["global", "experience"].includes(scope.kind)) return true;
    if (scope.kind === "job") return jobIds.has(String(scope.key || ""));
    if (scope.kind === "company") return companies.has(String(scope.key || "").trim());
    return false;
  });
}

function publicIssues(items) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => String(item?.code || ""))
    .filter((code) => /^RESUME_[A-Z0-9_]+$/.test(code)))]
    .slice(0, 8)
    .map((code) => ({ code }));
}

function compactDiagnosis(value) {
  if (!value) return null;
  return {
    analysisSource: value.analysisSource || "",
    platforms: (value.platforms || []).map(item => ({ site: item.site, strength: item.currentRound.strength,
      headline: item.currentRound.headline, priorityCheck: item.currentRound.priorityCheck })),
    strength: value.currentRound?.strength || value.currentPool?.strength || "facts",
    headline: value.headline || "",
    priorityCheck: value.priorityCheck || ""
  };
}

function requiredId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError(`${label} must be a positive integer`);
  return id;
}

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createResumeOptimizationService };
