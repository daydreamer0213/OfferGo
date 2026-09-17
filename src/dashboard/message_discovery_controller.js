const { randomUUID } = require("node:crypto");
const { createBossMessageReader } = require("../adapters/sites/boss_message_reader");
const { createZhaopinMessageReader, isZhaopinMessageUrl } = require("../adapters/sites/zhaopin_message_reader");
const { createZhaopinMessageJobContextResolver } = require("../application/message_discovery/zhaopin_job_context");
const { findMessageDiscoveryJobContext } = require("../core/candidate_progress");
const { createBossMessageDetailReader } = require("../adapters/sites/boss_message_detail_reader");
const { createZhaopinMessageDetailReader } = require("../adapters/sites/zhaopin_message_detail_reader");
const { BossSiteAdapter } = require("../adapters/sites/boss");
const { createMessageDiscoveryJobContextResolver } = require("../application/message_discovery/job_context");
const { runBossMessageDiscovery, projectMessageDecisionCard } = require("../application/message_discovery/run");
const { createMessageReplyAnalyzer } = require("../core/message_reply_analyzer");
const {
  listUnresolvedMessageDiscoveryItems
} = require("../core/message_preview_state");
const { createSiteAccessController } = require("../core/site_access_budget");
const { communicationRuntimeBlock, scanRuntimeBlock } = require("../core/communication_runtime");
const { resolveBossRiskWindow } = require("../core/boss_risk_window");
const {
  getSitePacingState,
  setSitePacingState,
  setSiteRuntimeState,
  recordSiteAccessEvent,
  listOpenMessageReplyDrafts,
  listMessageInboundContexts,
  deleteMessageInboundContext,
  getActiveSearchPlan,
  closeMessageReplyDrafts
} = require("../core/storage");
const { listMessageInboxItems, getMessageInboxSyncState } = require("../application/message_inbox");
const { getCandidateProfile } = require("../application/candidate_queries");
const {
  getPersistedCardJobIdentity,
  getLatestInboundContextIdentity,
  getDurableMessageDraftContext,
  messageReplyDraftExists,
  messageReplyDraftGroupExists,
  hasBlockingReplySendItemForCard
} = require("../application/message_discovery/queries");

const DEFAULT_CLEANUP_MS = 30 * 60 * 1000;
const ALLOWED_RUN_STATUSES = new Set(["running", "completed", "needs_user_action", "stopped"]);
const MESSAGE_INTENTS = new Set([
  "interview_invitation",
  "interest_check",
  "information_request",
  "information_update",
  "general_communication",
  "manual_review"
]);

