const {
  getCandidateProfile,
  getMatchingCard,
  confirmMatchingCard,
  getSearchPlan
} = require("../../storage/candidate_store");
const {
  createOnboardingRun,
  getLatestReusableOnboardingRunByContentHash,
  getOnboardingRunContext,
  retryOnboardingRun
} = require("../../storage/onboarding_store");
const { processOnboardingRun } = require("./run");

async function runAgentOnboarding({
  db,
  operationId,
  document,
  displayName = "候选人",
  refreshProfile = false,
  modelConfig = {},
  logger,
  runtimeDependencies = {}
}) {
  const normalizedOperationId = requireAgentOperationId(operationId);
  assertParsedDocument(document);

  const operationContext = getOnboardingRunContext(db, normalizedOperationId);
  const existing = operationContext?.run || null;
  if (existing && operationContext.document?.contentHash !== document.contentHash) {
    throw codedError(
      "AGENT_OPERATION_ID_CONFLICT",
      `操作编号 ${normalizedOperationId} 已用于另一份简历；新一轮请生成新的操作编号。`
    );
  }
  if (isComplete(existing)) {
    return buildAgentOnboardingResult(db, existing, {
      operationId: normalizedOperationId,
      reused: false
    });
  }
  if (existing?.status === "running") {
    throw codedError(
      "AGENT_ONBOARDING_ALREADY_RUNNING",
      `操作 ${existing.id} 正在运行，请等待当前进程完成。`
    );
  }

  if (!existing && !refreshProfile) {
    const reusable = getLatestReusableOnboardingRunByContentHash(db, document.contentHash);
    if (reusable) {
      return buildAgentOnboardingResult(db, reusable, {
        operationId: normalizedOperationId,
        reused: true
      });
    }
  }

  const retryable = existing?.status === "failed"
    || (existing?.status === "completed" && existing.matchingCardId && !existing.searchPlanId && existing.errorCode);
  const created = existing
    ? { created: false, run: retryable ? retryOnboardingRun(db, existing.id) : existing }
    : createOnboardingRun(db, {
        displayName,
        document,
        operationId: normalizedOperationId
      });

  if (created.created && typeof runtimeDependencies.persistSourceFile === "function") {
    try {
      await runtimeDependencies.persistSourceFile({
        documentId: created.run.resumeDocumentId,
        run: created.run,
        document
      });
    } catch (error) {
      logger?.warn?.("agent_resume_source_file_save_failed", {
        documentId: created.run.resumeDocumentId,
        errorCode: String(error?.code || "RESUME_SOURCE_FILE_SAVE_FAILED")
      });
    }
  }

  const processRun = runtimeDependencies.processRun || processOnboardingRun;
  const result = await processRun({
    db,
    runId: created.run.id,
    modelConfig,
    logger,
    analyzeResume: runtimeDependencies.analyzeResume,
    buildMatchingCard: runtimeDependencies.buildMatchingCard,
    recommendPlan: runtimeDependencies.recommendPlan,
    heartbeatIntervalMs: runtimeDependencies.heartbeatIntervalMs
  });
  if (!isComplete(result)) {
    throw codedError(
      result?.errorCode || "AGENT_ONBOARDING_INCOMPLETE",
      result?.errorMessage || "Agent 首次使用流程没有生成完整结果。"
    );
  }
  return buildAgentOnboardingResult(db, result, {
    operationId: normalizedOperationId,
    reused: false
  });
}

function confirmAgentMatchingCard({ db, profileId, cardId }) {
  const normalizedProfileId = positiveInteger(profileId, "需要 --profile <Profile ID>");
  const normalizedCardId = positiveInteger(cardId, "需要 --card <Matching Card ID>");
  const card = getMatchingCard(db, normalizedCardId);
  if (!card || card.profileId !== normalizedProfileId) {
    throw codedError("MATCHING_CARD_NOT_FOUND", "匹配卡不存在或不属于该候选人。");
  }
  const confirmed = confirmMatchingCard(db, {
    profileId: normalizedProfileId,
    cardId: normalizedCardId
  });
  return {
    profileId: normalizedProfileId,
    matchingCardId: confirmed.id,
    status: confirmed.status
  };
}

function buildAgentOnboardingResult(db, run, { operationId, reused }) {
  const profile = getCandidateProfile(db, run.profileId);
  const matchingCard = getMatchingCard(db, run.matchingCardId);
  const searchPlan = getSearchPlan(db, run.searchPlanId);
  return {
    operationId,
    runId: run.id,
    reused: Boolean(reused),
    run,
    profileId: run.profileId,
    profileVersionId: run.profileVersionId,
    profile,
    matchingCardId: run.matchingCardId,
    matchingCard,
    searchPlanId: run.searchPlanId,
    searchPlan
  };
}

function requireAgentOperationId(value) {
  const normalized = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw codedError(
      "AGENT_OPERATION_ID_REQUIRED",
      "agent-onboard 需要 --operation-id <UUID>；同一次命令重试沿用该 UUID，新的使用轮次生成新 UUID。"
    );
  }
  return normalized.toLowerCase();
}

function isComplete(run) {
  return Boolean(
    run?.status === "completed"
    && run.profileId
    && run.profileVersionId
    && run.matchingCardId
    && run.searchPlanId
  );
}

function assertParsedDocument(document) {
  if (!String(document?.contentHash || "").trim() || !String(document?.text || "").trim()) {
    throw codedError("AGENT_RESUME_REQUIRED", "Agent 首次使用需要已解析的简历。");
  }
}

function positiveInteger(value, message) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw new Error(message);
  return normalized;
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  runAgentOnboarding,
  confirmAgentMatchingCard,
  requireAgentOperationId,
  buildAgentOnboardingResult
};
