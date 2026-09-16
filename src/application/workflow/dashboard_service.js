"use strict";

const { loadConfigs } = require("../../config");
const {
  getCandidateProfile,
  getCandidateMatchingContext,
  getSearchPlan,
  getSearchPlanDependency,
  listMatchingResumeVersions
} = require("../../storage/candidate_store");
const { rescorePlanObservations } = require("../../storage/job_store");
const {
  createWorkflowRun,
  getWorkflowRun,
  getActiveWorkflowRun,
  transitionWorkflowRun,
  replaceWorkflowScanContext,
  workflowHasAnalysisTasks
} = require("../../storage/workflow_store");
const {
  getBatch,
  getScanRun,
  getLatestScanRun,
  interruptOrphanedScanRuns,
  getSiteScanLease
} = require("../../storage/scan_store");
const { appError, errorMeta } = require("../../core/observability");
const { assertSearchPlanReady } = require("../../core/plan_validation");
const { profileToRuntimeConfigs } = require("../../core/search_plan");
const { acquisitionModeOf } = require("../../core/search_plan_schema");
const {
  assertCompleteInheritedContext
} = require("../../core/inherited_search_scope");
const {
  freezeWorkflowPlan,
  assertAcquisitionContext,
  assertCompleteGeneratedContext,
  assertFrozenWorkflowPlan
} = require("../../core/workflow_acquisition");
const { validateResumeBatch } = require("../../core/scan_resume");
const {
  recoverWorkflowRuns
} = require("../../core/workflow_run");
const {
  requestWorkflowPause,
  resumeWorkflowRun,
  requestWorkflowStop,
  finalizeWorkflowControl
} = require("../../core/workflow_control");
const { getWorkflowProgressSnapshot } = require("../../core/workflow_progress");
const { communicationBatchSummary } = require("../../core/communication_batches");
const { assertBossRuntimeAvailable } = require("../../core/communication_runtime");
const { PRODUCT_POLICY } = require("../../core/product_policy");
const {
  startWorkflow,
  resumeWorkflow,
  controlWorkflow,
  getWorkflowStatus
} = require("./index");

const PORTABLE_CDP_PORT = 9222;