function createMessageDiscoveryController(deps = {}) {
  const {
    db,
    root = process.cwd(),
    logger = null,
    getModelConfig = () => ({ provider: "mock", providers: { mock: {} } }),
    modelReady = () => true,
    assertRuntimeAvailable = (input) => assertMessageDiscoveryRuntimeAvailable(db, now, input),
    recordRiskControl = (input) => persistMessageDiscoveryRiskControl(db, input),
    acquireLease,
    renewLease,
    releaseLease,
    browserFactory = null,
    createBrowser = browserFactory,
    cleanupBrowser = async (browser) => {
      if (browser && typeof browser.disconnect === "function") await browser.disconnect();
      else if (browser && typeof browser.cleanup === "function") await browser.cleanup();
    },
    createReader = ({ browser, platform, tabId }) => platform === "zhaopin"
      ? createZhaopinMessageReader({ browser, expectedTabId: tabId })
      : createBossMessageReader({ browser, expectedCommunicationTabId: tabId }),
    createDetailSafety = (options) => createMessageDiscoveryDetailSafety(options),
    createDetailReader = (options) => options.platform === "zhaopin"
      ? createZhaopinMessageDetailReader(options) : createBossMessageDetailReader(options),
    createJobContextResolver = (options) => options.platform === "zhaopin"
      ? createZhaopinMessageJobContextResolver(options) : createMessageDiscoveryJobContextResolver(options),
    createAnalyzer = ({ modelConfig, logger: analyzerLogger }) => createMessageReplyAnalyzer({
      adapter: createMessageModelAdapter(modelConfig, analyzerLogger)
    }),
    runDiscovery = runBossMessageDiscovery,
    pacingSleepFn,
    pacingRandomFn = Math.random,
    detailSleepFn,
    getEnabledPlatforms = () => ["boss", "zhaopin"],
    now = () => new Date(),
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval
  } = deps;
  const runs = new Map();
  let closePromise = null;

  return {
    start,
    stop,
    dismiss,
    status,
    pageState,
    clearDraftForCard,
    close
  };

  function start(profileIdValue) {
    const profileId = messageDiscoveryProfileId(profileIdValue);
    if (!db) throw messageDiscoveryError("MESSAGE_DISCOVERY_CONTEXT_INVALID", "message discovery controller requires db", 500);
    const profile = getCandidateProfile(db, profileId);
    if (!profile) throw messageDiscoveryError("MESSAGE_DISCOVERY_PROFILE_NOT_FOUND", "candidate profile was not found", 404);
    const previousRun = runs.get(profileId);
    if (previousRun?.status === "running") {
      throw messageDiscoveryError("MESSAGE_DISCOVERY_ALREADY_RUNNING", "message discovery is already running", 409);
    }
    if (!modelReady()) {
      throw messageDiscoveryError(
        "MESSAGE_DISCOVERY_MODEL_NOT_READY",
        "message discovery requires a verified deep analysis model",
        409
      );
    }
    const modelConfig = getModelConfig();
    const enabledPlatforms = normalizeEnabledPlatforms(getEnabledPlatforms());
    if (!enabledPlatforms.length) {
      throw messageDiscoveryError("WORKSPACE_PLATFORM_SELECTION_REQUIRED", "请先选择要读取消息的招聘平台。", 409);
    }
    const owner = randomUUID();
    const leaseSite = enabledPlatforms[0];
    try {
      acquireLease(db, { site: leaseSite, owner, command: "discover-messages", planId: null });
    } catch (error) {
      if (error?.code === "SCAN_ALREADY_RUNNING"
        || /constraint|locked|lease/i.test(String(error?.message || ""))) {
        throw messageDiscoveryError("MESSAGE_DISCOVERY_LEASE_BUSY", "招聘平台正在执行其他任务", 409);
      }
      throw error;
    }
    if (previousRun) {
      clearRunTimer(previousRun);
      previousRun.results = [];
      previousRun.closed = true;
    }
    const startedAt = nowDate();
    const abortController = new AbortController();
    const run = {
      profileId,
      status: "running",
      queued: 0,
      processed: 0,
      unresolved: 0,
      counters: emptyCounters(),
      reasonCode: "",
      results: [],
      platformRuns: [],
      phase: "starting",
      waitUntil: "",
      startedAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
      expiresAt: "",
      abortController,
      cleanupTimer: null,
      clearedCardIds: new Set(),
      closed: false,
      riskRecorded: new Set(),
      completion: null
    };
    runs.set(profileId, run);
    const heartbeatMs = Math.max(1, Number(deps.leaseHeartbeatMs) || 30_000);
    const heartbeat = setIntervalFn(() => {
      try {
        renewLease(db, { site: leaseSite, owner });
      } catch {
        abortController.abort(messageDiscoveryError("MESSAGE_DISCOVERY_LEASE_LOST", "招聘平台任务占用状态已丢失"));
      }
    }, heartbeatMs);

    let browser = null;
    run.completion = Promise.resolve().then(async () => {
      if (typeof createBrowser !== "function") {
        throw messageDiscoveryError(
          "MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE",
          "message discovery requires the dashboard browser authority",
          503
        );
      }
      browser = await createBrowser();
      if (abortController.signal.aborted) throw abortController.signal.reason;
      const tabs = await browser.listTabs();
      const workspaceWindowIds = new Set(tabs.filter(isDashboardMessageWorkspaceTab).map((tab) => tab.windowId));
      run.platformRuns = enabledPlatforms.map((platform) => {
        const matches = tabs.filter((tab) => {
          try {
            const url = new URL(tab.url);
            return platform === "boss"
              ? url.hostname === "www.zhipin.com" && url.pathname === "/web/geek/chat"
              : isZhaopinMessageUrl(tab.url);
          } catch { return false; }
        });
        const inWorkspace = matches.filter((tab) => workspaceWindowIds.has(tab.windowId));
        const selected = stableMessageTab(inWorkspace.length ? inWorkspace : matches);
        const riskControl = platform === "boss" && tabs.some((tab) => isBossRiskControlUrl(tab?.url));
        return { platform, status: selected ? "pending" : riskControl ? "needs_user_action" : "not_connected",
          reasonCode: selected ? "" : riskControl ? "BOSS_RISK_CONTROL" : "",
          bindingTabId: selected?.id ?? null, counters: safeCounters(null, platform) };
      });
      for (const entry of run.platformRuns) {
        if (entry.reasonCode === "BOSS_RISK_CONTROL") {
          recordRiskOnce(run, entry.platform, entry.reasonCode, "BOSS requires security verification");
        }
      }
      for (const entry of run.platformRuns) {
        if (abortController.signal.aborted) break;
        if (entry.status !== "pending") continue;
        const platform = entry.platform;
        const earlier = { queued: run.queued, processed: run.processed, unresolved: run.unresolved, counters: run.counters, results: run.results };
        const checkpoint = (summary = {}) => {
          entry.status = ALLOWED_RUN_STATUSES.has(summary.status) ? summary.status : "running";
          entry.reasonCode = safeCode(summary.reasonCode);
          entry.counters = safeCounters(summary.counters, entry.platform);
          const counters = { ...earlier.counters };
          for (const key of ["visible", "newReplies", "unbound"]) counters[key] += entry.counters[key];
          if (platform === "boss") {
            counters.currentRead = entry.counters.currentRead;
            counters.currentDelivered = entry.counters.currentDelivered;
          }
          const results = new Map(earlier.results.map(item => [item.cardId, item]));
          for (const item of sanitizeResults(summary.results || [])) results.set(item.cardId, item);
          updateRun(run, { ...summary, status: "running", queued: earlier.queued + (Number(summary.queued) || 0), processed: earlier.processed + (Number(summary.processed) || 0), unresolved: earlier.unresolved + (Number(summary.unresolved) || 0), counters, results: [...results.values()] });
        };
        let readingStarted = false;
        try {
          entry.status = "running";
          if (platform === "boss") assertRuntimeAvailable({ profileId, platform });
          else assertMessageDiscoveryRuntimeAvailable(db, now, { platform });
          readingStarted = true;
          setDetailPhase(run, "reading_messages", now);
          const reader = createReader({ browser, platform, tabId: entry.bindingTabId });
          const safety = createDetailSafety({ db, profileId, owner, run, logger, signal: abortController.signal, now, sleepFn: pacingSleepFn, randomFn: pacingRandomFn, platform });
          const detailOptions = { browser, messageReader: reader, logger, beforeOpen: safety.beforeOpen, afterIssuedAttempt: safety.afterIssuedAttempt, sleepFn: detailSleepFn, platform };
          let actualDetailReader = platform === "boss" || Object.hasOwn(deps, "createDetailReader")
            ? createDetailReader(detailOptions)
            : null;
          const detailReader = actualDetailReader || {
            readSelectedJobDetail(input) {
              actualDetailReader ||= createDetailReader(detailOptions);
              return actualDetailReader.readSelectedJobDetail(input);
            }
          };
          const resolverOptions = { platform, db, profileId, modelConfig, root, logger };
          if (platform !== "zhaopin" || typeof reader.readSelectedJobTarget === "function") {
            resolverOptions.messageReader = reader;
            resolverOptions.detailReader = detailReader;
          }
          const resolveJobContext = createJobContextResolver(resolverOptions);
          const summary = await runDiscovery({ platform, db, profileId, reader, signal: abortController.signal, logger,
            classifyMessageGroup: createAnalyzer({ modelConfig, logger }), resolveJobContext, onStatus: checkpoint });
          checkpoint(summary);
          if (isPlatformRiskControl(platform, summary?.reasonCode)) {
            recordRiskOnce(run, platform, summary.reasonCode, `${platform} requires security verification`);
          }
        } catch (error) {
          entry.reasonCode = messageDiscoveryErrorCode(error);
          entry.status = /RISK_CONTROL|RUNTIME_BLOCKED|LOGIN_REQUIRED|PAGE_LOST|TAB_|BINDING/.test(entry.reasonCode) ? "needs_user_action" : "stopped";
          if (readingStarted && isPlatformRiskControl(platform, entry.reasonCode)) {
            recordRiskOnce(run, platform, entry.reasonCode, error.message);
          }
        }
      }
      for (const entry of run.platformRuns) if (entry.status === "pending") entry.status = "stopped";
      const issue = run.platformRuns.find(entry => entry.status === "needs_user_action" || entry.status === "stopped");
      const stopped = abortController.signal.aborted || run.platformRuns.some(entry => entry.status === "stopped");
      updateRun(run, { ...run, status: stopped ? "stopped" : issue || !run.platformRuns.some(entry => entry.status === "completed") ? "needs_user_action" : "completed",
        reasonCode: abortController.signal.aborted ? messageDiscoveryErrorCode(abortController.signal.reason) : issue?.reasonCode || "" });
    }).catch((error) => {
      const code = messageDiscoveryErrorCode(error);
      if (code === "BOSS_RISK_CONTROL") recordRiskOnce(run, "boss", code, error?.message);
      if (runs.get(profileId) !== run) return;
      updateRun(run, {
        status: ["MESSAGE_DISCOVERY_LEASE_LOST", "BOSS_RISK_CONTROL"].includes(code)
          ? "needs_user_action"
          : "stopped",
        queued: run.queued,
        processed: run.processed,
        unresolved: run.unresolved,
        counters: run.counters,
        reasonCode: code,
        results: run.results
      });
      logger?.warn("message_discovery_stopped", {
        profileId,
        queued: run.queued,
        processed: run.processed,
        status: run.status,
        reasonCode: code
      });
    }).finally(async () => {
      clearIntervalFn(heartbeat);
      try {
        await cleanupBrowser(browser);
      } catch (error) {
        logger?.warn("message_discovery_browser_cleanup_failed", {
          profileId,
          code: messageDiscoveryErrorCode(error)
        });
      }
      try {
        releaseLease(db, { site: leaseSite, owner });
      } catch (error) {
        logger?.warn("message_discovery_lease_release_failed", {
          profileId,
          site: leaseSite,
          code: messageDiscoveryErrorCode(error)
        });
      }
    });
    return { statusCode: 202, body: publicRun(run) };
  }

  function stop(profileIdValue) {
    const profileId = messageDiscoveryProfileId(profileIdValue);
    clearExpiredRun(profileId);
    const run = runs.get(profileId);
    if (!run) throw messageDiscoveryError("MESSAGE_DISCOVERY_NOT_FOUND", "message discovery run was not found", 404);
    if (run.status !== "running") {
      throw messageDiscoveryError("MESSAGE_DISCOVERY_NOT_RUNNING", "message discovery is not running", 409);
    }
    run.abortController.abort(messageDiscoveryError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped"));
    return { statusCode: 202, body: publicRun(run) };
  }

  function dismiss(profileIdValue) {
    const profileId = messageDiscoveryProfileId(profileIdValue);
    clearExpiredRun(profileId);
    const run = runs.get(profileId);
    if (!run) {
      const results = durableStatus(profileId).results;
      if (!results.length) throw messageDiscoveryError("MESSAGE_DISCOVERY_NOT_FOUND", "message discovery run was not found", 404);
      clearProcessedCards(profileId, results.map(result => result.cardId));
      return { statusCode: 200, body: { ...emptyStatus(profileId), status: "dismissed" } };
    }
    if (run.status === "running") {
      throw messageDiscoveryError("MESSAGE_DISCOVERY_RUNNING", "stop message discovery before dismissing drafts", 409);
    }
    clearProcessedCards(profileId, run.results.map(item => item.cardId));
    clearRunTimer(run);
    run.results = [];
    run.status = run.unresolved > 0 ? "needs_user_action" : "dismissed";
    if (run.unresolved === 0) run.reasonCode = "";
    run.expiresAt = "";
    run.updatedAt = nowDate().toISOString();
    run.closed = true;
    return { statusCode: 200, body: publicRun(run) };
  }

  function status(profileIdValue) {
    const profileId = messageDiscoveryProfileId(profileIdValue);
    clearExpiredRun(profileId);
    const run = runs.get(profileId);
    return run ? publicRun(run) : publicDurableStatus(profileId);
  }

  function pageState(profileIdValue) {
    const profileId = messageDiscoveryProfileId(profileIdValue);
    clearExpiredRun(profileId);
    const run = runs.get(profileId);
    const state = run ? pageRun(run) : durableStatus(profileId);
    return {
      ...state,
      inbox: buildMessageInboxPageState(db, {
        profileId,
        platformRuns: state.platformRuns || [],
        now: nowDate()
      })
    };
  }

  function clearDraftForCard(profileIdValue, cardIdValue) {
    const profileId = Number(profileIdValue);
    const cardId = Number(cardIdValue);
    if (Number.isSafeInteger(profileId) && profileId > 0 && Number.isSafeInteger(cardId) && cardId > 0) {
      clearProcessedCards(profileId, [cardId]);
    }
    const run = runs.get(profileId);
    if (!run) return;
    const result = run.results.find((item) => Number(item.cardId) === cardId);
    if (!result) return;
    run.clearedCardIds.add(cardId);
    run.results = run.results.filter(item => Number(item.cardId) !== cardId || !item.drafts?.length).map((item) => Number(item.cardId) === cardId
      ? { ...item, inboundMessages: [], drafts: [], messages: [] }
      : item);
  }

  function clearProcessedCards(profileId, cardIds) {
    const targets = [...new Set(cardIds.map(Number).filter(id => id > 0))];
    for (const cardId of targets) {
      if (hasBlockingReplySendItemForCard(db, { profileId, cardId })) {
        throw messageDiscoveryError("MESSAGE_REPLY_SEND_DRAFT_BUSY", "正在发送或结果待核对的草稿不能清除。", 409);
      }
    }
    for (const cardId of targets) {
      closeMessageReplyDrafts(db, { profileId, cardId, closedAt: nowDate().toISOString() });
      for (const context of listMessageInboundContexts(db, { profileId, cardId, limit: 500 })) {
        deleteMessageInboundContext(db, { profileId, cardId, messageGroupKey: context.messageGroupKey });
      }
    }
  }

  function close() {
    if (closePromise) return closePromise;
    const closingRuns = [...runs.values()];
    for (const run of closingRuns) {
      clearRunTimer(run);
      run.closed = true;
      if (run.status === "running") {
        run.abortController.abort(messageDiscoveryError("MESSAGE_DISCOVERY_STOPPED", "message discovery stopped"));
      }
      run.results = [];
    }
    closePromise = Promise.allSettled(
      closingRuns.map((run) => run.completion).filter((completion) => completion && typeof completion.then === "function")
    ).then(() => {
      runs.clear();
    });
    return closePromise;
  }

  function recordRiskOnce(run, platform, errorCode, message) {
    if (run.riskRecorded.has(platform)) return;
    recordRiskControl({
      platform,
      profileId: run.profileId,
      errorCode,
      message: String(message || ""),
      occurredAt: nowDate().toISOString()
    });
    run.riskRecorded.add(platform);
  }

  function updateRun(run, statusValue) {
    if (!run || run.closed || runs.get(run.profileId) !== run || !statusValue || typeof statusValue !== "object") return;
    const at = nowDate();
    run.status = ALLOWED_RUN_STATUSES.has(statusValue.status) ? statusValue.status : "needs_user_action";
    run.queued = Math.max(0, Number(statusValue.queued) || 0);
    run.processed = Math.max(0, Number(statusValue.processed) || 0);
    run.unresolved = Math.max(0, Number(statusValue.unresolved) || 0);
    if (statusValue.counters !== undefined) run.counters = safeCounters(statusValue.counters);
    run.reasonCode = safeCode(statusValue.reasonCode);
    if (statusValue.phase !== undefined) run.phase = safePhase(statusValue.phase) || run.phase;
    if (statusValue.waitUntil !== undefined) run.waitUntil = safeTimestamp(statusValue.waitUntil);
    run.results = sanitizeResults(Array.isArray(statusValue.results) ? statusValue.results : [])
      .map((item) => run.clearedCardIds.has(Number(item.cardId))
        ? { ...item, inboundMessages: [], drafts: [], messages: [] }
        : item);
    run.updatedAt = at.toISOString();
    if (run.status === "running") {
      run.expiresAt = "";
      return;
    }
    run.phase = run.status;
    run.waitUntil = "";
    run.closed = true;
    run.expiresAt = new Date(at.getTime() + DEFAULT_CLEANUP_MS).toISOString();
    scheduleCleanup(run);
  }

  function sanitizeResults(results) {
    if (!Array.isArray(results)) return [];
    return results.map((item) => {
      const persisted = getPersistedCardJobIdentity(db, {
        cardId: Number(item?.cardId) || 0,
        jobId: Number(item?.jobId) || 0
      });
      const context = getLatestInboundContextIdentity(db, Number(item?.cardId) || 0) || {};
      const platform = ["boss", "zhaopin"].includes(persisted?.source) ? persisted.source : "";
      const messages = Array.isArray(item?.messages)
        ? item.messages.slice(0, 2).map((message) => safeText(message, 4000)).filter(Boolean)
        : [];
      const drafts = Array.isArray(item?.drafts)
        ? item.drafts.slice(0, 2).map((draft) => ({
          id: Math.max(0, Number(draft?.id) || 0),
          text: safeText(draft?.text, 4000),
          revision: Math.max(0, Number(draft?.revision) || 0)
        })).filter((draft) => draft.id > 0 && draft.text)
        : [];
      return {
        cardId: Math.max(0, Number(item?.cardId) || 0),
        jobId: Math.max(0, Number(item?.jobId) || 0),
        platform,
        sourceJobId: safeText(persisted?.sourceId, 180),
        messageGroupKey: safeDigest(item?.messageGroupKey) || safeDigest(context.messageGroupKey),
        conversationKey: safeDigest(item?.conversationKey) || safeDigest(context.conversationKey),
        stage: String(item?.stage || "").slice(0, 80),
        messageIntent: MESSAGE_INTENTS.has(item?.messageIntent) ? item.messageIntent : "manual_review",
        messageCategory: String(item?.messageCategory || "").slice(0, 80),
        messageSummary: safeInlineText(item?.messageSummary, 160),
        missingFactKey: String(item?.missingFactKey || "").slice(0, 80),
        manualActionReason: safeText(item?.manualActionReason, 240),
        manualActions: sanitizeManualActions(item?.manualActions, platform),
        contextSource: ["local_cache", "message_discovery_detail"].includes(item?.contextSource)
          ? item.contextSource
          : "",
        contextComplete: item?.contextComplete === true,
        job: sanitizeJobUnderstanding(item?.job),
        inboundMessages: sanitizeInboundMessages(item?.inboundMessages),
        draftQualityWarnings: sanitizeDraftQualityWarnings(item?.draftQualityWarnings),
        drafts,
        messages
      };
    });
  }

  function sanitizeDraftQualityWarnings(value) {
    return Array.isArray(value) && value.includes("MESSAGE_DRAFT_RECENTLY_SIMILAR")
      ? ["MESSAGE_DRAFT_RECENTLY_SIMILAR"]
      : [];
  }

  function sanitizeManualActions(value, platform = "boss") {
    return Array.isArray(value) && value.some((item) => item?.kind === "resume_request")
      ? [{
        kind: "resume_request",
        title: `需要在${platform === "zhaopin" ? "智联" : " BOSS "}人工处理附件简历请求`,
        instruction: platform === "zhaopin" ? "请自行到智联原始会话处理这条简历请求。" : "请在 BOSS 消息卡片中人工选择“同意”或“拒绝”。"
      }]
      : [];
  }

  function sanitizeInboundMessages(value) {
    const result = [];
    for (const item of Array.isArray(value) ? value : []) {
      const kind = String(item?.kind || "");
      const text = safeText(item?.text, 4000).replace(/\r\n?/g, "\n").trim();
      if (kind === "text" && text) result.push({ kind, text });
      else if (kind === "resume_request" && text === "HR 邀请你发送简历") result.push({ kind, text });
      if (result.length >= 5) break;
    }
    return result;
  }

  function publicRun(run) {
    return {
      profileId: run.profileId,
      status: run.status,
      queued: run.queued,
      processed: run.processed,
      unresolved: run.unresolved,
      counters: safeCounters(run.counters),
      platformRuns: visiblePlatformRuns(run),
      reasonCode: run.reasonCode,
      results: sanitizeResults(run.results).map((item) => ({
        cardId: item.cardId,
        jobId: item.jobId,
        platform: item.platform,
        sourceJobId: item.sourceJobId,
        stage: item.stage,
        messageCategory: item.messageCategory,
        missingFactKey: item.missingFactKey
      })),
      phase: safePhase(run.phase),
      waitUntil: safeTimestamp(run.waitUntil),
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      expiresAt: run.expiresAt
    };
  }

  function pageRun(run) {
    const results = sanitizeResults(run.results);
    return {
      profileId: run.profileId,
      status: run.status,
      queued: run.queued,
      processed: run.processed,
      unresolved: run.unresolved,
      counters: safeCounters(run.counters),
      platformRuns: visiblePlatformRuns(run),
      reasonCode: run.reasonCode,
      results: run.status === "running" ? results : overlayOpenDrafts(run.profileId, results),
      phase: safePhase(run.phase),
      waitUntil: safeTimestamp(run.waitUntil),
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      expiresAt: run.expiresAt
    };
  }

  function visiblePlatformRuns(run) {
    return (run.platformRuns || []).map(entry => {
      const { bindingTabId: _privateBinding, ...visible } = entry;
      return ({ ...visible,
      status: entry.status === "pending" ? "running" : entry.status,
      reasonCode: entry.status === "pending" ? "MESSAGE_DISCOVERY_WAITING_TURN" : entry.reasonCode
      });
    });
  }

  function overlayOpenDrafts(profileId, results) {
    const byCard = new Map();
    for (const draft of listOpenMessageReplyDrafts(db, { profileId, limit: 500 })) {
      if (draft.messageIntent === "follow_up") continue;
      const values = byCard.get(draft.cardId) || [];
      values.push(draft);
      byCard.set(draft.cardId, values);
    }
    return results.map((result) => {
      if (!result.drafts.length) return result;
      const openDrafts = byCard.get(result.cardId) || [];
      if (!openDrafts.length && !result.drafts.some((draft) => messageReplyDraftExists(db, { draftId: draft.id, profileId }))) return result;
      if (!openDrafts.length) return null;
      const drafts = openDrafts
        .sort((left, right) => left.draftIndex - right.draftIndex)
        .slice(0, 2)
        .map((draft) => ({ id: draft.id, text: draft.currentText, revision: draft.revision }));
      return { ...result, drafts, messages: drafts.map((draft) => draft.text) };
    }).filter(Boolean);
  }

  function emptyStatus(profileId) {
    return {
      profileId,
      status: "idle",
      queued: 0,
      processed: 0,
      unresolved: 0,
      counters: emptyCounters(),
      reasonCode: "",
      results: [],
      phase: "idle",
      waitUntil: "",
      startedAt: "",
      updatedAt: "",
      expiresAt: ""
    };
  }

  function emptyCounters() {
    return { visible: 0, newReplies: 0, currentRead: 0, currentDelivered: 0, unbound: 0 };
  }

  function safeCounters(value, platform = "boss") {
    const input = value && typeof value === "object" ? value : {};
    return Object.fromEntries(Object.keys(emptyCounters()).map((key) => [
      key,
      platform === "zhaopin" && ["currentRead", "currentDelivered"].includes(key)
        ? null : Math.max(0, Number(input[key]) || 0)
    ]));
  }

  function durableStatus(profileId) {
    const drafts = listOpenMessageReplyDrafts(db, { profileId, limit: 500 })
      .filter((draft) => draft.messageIntent !== "follow_up");
    const inboundContexts = listMessageInboundContexts(db, { profileId, limit: 500 }).filter(context =>
      drafts.some(draft => draft.cardId === context.cardId && draft.messageGroupKey === context.messageGroupKey)
      || !messageReplyDraftGroupExists(db, { profileId, cardId: context.cardId, messageGroupKey: context.messageGroupKey }));
    const unresolved = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: null });
    if (!drafts.length && !inboundContexts.length && unresolved.length === 0) return emptyStatus(profileId);
    const byCard = new Map();
    for (const draft of drafts) {
      const values = byCard.get(draft.cardId) || [];
      values.push(draft);
      byCard.set(draft.cardId, values);
    }
    const contextsByCard = new Map();
    for (const context of inboundContexts) {
      if (!byCard.has(context.cardId)) byCard.set(context.cardId, []);
      const values = contextsByCard.get(context.cardId) || [];
      values.push(context);
      contextsByCard.set(context.cardId, values);
    }
    const results = [...byCard.entries()].map(([cardId, cardDrafts]) => durableDraftResult(
      profileId,
      cardId,
      cardDrafts,
      contextsByCard.get(cardId) || []
    ));
    return {
      ...emptyStatus(profileId),
      status: unresolved.length ? "needs_user_action" : "completed",
      unresolved: unresolved.length,
      reasonCode: safeCode(unresolved[0]?.reasonCode),
      processed: results.length,
      results
    };
  }

  function publicDurableStatus(profileId) {
    const value = durableStatus(profileId);
    return {
      ...value,
      results: sanitizeResults(value.results).map((item) => ({
        cardId: item.cardId,
        jobId: item.jobId,
        platform: item.platform,
        sourceJobId: item.sourceJobId,
        stage: item.stage,
        messageCategory: item.messageCategory,
        missingFactKey: item.missingFactKey
      }))
    };
  }

  function durableDraftResult(profileId, cardId, drafts, contexts = []) {
    const row = getDurableMessageDraftContext(db, { profileId, cardId });
    if (!row) throw messageDiscoveryError("MESSAGE_DISCOVERY_CONTEXT_INVALID", "durable draft context is missing", 500);
    const platform = row.source === row.card_source && ["boss", "zhaopin"].includes(row.source) ? row.source : "";
    const first = drafts[0] || contexts[0] || {};
    const openGroupKeys = new Set(drafts.map((draft) => draft.messageGroupKey));
    const activeContexts = contexts.filter((context) => openGroupKeys.has(context.messageGroupKey)
      || !messageReplyDraftGroupExists(db, { profileId, cardId, messageGroupKey: context.messageGroupKey }));
    const inboundMessages = sanitizeInboundMessages(activeContexts.flatMap((context) => context.inboundMessages));
    const safeDrafts = drafts.sort((left, right) => left.draftIndex - right.draftIndex).slice(0, 2).map((draft) => ({
      id: draft.id,
      text: draft.currentText,
      revision: draft.revision
    }));
    const activePlan = getActiveSearchPlan(db, profileId);
    const contextPlanId = row.source === "zhaopin" ? activePlan?.id : row.plan_id;
    const trusted = platform && contextPlanId ? findMessageDiscoveryJobContext(db, { profileId, planId: contextPlanId, sourceId: row.source_id, platform }) : null;
    const job = projectMessageDecisionCard(trusted || (row.source === "zhaopin" ? { title: row.title, company: row.company, salary: row.salary } : {
      title: row.title,
      company: row.company,
      salary: row.salary,
      description: row.description,
      qualityTags: parseArray(row.quality_tags_json),
      risks: parseArray(row.risks_json),
      analysis: parseObject(row.analysis_json)
    }));
    return {
      cardId: Number(row.card_id),
      jobId: Number(row.job_id),
      platform,
      sourceJobId: row.source_id,
      messageGroupKey: safeDigest(first.messageGroupKey) || safeDigest(activeContexts[0]?.messageGroupKey),
      conversationKey: safeDigest(first.conversationKey) || safeDigest(activeContexts[0]?.conversationKey),
      stage: String(row.stage || "reply_ready"),
      messageIntent: MESSAGE_INTENTS.has(first.messageIntent) ? first.messageIntent : "manual_review",
      messageCategory: String(first.messageCategory || "other"),
      messageSummary: safeInlineText(first.questionSummary, 160),
      missingFactKey: "",
      manualActionReason: "",
      manualActions: sanitizeManualActions(activeContexts.flatMap((context) => context.manualActions), row.source),
      contextSource: "local_cache",
      contextComplete: row.source === "zhaopin" ? trusted?.contextComplete === true : Boolean(row.description),
      job,
      inboundMessages,
      drafts: safeDrafts,
      messages: safeDrafts.map((draft) => draft.text)
    };
  }

  function clearExpiredRun(profileId) {
    const run = runs.get(profileId);
    if (!run || run.status === "running" || !run.expiresAt) return;
    if (Date.parse(run.expiresAt) <= nowDate().getTime()) {
      clearRunTimer(run);
      run.results = [];
      run.closed = true;
      runs.delete(profileId);
    }
  }

  function scheduleCleanup(run) {
    clearRunTimer(run);
    const expiresAt = Date.parse(run.expiresAt);
    const delay = Number.isFinite(expiresAt)
      ? Math.max(0, expiresAt - nowDate().getTime())
      : DEFAULT_CLEANUP_MS;
    const timer = setTimeoutFn(() => {
      if (runs.get(run.profileId) !== run || run.cleanupTimer !== timer) return;
      run.cleanupTimer = null;
      run.results = [];
      run.closed = true;
      runs.delete(run.profileId);
    }, delay);
    run.cleanupTimer = timer;
  }

  function clearRunTimer(run) {
    if (!run || run.cleanupTimer === null || run.cleanupTimer === undefined) return;
    clearTimeoutFn(run.cleanupTimer);
    run.cleanupTimer = null;
  }

  function nowDate() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }
}

