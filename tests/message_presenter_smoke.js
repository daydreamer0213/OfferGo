const assert = require("node:assert/strict");
const { presentMessageResult } = require("../src/dashboard/message_presenter");

const view = presentMessageResult({
  platform: "boss",
  messageIntent: "information_request",
  messageSummary: "对方正在确认候选人的任职资格。",
  manualActions: [{ kind: "resume_request" }],
  drafts: [{ id: 1, text: "方便的，我们可以进一步沟通。" }],
  job: {
    title: "AI 应用工程师",
    location: "广州番禺",
    salary: "15-25K·13薪",
    workSchedule: "工作安排未确认",
    roleSummary: "负责企业知识库产品开发",
    roleTasks: ["梳理企业知识管理需求", "协调研发把功能落地"],
    companyBusiness: "为企业提供知识管理服务",
    fitLabel: "中",
    fitSummary: "核心硬性要求只有可迁移证据，最高归入可投。",
    opportunityVerdict: "值得继续聊",
    opportunitySummary: "核心硬性要求只有可迁移证据，最高归入可投。",
    matchHighlights: ["简历已明确体现：本科及以上学历", "已有相近经历：企业知识库产品开发"],
    questionsToConfirm: ["请确认：生产环境运维经验是否为必须条件。"],
    continueCondition: "以下条件都满足时，建议继续交流：薪资 15-25K·13薪 在你的接受范围内；岗位不强制要求“生产环境运维经验”，或你能够接受这项要求。",
    resumeConnections: ["你在 OfferGo 中做过企业知识库产品开发，这与岗位的主要工作直接相关。"],
    attentionPoint: "生产环境运维是否属于日常核心职责还需要问清楚。",
    recommendationNote: "如果运维只占辅助部分，这个岗位值得继续了解。"
  }
});

assert.equal(view.recruiterRequest, "HR 想请你发送简历，并回复其他问题。" );
assert.equal(view.roleSummary, "负责企业知识库产品开发");
assert.deepStrictEqual(view.roleTasks, ["梳理企业知识管理需求", "协调研发把功能落地"]);
assert.equal(view.businessContext, "业务方向：为企业提供知识管理服务。");
assert.deepStrictEqual(view.jobFacts, [
  { label: "薪资", value: "15-25K·13薪" },
  { label: "地点", value: "广州番禺" }
]);
assert.deepStrictEqual(view.resumeConnections, ["你在 OfferGo 中做过企业知识库产品开发，这与岗位的主要工作直接相关。"]);
assert.equal(view.attentionPoint, "生产环境运维是否属于日常核心职责还需要问清楚。");
assert.equal(view.recommendationNote, "如果运维只占辅助部分，这个岗位值得继续了解。");
assert(!JSON.stringify(view).includes("可迁移证据"));
assert(!JSON.stringify(view).includes("最高归入可投"));
assert(!JSON.stringify(view).includes("工作安排未确认"));

const schedule = presentMessageResult({
  messageIntent: "information_update",
  messageSummary: "对方正在补充当前岗位、项目或流程信息。",
  manualActions: [],
  drafts: [],
  job: { workSchedule: "双休", location: "广州", salary: "薪资未说明" }
});
assert.deepStrictEqual(schedule.jobFacts, [
  { label: "地点", value: "广州" },
  { label: "工作安排", value: "双休" }
]);
assert.equal(schedule.recruiterRequest, "HR 补充了岗位或流程信息。" );

const cloudRole = presentMessageResult({
  job: {
    roleSummary: "负责容器云与AI基础设施产品的竞品分析、需求分析与场景梳理，输出需求文档与验收标准，并协调跨团队推进功能从需求到验收的闭环交付。",
    roleTasks: [
      "JD：研究容器云与 AI 基础设施的竞品和业务场景",
      "JD：把客户需求整理成功能范围和验收标准",
      "JD：协调研发、测试推进产品落地"
    ],
    companyBusiness: "JD 显示该岗位属于容器云与AI基础设施相关业务场景。"
  }
});
assert.equal(cloudRole.roleSummary,
  "这个岗位主要围绕容器云与 AI 基础设施做产品工作：先研究竞品和业务场景，把客户或内部需求整理成具体功能和验收标准，再跟进研发、测试等团队把功能真正落地。");
assert.equal(cloudRole.businessContext, "业务方向：容器云与 AI 基础设施。");
assert.deepStrictEqual(cloudRole.roleTasks, [
  "研究容器云与 AI 基础设施的竞品和业务场景",
  "把客户需求整理成功能范围和验收标准",
  "协调研发、测试推进产品落地"
]);

console.log("message_presenter_smoke ok");
