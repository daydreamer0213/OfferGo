const fs = require("node:fs");
const path = require("node:path");
const { parseResumeUpload } = require("../core/resume_parser");
const { storeResumeSourceFile } = require("../core/resume_files");
const {
  runAgentOnboarding,
  confirmAgentMatchingCard
} = require("../application/onboarding/agent_onboarding");

async function agentOnboardCommand({
  db,
  args,
  root,
  dataRoot,
  logger,
  modelConfig,
  attachResumeDocumentFile,
  write = (line) => process.stdout.write(line)
}) {
  requireAgentFlag(args, "agent-onboard");
  if (!args.resume) throw new Error("需要 --resume <简历文件路径>");
  const operationId = requireAgentOperationId(args["operation-id"]);
  const resumePath = path.resolve(String(args.resume));
  const fileName = path.basename(resumePath);
  const buffer = fs.readFileSync(resumePath);
  const document = await parseResumeUpload({
    fileName,
    buffer,
    root,
    runtimeRoot: dataRoot
  });
  const result = await runAgentOnboarding({
    db,
    operationId,
    document,
    displayName: String(args.name || path.parse(fileName).name || "候选人").trim(),
    refreshProfile: args["refresh-profile"] === true,
    modelConfig,
    logger: logger?.child?.({ operationId, operation: "agent_onboarding" }) || logger,
    runtimeDependencies: {
      persistSourceFile: ({ documentId }) => {
        const storedFilePath = storeResumeSourceFile({
          root: dataRoot,
          documentId,
          fileName,
          buffer
        });
        attachResumeDocumentFile(db, documentId, storedFilePath);
      }
    }
  });
  writeAgentOnboardingResult(write, result);
  return result.run;
}

function agentConfirmCommand({
  db,
  args,
  write = (line) => process.stdout.write(line)
}) {
  requireAgentFlag(args, "agent-confirm");
  const result = confirmAgentMatchingCard({
    db,
    profileId: args.profile,
    cardId: args.card
  });
  write(`${JSON.stringify({
    protocol: "offergo.agent.stdio",
    version: 1,
    type: "command_result",
    command: "agent-confirm",
    result
  })}\n`);
  return result;
}

function writeAgentOnboardingResult(write, result) {
  write(`${JSON.stringify({
    protocol: "offergo.agent.stdio",
    version: 1,
    type: "command_result",
    command: "agent-onboard",
    result: {
      operationId: result.operationId,
      runId: result.runId,
      reused: result.reused,
      profileId: result.profileId,
      profileVersionId: result.profileVersionId,
      matchingCardId: result.matchingCardId,
      matchingCard: result.matchingCard?.card || null,
      searchPlanId: result.searchPlanId,
      searchPlan: result.searchPlan?.plan || null
    }
  })}\n`);
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

function requireAgentFlag(args, command) {
  if (args.agent !== true) {
    throw codedError("AGENT_FLAG_REQUIRED", `${command} 必须显式传入 --agent。`);
  }
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  agentOnboardCommand,
  agentConfirmCommand,
  requireAgentOperationId,
  writeAgentOnboardingResult
};