function createMessageDiscoveryDetailSafety({
  db,
  profileId,
  owner = "",
  run = null,
  logger = null,
  signal = null,
  now = () => new Date(),
  sleepFn,
  randomFn = Math.random,
  createAccessController = createSiteAccessController,
  createPacingAdapter = (options) => new BossSiteAdapter(options),
  platform = "boss"
} = {}) {
  const site = ["boss", "zhaopin"].includes(platform) ? platform : "boss";
  let assertActiveBindings = null;
  const onWait = ({ durationMs }) => setDetailWait(run, durationMs, now);
  const checkpointPacing = async (state) => setSitePacingState(db, {
    site,
    pacing: state,
    updatedAt: safeNow(now).toISOString()
  });
  const accessController = createAccessController({
    db,
    auditDb: db,
    site,
    runId: owner,
    logger,
    signal,
    sleepFn,
    randomFn,
    onWait,
    assertActive: async () => {
      if (typeof assertActiveBindings === "function") await assertActiveBindings();
    }
  });
  const pacing = createPacingAdapter({ logger, sleepFn, randomFn, accessController });
  pacing.restorePacing(getSitePacingState(db, site).pacing);

  return {
    pacing,
    async beforeOpen({ jobId, signal: operationSignal = signal, assertTabBindings } = {}) {
      assertActiveBindings = assertTabBindings;
      setDetailPhase(run, "reading_detail", now);
      try {
        await pacing.waitForPendingDetailCooldown({
          signal: operationSignal,
          assertTabBindings,
          onWait,
          onPacingCheckpoint: checkpointPacing
        });
        await pacing.waitWithPacing("pane_detail_read", {
          signal: operationSignal,
          assertTabBindings,
          onWait
        });
        await pacing.reserveAccess("pane_detail_read", { jobId });
        await pacing.reserveAccess("detail_open", { jobId });
      } finally {
        assertActiveBindings = null;
        setDetailPhase(run, "reading_detail", now);
      }
    },
    async afterIssuedAttempt({ signal: operationSignal = signal, assertTabBindings } = {}) {
      try {
        await pacing.waitAfterDetailAction({
          signal: operationSignal,
          assertTabBindings,
          onWait,
          onPacingCheckpoint: checkpointPacing
        });
      } finally {
        if (!operationSignal?.aborted) setDetailPhase(run, "reading_detail", now);
      }
    }
  };
}