function createDashboardWorkflowService({
  db,
  root,
  dataRoot = root,
  dbPath,
  scanRuns,
  logger,
  spawnProcess,
  buildDashboardState,
  startScan,
  resolveNewWorkflowBrowser,
  acquisitionContextResolver,
  currentSearchContextResolver,
  browserReadinessProbe,
  publicBrowserReadinessSnapshot,
  ensureWorkspaceReady = async () => {},
  getBatchModelState,
  batchModelReady,
  getBatchBackup = () => null,
  planRescore = rescorePlanObservations,
  schedule = setTimeout,
  controlGraceMs = PRODUCT_POLICY.operations.modelAnalysis.taskLeaseTtlMs
} = {}) {
  if (!db) throw new TypeError("dashboard workflow service requires db");
  if (!(scanRuns instanceof Map)) throw new TypeError("dashboard workflow service requires scanRuns");
  if (typeof startScan !== "function") throw new TypeError("dashboard workflow service requires startScan");
  if (typeof resolveNewWorkflowBrowser !== "function") throw new TypeError("dashboard workflow service requires resolveNewWorkflowBrowser");
  if (typeof buildDashboardState !== "function") throw new TypeError("dashboard workflow service requires buildDashboardState");

  return { start, resume, control, status };

  async function start(params = {}, { requestId = "" } = {}) {
    const site = String(params.site || "boss").trim().toLowerCase();
    if (!new Set(["boss", "zhaopin"]).has(site)) {
      throw appError("UNKNOWN_SITE", "请选择 BOSS 或智联。", { statusCode: 400 });
    }
    await ensureWorkspaceReady(site);
    const modelState = getBatchModelState();
    const backupRuntime = modelState.settings?.batchBackup?.enabled
      ? getBatchBackup()
      : null;
    return startWorkflow({
      db,
      input: {
        ...params,
        site,
        root,
        dataRoot,
        dbPath,
        scanRuns,
        modelReady: batchModelReady(modelState),
        modelState,
        backupRuntime,
        requestId,
        spawnProcess
      },
      deps: startDependencies()
    });
  }

  async function resume(params = {}, { requestId = "" } = {}) {
    const workflowRunId = String(params.workflowRunId || params.runId || "").trim();
    const browserAuthority = resolveNewWorkflowBrowser(params);
    return resumeWorkflow({
      db,
      input: {
        ...params,
        ...browserAuthority,
        workflowRunId,
        root,
        dataRoot,
        dbPath,
        scanRuns,
        batchModelReady: batchModelReady(),
        requestId,
        spawnProcess
      },
      deps: resumeDependencies()
    });
  }

  async function control(params = {}, { requestId = "" } = {}) {
    const browserAuthority = resolveNewWorkflowBrowser(params);
    const workflowRunId = String(params.workflowRunId || params.runId || "").trim();
    const action = String(params.action || "").trim().toLowerCase();
    return controlWorkflow({
      db,
      input: {
        ...params,
        ...browserAuthority,
        workflowRunId,
        action,
        root,
        dataRoot,
        dbPath,
        scanRuns,
        requestId,
        spawnProcess,
        schedule,
        controlGraceMs
      },
      deps: controlDependencies()
    });
  }

  function status(workflowRunId) {
    return getWorkflowStatus({
      db,
      workflowRunId,
      deps: {
        recover: recoverWorkflowRuns,
        orphanTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs,
        progressSnapshot: getWorkflowProgressSnapshot,
        getWorkflowRun,
        communicationBatchSummary,
        publicCommunicationStatus,
        publicWorkflow,
        logger
      }
    });
  }

  function startDependencies() {
    return {
      appError,
      getSearchPlan,
      getCandidateProfile,
      getCandidateMatchingContext,
      getSearchPlanDependency,
      assertSearchPlanReady,
      getActiveWorkflow: (database, plan, site) => getActiveWorkflowRun(database, {
        profileId: plan.profileId,
        planId: plan.id,
        site
      }),
      buildDashboardState,
      workflowBlockedMessage,
      resolveNewWorkflowBrowser,
      acquisitionContextResolver,
      assertAcquisitionContext,
      acquisitionModeOf,
      freezeWorkflowPlan,
      preparePlanForNewWorkflow: (context) => preparePlanForNewWorkflow({
        ...context,
        root,
        rescore: planRescore
      }),
      scanAvailability: assertWorkflowScanAvailable,
      workflowModelProfilesSnapshot,
      createWorkflowRun,
      transitionWorkflowRun,
      spawnScan: startScan,
      settleFailedWorkflowLaunch,
      logger
    };
  }

  function resumeDependencies() {
    return {
      appError,
      getWorkflowRun,
      getBatch,
      workflowResumeNeedsBatchModel,
      assertCompleteInheritedContext,
      assertCompleteGeneratedContext,
      assertFrozenWorkflowPlan,
      resolveWorkflowResumeBrowserMode,
      normalizeCdpPort,
      portableCdpPort: PORTABLE_CDP_PORT,
      validateResumeBatch,
      assertWorkflowAnalysisBatch,
      workflowResumeRequiresBrowser,
      browserReadinessProbe,
      publicBrowserReadinessSnapshot,
      assertWorkflowResumeBrowserReady,
      resolveCurrentSearchContext: ({ workflow, browserMode, cdpPort }) => {
        const plan = getSearchPlan(db, workflow.planId);
        if (!plan) {
          throw appError("WORKFLOW_PLAN_NOT_FOUND", "本轮任务的 Search Plan 不存在。", { statusCode: 404 });
        }
        return currentSearchContextResolver({
          site: workflow.site || "boss",
          db,
          plan,
          matchingContext: getCandidateMatchingContext(db, plan.profileId),
          logger,
          browserMode,
          cdpPort
        });
      },
      replaceWorkflowScanContext,
      transitionWorkflowRun,
      scanAvailability: assertWorkflowScanAvailable,
      spawnScan: startScan,
      settleFailedWorkflowLaunch,
      logger
    };
  }

  function controlDependencies() {
    return {
      appError,
      getWorkflowRun,
      exactActiveWorkflowRun,
      exactPersistedWorkflowRunIsRunning,
      requestWorkflowPause,
      requestWorkflowStop,
      finalizeWorkflowControl,
      scheduleExactWorkflowControlFallback,
      workflowResumeNeedsBatchModel,
      resolveWorkflowControlBrowserAuthority,
      browserReadinessProbe,
      publicBrowserReadinessSnapshot,
      assertWorkflowResumeBrowserReady,
      sameWorkflowControlSnapshot,
      getBatch,
      validateResumeBatch,
      scanAvailability: assertWorkflowScanAvailable,
      assertWorkflowAnalysisBatch,
      workflowBatchResumeEvidence,
      getBatchModelState,
      batchModelReady,
      resumeWorkflowRun,
      spawnScan: startScan,
      settleFailedWorkflowLaunch,
      transitionWorkflowRun,
      logger
    };
  }

  function assertWorkflowScanAvailable(database, activeRuns, planId, scopedLogger, site = "boss") {
    assertBossRuntimeAvailable(database, { site });
    const orphaned = interruptOrphanedScanRuns(database, {
      site,
      heartbeatTimeoutMs: PRODUCT_POLICY.operations.scanOrphanTimeoutMs
    });
    if (orphaned.interrupted) scopedLogger?.warn?.("orphaned_scan_runs_interrupted", orphaned);
    const latestRun = getLatestScanRun(database, { planId, site });
    if (latestRun?.status === "running" || [...activeRuns.values()].some((run) => !run.exited)) {
      throw appError("WORKFLOW_SCAN_ALREADY_RUNNING", "BOSS 已有扫描任务正在运行，请先完成当前任务。", { statusCode: 409 });
    }
    const activeLease = getSiteScanLease(database, site)
      || getSiteScanLease(database, site === "boss" ? "zhaopin" : "boss");
    if (activeLease) {
      throw appError(
        "WORKFLOW_SCAN_LEASE_ACTIVE",
        `BOSS 已有扫描任务运行中（${activeLease.command}）。`,
        { statusCode: 409 }
      );
    }
  }

  function settleFailedWorkflowLaunch(database, activeRuns, workflow, error) {
    const current = getWorkflowRun(database, workflow?.id);
    if (!current
      || !["scanning", "analyzing"].includes(current.status)
      || exactActiveWorkflowRun(activeRuns, current)) {
      return current;
    }
    return transitionWorkflowRun(database, {
      id: current.id,
      status: "interrupted",
      errorCode: String(error?.code || "WORKFLOW_PROCESS_LAUNCH_FAILED"),
      errorMessage: String(error?.message || "workflow process launch failed")
    });
  }

  function scheduleExactWorkflowControlFallback({
    db: database,
    scanRuns: activeRuns,
    workflowRunId,
    expectedRun,
    expectedControlState,
    schedule: scheduleFn,
    graceMs,
    logger: scopedLogger
  }) {
    if (!expectedRun?.child || typeof scheduleFn !== "function") return null;
    const expectedChild = expectedRun.child;
    const delayMs = Math.max(1, Number(graceMs)
      || PRODUCT_POLICY.operations.modelAnalysis.taskLeaseTtlMs);
    let timer;
    try {
      timer = scheduleFn(() => {
        const workflow = getWorkflowRun(database, workflowRunId);
        const active = exactActiveWorkflowRun(activeRuns, workflow);
        if (!workflow
          || workflow.controlState !== expectedControlState
          || active !== expectedRun
          || active.child !== expectedChild
          || active.exited) {
          return false;
        }
        if (typeof expectedChild.kill !== "function") {
          scopedLogger?.warn?.("workflow_control_fallback_unavailable", {
            workflowRunId,
            controlState: expectedControlState
          });
          return false;
        }
        const killed = expectedChild.kill("SIGTERM");
        scopedLogger?.warn?.("workflow_control_fallback_terminated", {
          workflowRunId,
          controlState: expectedControlState,
          killed: killed !== false
        });
        return killed !== false;
      }, delayMs);
      timer?.unref?.();
    } catch (error) {
      scopedLogger?.error?.("workflow_control_fallback_schedule_failed", {
        workflowRunId,
        controlState: expectedControlState,
        error: errorMeta(error)
      });
    }
    return timer || null;
  }
}

