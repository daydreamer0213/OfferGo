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
    companyBusiness: "为企业提供知识管理服务",
    fitLabel: "中",
    fitSummary: "核心硬性要求只有可迁移证据，最高归入可投。",
    opportunityVerdict: "值得继续聊",
    opportunitySummary: "核心硬性要求只有可迁移证据，最高归入可投。"
  }
});

assert.equal(view.recruiterRequest, "HR 想请你发送简历，并回复其他问题。" );
assert.equal(view.opportunity.headline, "值得继续聊");
assert.equal(view.opportunity.reason, "有一定匹配，建议在沟通中确认关键条件。");
assert.deepStrictEqual(view.knownFacts, [
  { label: "薪资", value: "15-25K·13薪" },
  { label: "地点", value: "广州番禺" }
]);
assert.deepStrictEqual(view.details, [
  { label: "主要工作", value: "负责企业知识库产品开发" },
  { label: "公司业务", value: "为企业提供知识管理服务" }
]);
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
assert.deepStrictEqual(schedule.knownFacts, [
  { label: "地点", value: "广州" },
  { label: "工作安排", value: "双休" }
]);
assert.equal(schedule.recruiterRequest, "HR 补充了岗位或流程信息。" );

console.log("message_presenter_smoke ok");