function setDetailWait(run, durationMs, now) {
  if (!run) return;
  const current = safeNow(now);
  const delay = Math.max(0, Math.floor(Number(durationMs) || 0));
  run.phase = "cooldown";
  run.waitUntil = new Date(current.getTime() + delay).toISOString();
  run.updatedAt = current.toISOString();
}

function setDetailPhase(run, phase, now) {
  if (!run) return;
  run.phase = phase;
  run.waitUntil = "";
  run.updatedAt = safeNow(now).toISOString();
}

function safeNow(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function messageDiscoveryProfileId(value) {
  const profileId = Number(value);
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    throw messageDiscoveryError("MESSAGE_DISCOVERY_PROFILE_INVALID", "profileId must be a positive integer", 400);
  }
  return profileId;
}

function sanitizeJobUnderstanding(value) {
  const job = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    title: safeInlineText(job.title, 160),
    company: safeInlineText(job.company, 160),
    roleSummary: safeInlineText(job.roleSummary, 300),
    companyBusiness: safeInlineText(job.companyBusiness, 300),
    fitLabel: safeInlineText(job.fitLabel, 20),
    fitSummary: safeInlineText(job.fitSummary, 180),
    workSchedule: safeInlineText(job.workSchedule, 180),
    salary: safeInlineText(job.salary, 80),
    opportunityVerdict: safeInlineText(job.opportunityVerdict, 80),
    opportunitySummary: safeInlineText(job.opportunitySummary, 180),
    availability: job.availability === "offline" ? "offline" : "unknown"
  };
}