function preparePlanForNewWorkflow({ db, plan, matchingContext, root, rescore }) {
  const active = getActiveWorkflowRun(db, {
    profileId: plan.profileId,
    planId: plan.id
  });
  if (active) return { rescored: 0, skipped: true };
  const configs = profileToRuntimeConfigs(
    loadConfigs(root),
    matchingContext?.candidateProfile || {},
    plan.plan,
    listMatchingResumeVersions(db, plan.profileId),
    matchingContext?.matchingCard || null
  );
  return rescore(db, { planId: plan.id, configs });
}

function workflowResumeRequiresBrowser(db, workflow) {
  if (!workflow) return false;
  if (workflow.status === "created") return true;
  const phase = String(workflow.resumePhase || "");
  if (phase === "scanning") return true;
  if (phase === "analyzing") return false;
  if (workflowHasAnalysisTasks(db, workflow.id)) return false;
  const scan = workflow.scanRunId ? getScanRun(db, workflow.scanRunId) : null;
  if (!scan) return true;
  return ["running", "created", "scanning"].includes(String(scan.status || ""));
}

function workflowResumeNeedsBatchModel(db, workflow) {
  if (!workflow) return false;
  if (workflow.scanNeeded) return true;
  if (["scanning", "analyzing"].includes(String(workflow.resumePhase || ""))) return true;
  return workflowHasAnalysisTasks(db, workflow.id);
}

