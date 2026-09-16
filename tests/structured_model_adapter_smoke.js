const assert = require("node:assert");

const { StructuredModelAdapter } = require("../src/adapters/models/structured");
const { MockModelAdapter } = require("../src/adapters/models/mock");

const candidateProfile = {
  candidate: { name: "测试候选人", city: "上海", targetTitles: ["AI 应用工程师"] },
  education: [],
  experiences: [{ organization: "示例公司", role: "开发", highlights: ["参与知识库开发"], technologies: ["Node.js"] }],
  skills: [{ name: "Node.js", evidence: "简历：参与知识库开发" }],
  projects: [{ name: "知识库", roleBoundary: "参与", canSay: ["参与知识库开发"], technologies: ["Node.js"], results: [] }],
  credentials: [],
  strengths: ["简历：参与知识库开发"],
  resumeVersions: [],
  riskMessaging: {}
};
const jobUnderstanding = {
  industryContext: "企业软件",
  hiringTracks: [{
    id: "T1",
    label: "AI 应用工程师",
    roleSummary: "开发知识库应用并交付接口",
    responsibilityEvidence: ["JD：开发知识库应用并交付接口"]
  }],
  coreRequirements: [{
    id: "R1",
    label: "Node.js 开发",
    trackIds: ["T1"],
    foundation: true,
    central: true,
    indispensable: false,
    evidence: "JD：使用 Node.js 开发"
  }],
  eligibilityItems: [],
  jobQuality: { level: "normal", concerns: [] },
  hiddenRisks: []
};
const matchEvidence = {
  selectedTrackId: "T1",
  roleAlignment: "aligned",
  roleResumeEvidence: ["简历：参与知识库开发"],
  roleGaps: [],
  responsibilityMatches: [{ id: "D1", state: "matched", resumeEvidence: "简历：参与知识库开发" }],
  matches: [{ id: "R1", state: "matched", resumeEvidence: "简历：使用 Node.js" }],
  eligibility: [],
  modelRecommendation: "apply"
};
const calls = [];
const mock = new MockModelAdapter();
const transport = {
  async requestJson(request) {
    calls.push(request);
    if (request.kind === "matchJob") return matchEvidence;
    if (request.kind === "matchResponsibilities") {
      return {
        selectedTrackId: "T1",
        matches: [{ id: "D1", state: "matched", resumeEvidence: "简历：参与知识库开发" }]
      };
    }
    if (request.kind === "matchRequirements") {
      return {
        matches: [{ id: "R1", state: "matched", resumeEvidence: "简历：使用 Node.js" }],
        eligibility: []
      };
    }
    if (typeof mock[request.kind] === "function") return mock[request.kind](request.input);
    throw new Error(`unexpected kind: ${request.kind}`);
  }
};

(async () => {
  const adapter = new StructuredModelAdapter({ transport, provider: "agent_command", model: "account-default" });
  const signal = new AbortController().signal;
  const cases = [
    ["analyzeResume", { resumeText: "测试候选人，参与知识库开发，使用 Node.js。" }],
    ["recommendSearchPlan", { candidateProfile }],
    ["buildCandidateMatchCard", { candidateProfile }],
    ["understandJob", { job: { id: "synthetic-job", title: "AI 应用工程师", description: "负责开发知识库应用并交付接口，使用 Node.js 开发。" } }],
    ["matchJob", { candidateProfile, jobUnderstanding, semanticMatchingMode: "legacy", modelRecommendationMode: "shadow" }],
    ["draftCommunication", { mode: "greeting", candidateProfile, jobUnderstanding, matchDecision: { recommendation: "apply" } }],
    ["draftMessageGroup", { profile: candidateProfile, job: { id: "synthetic-job" }, messages: [{ text: "是否愿意了解这个岗位？" }] }],
    ["extractReplyEditFacts", { changedText: "我目前在职，两周后可以到岗。", scope: { kind: "global", key: "" } }],
    ["generateResumeOptimization", { sourceResume: { text: "参与知识库开发" }, evidenceCatalog: [{ id: "R1", kind: "resume", text: "参与知识库开发" }] }],
    ["generateMockInterviewStep", { context: { sessionKind: "resume_general", resumeEvidenceCatalog: [{ id: "R1", text: "参与知识库开发" }] }, settings: { plannedQuestions: 1 }, turns: [] }],
    ["reviewMockInterview", { turns: [{ turnNumber: 1, question: "介绍项目", answer: "参与知识库开发" }] }],
    ["reviewMockInterviewRetry", { turn: { turnNumber: 1, originalAnswer: "原回答", retryAnswer: "新回答" } }]
  ];

  for (const [method, input] of cases) {
    const before = calls.length;
    const supportsSignal = ["analyzeResume", "recommendSearchPlan", "understandJob", "matchJob", "draftMessageGroup"].includes(method);
    const result = supportsSignal
      ? await adapter[method](input, { signal })
      : await adapter[method](input);
    assert(result && typeof result === "object", `${method} must return structured output`);
    assert.strictEqual(calls.length, before + 1, `${method} must use the shared transport exactly once`);
    assert.strictEqual(calls.at(-1).kind, method);
    if (supportsSignal) assert.strictEqual(calls.at(-1).signal, signal, `${method} must forward cancellation`);
  }

  const splitBefore = calls.length;
  const splitResult = await adapter.matchJob({
    candidateProfile,
    jobUnderstanding,
    semanticMatchingMode: "split",
    modelRecommendationMode: "off"
  }, { signal });
  assert(splitResult && typeof splitResult === "object");
  assert.deepStrictEqual(calls.slice(splitBefore).map((call) => call.kind), ["matchResponsibilities", "matchRequirements"]);
  assert(calls.slice(splitBefore).every((call) => call.signal === signal), "both split stages must forward cancellation");
  assert.strictEqual(splitResult.selectedTrackId, "T1");
  assert.strictEqual(splitResult.requirementMatches[0].state, "matched");

  assert.strictEqual(adapter.provider, "agent_command");
  assert.strictEqual(adapter.model, "account-default");
  assert.match(calls.find((call) => call.kind === "reviewMockInterviewRetry").systemPrompt, /只比较/);
  assert.deepStrictEqual(
    new Set(calls.map((call) => call.kind)),
    new Set([...cases.map(([method]) => method), "matchResponsibilities", "matchRequirements"])
  );
  console.log("structured model adapter smoke passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