function safeDigest(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^sha256:[a-f0-9]{64}$/.test(text) ? text : "";
}

function safeText(value, limit) {
  return ["string", "number"].includes(typeof value) ? String(value).slice(0, limit) : "";
}

function safeInlineText(value, limit) {
  return safeText(value, limit * 2).replace(/\s+/g, " ").trim().slice(0, limit);
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safePhase(value) {
  const phase = String(value || "");
  return new Set([
    "idle",
    "starting",
    "reading_messages",
    "reading_detail",
    "cooldown",
    "analyzing_job",
    "completed",
    "needs_user_action",
    "stopped",
    "dismissed"
  ]).has(phase) ? phase : "";
}

function safeTimestamp(value) {
  if (!value) return "";
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "";
}

function safeCode(value) {
  const code = String(value || "");
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : "";
}

function messageDiscoveryErrorCode(error) {
  return safeCode(error?.code) || "MESSAGE_DISCOVERY_FAILED";
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isPlatformRiskControl(platform, code) {
  return platform === "zhaopin"
    ? ["ZHAOPIN_RISK_CONTROL", "ZHAOPIN_MESSAGE_RISK_CONTROL"].includes(code)
    : code === "BOSS_RISK_CONTROL";
}

function messageDiscoveryError(code, message, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function buildMessageInboxPageState(db, { profileId, platformRuns = [], now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const runningByPlatform = new Map((platformRuns || []).map((item) => [item.platform, item]));
  const items = listMessageInboxItems(db, { profileId }).map((item) => presentInboxItem(item));
  const groups = {
    needsAction: items.filter((item) => item.actionGroup === "needs_action"),
    waiting: items.filter((item) => item.actionGroup === "waiting"),
    needsReview: items.filter((item) => item.actionGroup === "needs_review"),
    done: items.filter((item) => item.actionGroup === "done")
  };
  const freshness = Object.fromEntries(["boss", "zhaopin"].map((platform) => {
    const run = runningByPlatform.get(platform);
    const sync = getMessageInboxSyncState(db, { profileId, platform });
    return [platform, presentFreshness(platform, run, sync, current)];
  }));
  return {
    groups,
    freshness,
    counts: {
      needsAction: groups.needsAction.length,
      waiting: groups.waiting.length,
      needsReview: groups.needsReview.length,
      done: groups.done.length,
      total: items.length
    }
  };
}

function presentInboxItem(item) {
  const presentation = {
    needs_action: { statusText: "需要你处理", label: "查看建议回复" },
    waiting: { statusText: "已回复，等待对方消息", label: "查看会话" },
    needs_review: { statusText: "资料暂时无法确认，系统会在下次同步时重试", label: "查看原因" },
    done: { statusText: "已经处理", label: "查看记录" }
  }[item.actionGroup];
  return {
    ...item,
    statusText: presentation.statusText,
    primaryAction: { label: presentation.label }
  };
}

function presentFreshness(platform, run, sync, now) {
  const platformLabel = platform === "zhaopin" ? "智联" : "BOSS";
  if (run?.status === "running" || run?.status === "pending") {
    return { platform, label: "正在同步", detail: `${platformLabel} 正在读取最新消息`, state: "running" };
  }
  if (run?.status === "not_connected") {
    return { platform, label: "尚未连接", detail: `请保持 ${platformLabel} 消息页打开`, state: "needs_user_action" };
  }
  if (run?.reasonCode) {
    const state = /LOGIN_REQUIRED|RISK_CONTROL|TAB_|PAGE_LOST|BROWSER/.test(run.reasonCode) ? "needs_user_action" : "partial";
    return { platform, label: state === "partial" ? "部分同步" : "需要处理", detail: messageDiscoveryFreshnessText(run.reasonCode), state };
  }
  if (!sync) return { platform, label: "尚未同步", detail: `首次同步将衔接 ${platformLabel} 最近 3 天消息`, state: "idle" };
  if (!sync.coverageComplete) {
    return { platform, label: "部分同步", detail: "已保留当前结果，下次会从检查点继续", state: "partial" };
  }
  const successfulAt = Date.parse(String(sync.lastSuccessfulAt || ""));
  const minutes = Number.isFinite(successfulAt) && Number.isFinite(now.getTime())
    ? Math.max(0, Math.floor((now.getTime() - successfulAt) / 60000)) : null;
  const label = minutes === null ? "已同步" : minutes < 1 ? "刚刚同步" : minutes < 60 ? `${minutes} 分钟前同步` : "已同步";
  return { platform, label, detail: "最近 3 天范围已确认", state: "complete" };
}

function messageDiscoveryFreshnessText(code) {
  if (/LOGIN_REQUIRED/.test(code)) return "登录已失效，请登录后重试";
  if (/RISK_CONTROL/.test(code)) return "平台需要完成安全检查";
  if (/TAB_|PAGE_LOST/.test(code)) return "消息页已变化，请恢复后重试";
  if (/BROWSER/.test(code)) return "暂时无法连接浏览器";
  return "部分消息暂时无法完成，已保留待重试";
}

function assertMessageDiscoveryRuntimeAvailable(db, now, { platform = "boss" } = {}) {
  const nowValue = typeof now === "function" ? now() : new Date();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
  const site = platform === "zhaopin" ? "zhaopin" : "boss";
  const block = site === "boss"
    ? communicationRuntimeBlock(db, { nowMs })
    : scanRuntimeBlock(db, { nowMs, site });
  if (!block) return;
  throw messageDiscoveryError(
    block.reasonCode,
    `${site} access is paused by the central runtime safety guard`,
    409
  );
}

function persistMessageDiscoveryRiskControl(db, {
  platform = "boss",
  profileId,
  errorCode = "BOSS_RISK_CONTROL",
  message = "",
  occurredAt = new Date().toISOString()
} = {}) {
  const site = platform === "zhaopin" ? "zhaopin" : "boss";
  const riskWindow = resolveBossRiskWindow({ nowMs: Date.parse(occurredAt) });
  setSiteRuntimeState(db, site, {
    status: "blocked",
    reasonCode: errorCode,
    message,
    details: {
      phase: "message_discovery",
      profileId: Number(profileId) || null,
      blockedUntil: riskWindow.blockedUntil,
      recovery: true
    }
  });
  recordSiteAccessEvent(db, {
    site,
    action: "risk_control",
    runId: "",
    details: {
      profileId: Number(profileId) || null,
      errorCode,
      errorMessage: String(message || "").slice(0, 1000),
      blockedUntil: riskWindow.blockedUntil,
      recovery: true
    },
    createdAt: riskWindow.occurredAt
  });
}

function createMessageModelAdapter(modelConfig, logger) {
  const { createModelAdapter } = require("../adapters/models");
  return createModelAdapter(modelConfig || { provider: "mock", providers: { mock: {} } }, { logger });
}

function normalizeEnabledPlatforms(value) {
  const values = Array.isArray(value) ? value : [];
  const selected = new Set(values.map((item) => String(item || "").trim().toLowerCase()));
  return ["boss", "zhaopin"].filter((site) => selected.has(site));
}

function isDashboardMessageWorkspaceTab(tab) {
  try {
    return ["127.0.0.1", "localhost"].includes(new URL(String(tab?.url || "")).hostname);
  } catch {
    return false;
  }
}

function isBossRiskControlUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.origin === "https://www.zhipin.com" && url.searchParams.has("_security_check");
  } catch {
    return false;
  }
}

function stableMessageTab(tabs) {
  return [...(tabs || [])].sort((left, right) => `${typeof left.id}:${String(left.id)}`
    .localeCompare(`${typeof right.id}:${String(right.id)}`))[0] || null;
}

module.exports = {
  createMessageDiscoveryController,
  createMessageDiscoveryDetailSafety,
  buildMessageInboxPageState
};