function assertWorkflowResumeBrowserReady(readiness) {
  if (readiness.ready && readiness.status === "ready") return;
  const code = {
    starting: "BROWSER_RUNTIME_NOT_READY",
    unavailable: "BROWSER_RUNTIME_NOT_READY",
    conflict: "BROWSER_RUNTIME_NOT_READY",
    stopped: "BROWSER_RUNTIME_NOT_READY",
    needs_attention: "BROWSER_RUNTIME_NOT_READY",
    browser_unavailable: "BROWSER_UNAVAILABLE",
    boss_tab_missing: "BOSS_TAB_REQUIRED",
    login_required: "BOSS_LOGIN_REQUIRED",
    search_page_required: "BOSS_SEARCH_PAGE_INVALID",
    communication_page_required: "BOSS_COMMUNICATION_PAGE_LOST",
    risk_control: "BOSS_RISK_CONTROL"
  }[readiness.status] || "BROWSER_READINESS_INVALID";
  throw appError(code, readiness.message, { statusCode: 409 });
}

function resolveWorkflowResumeBrowserMode(workflow, requestedMode = "") {
  const acquisitionMode = String(workflow?.planner?.acquisitionMode || "").trim();
  const requested = String(requestedMode || "").trim().toLowerCase();
  if (acquisitionMode === "inherited" || workflow?.planner?.planSnapshotVersion === 2) {
    const stored = String(workflow?.planner?.browserMode || "edge").trim().toLowerCase();
    if (!new Set(["edge", "portable"]).has(stored)) {
      throw appError("WORKFLOW_BROWSER_MODE_INVALID", "本轮保存的浏览器模式无效。", { statusCode: 409 });
    }
    if (requested && requested !== stored) {
      throw appError("WORKFLOW_BROWSER_MODE_MISMATCH", `本轮已固定使用 ${stored}，不能切换浏览器。`, { statusCode: 409 });
    }
    return stored;
  }
  if (requested && !new Set(["edge", "portable"]).has(requested)) {
    throw appError(
      "WORKFLOW_BROWSER_MODE_INVALID",
      "浏览器模式必须是 OfferGo 专用 Edge（推荐）或使用当前 Edge（高级，需要浏览器连接组件）。",
      { statusCode: 409 }
    );
  }
  const stored = String(workflow?.planner?.browserMode || workflow?.planner?.browser?.mode || "")
    .trim().toLowerCase();
  return requested || (new Set(["edge", "portable"]).has(stored) ? stored : "edge");
}

function resolveWorkflowControlBrowserAuthority(workflow, params = {}) {
  const acquisitionMode = String(workflow?.planner?.acquisitionMode || "").trim();
  if (!new Set(["generated", "inherited"]).has(acquisitionMode)) {
    throw appError("WORKFLOW_ACQUISITION_MODE_INVALID", "本轮任务的采集模式无效。", { statusCode: 409 });
  }
  if (acquisitionMode === "inherited") {
    try {
      assertCompleteInheritedContext(workflow.planner, {
        code: "WORKFLOW_INHERITED_SNAPSHOT_INVALID",
        message: "本轮继承模式快照不完整。",
        planId: workflow.planId
      });
    } catch (error) {
      throw appError("WORKFLOW_INHERITED_SNAPSHOT_INVALID", "本轮继承模式快照不完整。", { statusCode: 409, cause: error });
    }
  }
  const browserMode = resolveWorkflowResumeBrowserMode(workflow, params.browserMode);
  if (browserMode === "edge") {
    if (workflow?.planner?.planSnapshotVersion === 2 && workflow.planner?.cdpPort != null) {
      throw appError("WORKFLOW_BROWSER_AUTHORITY_INVALID", "本轮保存的浏览器身份无效。", { statusCode: 409 });
    }
    return { browserMode: "edge", cdpPort: null };
  }
  const storedCdpPort = Number(workflow?.planner?.cdpPort);
  if (workflow?.planner?.planSnapshotVersion === 2 && storedCdpPort !== PORTABLE_CDP_PORT) {
    throw appError("WORKFLOW_BROWSER_AUTHORITY_INVALID", "本轮保存的浏览器身份无效。", { statusCode: 409 });
  }
  const cdpPort = normalizeCdpPort(
    params.cdpPort || (Number.isInteger(storedCdpPort) ? storedCdpPort : PORTABLE_CDP_PORT)
  );
  if (cdpPort !== PORTABLE_CDP_PORT) {
    throw appError(
      "INHERITED_PORTABLE_PORT_REQUIRED",
      "继承模式必须使用 OfferGo 专用 Edge（推荐）的固定浏览器身份。",
      { statusCode: 409 }
    );
  }
  return { browserMode, cdpPort };
}

function normalizeCdpPort(value, fallback = PORTABLE_CDP_PORT) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw appError("INVALID_SCAN_INPUT", "CDP 端口必须是 1 到 65535 之间的整数。", { statusCode: 409 });
  }
  return port;
}

function exactActiveWorkflowRun(scanRuns, workflow) {
  if (!workflow) return null;
  const keys = [`workflow:${workflow.id}`, Number(workflow.planId)];
  for (const key of keys) {
    const local = scanRuns.get(key);
    if (local && !local.exited && local.workflowRunId === workflow.id && local.child) return local;
  }
  return null;
}

function exactPersistedWorkflowRunIsRunning(db, workflow) {
  if (!workflow?.scanRunId) return false;
  return getScanRun(db, workflow.scanRunId)?.status === "running";
}

function sameWorkflowControlSnapshot(before, after) {
  return Boolean(before && after)
    && before.id === after.id
    && before.status === after.status
    && before.controlState === after.controlState
    && Number(before.progressRevision || 0) === Number(after.progressRevision || 0);
}

function workflowModelProfilesSnapshot(modelState, { backupRuntime = null } = {}) {
  const settings = modelState?.settings || {};
  const batch = settings.taskProfiles?.batch_screening;
  if (!batch?.revision) {
    throw appError(
      "MODEL_CONFIGURATION_REQUIRED",
      "批量筛选模型配置缺少版本，不能创建可恢复工作流。",
      { statusCode: 409 }
    );
  }
  const credential = batch.credentialRef === "independent"
    ? settings.independentCredentials?.batch_screening
    : settings.sharedCredential;
  const backup = settings.batchBackup;
  const backupUsable = Boolean(backupRuntime && backup?.enabled && backup.connection?.status === "verified");
  return {
    batch_screening: {
      revision: String(batch.revision),
      provider: String(credential?.provider || ""),
      model: String(batch.model || ""),
      thinkingMode: String(batch.thinkingMode || "disabled"),
      reasoningEffort: String(batch.reasoningEffort || "high"),
      timeoutMs: Number(batch.timeoutMs || 0),
      concurrency: Number(batch.concurrency || 1)
    },
    batch_backup: backupUsable ? {
      revision: String(backup.revision || backupRuntime.revision || ""),
      provider: String(backup.provider || ""),
      model: String(backup.model || ""),
      thinkingMode: String(backup.thinkingMode || "disabled"),
      reasoningEffort: String(backup.reasoningEffort || "high"),
      timeoutMs: Number(backup.timeoutMs || 0)
    } : null
  };
}

function workflowBatchResumeEvidence(modelState, { ready = false } = {}) {
  const profile = modelState?.settings?.taskProfiles?.batch_screening;
  if (!ready || !profile || profile.connection?.status !== "verified") return {};
  return {
    batchModelRevision: String(profile.revision || ""),
    batchModelVerifiedAt: String(profile.connection.checkedAt || "")
  };
}

function assertWorkflowAnalysisBatch(db, workflow) {
  const batch = workflow?.scanBatchId ? getBatch(db, workflow.scanBatchId) : null;
  if (!batch
    || batch.site !== (workflow.site || "boss")
    || Number(batch.searchPlanId || 0) !== Number(workflow?.planId || 0)
    || Number(batch.profileId || 0) !== Number(workflow?.profileId || 0)) {
    throw appError(
      "WORKFLOW_ANALYSIS_BATCH_MISMATCH",
      "本轮持久化分析批次不存在或不属于当前工作流。",
      { statusCode: 409 }
    );
  }
  return batch;
}

function workflowBlockedMessage(code, plan = {}) {
  return {
    WORKFLOW_DAILY_RUN_LIMIT: "今天的三轮任务都已创建。",
    WORKFLOW_DAILY_TARGET_REACHED: "今天的目标已完成，无需再创建新一轮。",
    WORKFLOW_THIRD_SCAN_NOT_NEEDED: "当前候选库存已足够，不需要追加第三轮扫描。",
    WORKFLOW_SCAN_INTERVAL: plan.nextRunAt
      ? `两轮扫描至少间隔 2 小时，下次可在 ${new Date(plan.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 开始。`
      : "两轮扫描至少间隔 2 小时。"
  }[code] || "当前不能创建新一轮。";
}

function publicWorkflow(workflow) {
  return {
    id: String(workflow.id || ""),
    status: String(workflow.status || ""),
    controlState: String(workflow.controlState || "none"),
    lastActivityAt: workflow.lastActivityAt || null,
    progressRevision: Number(workflow.progressRevision || 0),
    successfulCount: Number(workflow.successfulCount || 0),
    errorCode: workflow.errorCode ? String(workflow.errorCode) : null
  };
}

function publicCommunicationStatus(communication) {
  if (!communication) return null;
  return {
    batch: {
      id: Number(communication.batch?.id || 0),
      status: String(communication.batch?.status || "")
    },
    summary: {
      batchId: Number(communication.summary?.batchId || 0),
      batchStatus: String(communication.summary?.batchStatus || ""),
      statusCounts: Object.fromEntries(
        Object.entries(communication.summary?.statusCounts || {})
          .filter(([status, count]) => /^[a-z_]+$/.test(status) && Number.isFinite(Number(count)))
          .map(([status, count]) => [status, Math.max(0, Number(count))])
      ),
      total: Math.max(0, Number(communication.summary?.total || 0)),
      terminal: Math.max(0, Number(communication.summary?.terminal || 0)),
      remaining: Math.max(0, Number(communication.summary?.remaining || 0))
    }
  };
}

module.exports = {
  createDashboardWorkflowService,
  workflowResumeRequiresBrowser,
  workflowResumeNeedsBatchModel,
  assertWorkflowResumeBrowserReady,
  resolveWorkflowResumeBrowserMode,
  resolveWorkflowControlBrowserAuthority,
  sameWorkflowControlSnapshot,
  workflowModelProfilesSnapshot,
  workflowBatchResumeEvidence,
  assertWorkflowAnalysisBatch,
  exactActiveWorkflowRun,
  exactPersistedWorkflowRunIsRunning
};
