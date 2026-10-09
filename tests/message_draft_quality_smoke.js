"use strict";

const assert = require("node:assert/strict");
assert.equal(require('../src/core/message_draft_quality').assessMessageDraftQuality({ text: '我目前已离职。', evidenceTexts: ['我目前还在职。'] }).valid, false,
  'employment status alone must not bypass facts by using a memory');
assert.equal(require('../src/core/message_draft_quality').assessMessageDraftQuality({ text: '请问岗位是否接受下周到岗？', evidenceTexts: [] }).valid, true,
  'ordinary questions about employer conditions are not personal commitments');
for (const [text, evidence] of [
  ['我下周可以到岗。', '我下周不能到岗。'],
  ['我下周不能到岗。', '我下周可以到岗。'],
  ['我不能下周到岗。', '我可以下周到岗。']
]) {
  assert.equal(require('../src/core/message_draft_quality').assessMessageDraftQuality({ text, evidenceTexts: [evidence] }).valid, false,
    'arrival evidence must preserve negation before or after the schedule');
}
const {
  OPENING_LENGTH,
  MIN_OPENING_LENGTH,
  TRIGRAM_SIMILARITY_THRESHOLD,
  normalizedMessageText,
  extractHighRiskClaims,
  assessMessageDraftQuality
} = require("../src/core/message_draft_quality");

assert.equal(OPENING_LENGTH, 18);
assert.equal(MIN_OPENING_LENGTH, 8);
assert.equal(TRIGRAM_SIMILARITY_THRESHOLD, 0.72);
assert.equal(normalizedMessageText(" 您好，ＡＩ 岗位！\n期待沟通。 "), "您好ai岗位期待沟通");

const repeated = assessMessageDraftQuality({
  text: "您好，我对贵司的内容运营岗位很感兴趣，期待沟通。",
  recentTexts: ["您好，我对贵司的用户运营岗位很感兴趣，期待沟通。"],
  evidenceTexts: []
});
assert.equal(repeated.valid, true);
assert.equal(repeated.warnings[0].code, "MESSAGE_DRAFT_RECENTLY_SIMILAR");
assert(repeated.matchedOpening);

const punctuationOnly = assessMessageDraftQuality({
  text: "您好！想进一步了解岗位职责；期待沟通。",
  recentTexts: ["您好，想进一步了解岗位职责，期待沟通"],
  evidenceTexts: []
});
assert.equal(punctuationOnly.warnings[0].code, "MESSAGE_DRAFT_RECENTLY_SIMILAR");

const generic = assessMessageDraftQuality({
  text: "您好，谢谢。",
  recentTexts: ["您好，谢谢"],
  evidenceTexts: []
});
assert.equal(generic.warnings.length, 0, "short generic phrases must not trigger similarity warnings");

const unrelated = assessMessageDraftQuality({
  text: "您好，想了解团队目前最关注的内容增长方向。",
  recentTexts: ["感谢回复，我会按约定时间准备并参加面试。"],
  evidenceTexts: []
});
assert.equal(unrelated.warnings.length, 0);

const invented = assessMessageDraftQuality({
  text: "我可以本周三到岗，期望薪资 25K，手机号 13800138000。",
  recentTexts: [],
  evidenceTexts: ["用户可在两周后到岗"]
});
assert.equal(invented.valid, false);
assert.deepEqual(invented.errors.map((item) => item.kind).sort(), ["arrival", "phone", "salary"]);

const supportedText = [
  "手机号 13800138000，邮箱 user@example.com，作品 https://example.com/work。",
  "期望薪资 25K，本周三可以到岗，周五下午可以面试。",
  "有 3 年经验，转化率提升 30%，累计服务 200 个客户。",
  "不接受加班，可以短期出差，不考虑异地搬迁。"
].join("");
const supported = assessMessageDraftQuality({
  text: supportedText,
  recentTexts: [],
  evidenceTexts: [supportedText]
});
assert.equal(supported.valid, true, JSON.stringify(supported.errors));
assert(supported.errors.length === 0);

for (const newline of ['\n', '\r\n']) {
  const chronology = `后端开发工程师｜2024.07—2026.09${newline}个人完成订单状态与发票导出接口。`;
  assert.equal(extractHighRiskClaims(chronology).some(claim => claim.kind === 'numeric_achievement'), false,
    'a dated role and the next-line word personal are not an achievement quantity');
}
assert.equal(assessMessageDraftQuality({text:'本人完成 200 个客户的资料整理。', evidenceTexts:[]}).valid, false,
  'ordinary unsupported achievement quantities remain checked');
assert.equal(assessMessageDraftQuality({
  text:'我10月9日下午14点到17点方便线上面试，您看这个时间可以吗？',
  evidenceTexts:['2026年10月9日下午14点到17点方便线上面试。']
}).valid,true,'an explicit calendar date is not a changed work duration');
assert.equal(extractHighRiskClaims('2026年10月9日参加面试。').some(c=>c.kind==='duration'),false);
assert.equal(assessMessageDraftQuality({text:'我有3年后端经验。',evidenceTexts:['我有2年后端经验。']}).valid,false,
  'actual experience duration must remain checked');

const supportedAvailabilityParaphrase = assessMessageDraftQuality({
  text: "我本周三可以到岗。",
  recentTexts: [],
  evidenceTexts: ["本周三到岗"]
});
assert.equal(supportedAvailabilityParaphrase.valid, true,
  "the same explicit arrival date should not depend on filler wording");

const extractedKinds = new Set(extractHighRiskClaims(supportedText).map((item) => item.kind));
for (const kind of ["phone", "email", "url", "salary", "arrival", "interview_availability", "duration", "percentage", "numeric_achievement", "overtime", "travel", "relocation"]) {
  assert(extractedKinds.has(kind), `expected ${kind} claim`);
}

const wrongPreference = assessMessageDraftQuality({
  text: "我可以接受加班，也可以长期出差。",
  recentTexts: [],
  evidenceTexts: ["用户不接受加班，只接受短期出差"]
});
assert.equal(wrongPreference.valid, false);
assert.deepEqual(wrongPreference.errors.map((item) => item.kind).sort(), ["overtime", "travel"]);

const reusedNumberForDifferentAchievement = assessMessageDraftQuality({
  text: "完成 100 个大型项目。",
  recentTexts: [],
  evidenceTexts: ["处理 100 个请求。"]
});
assert.equal(reusedNumberForDifferentAchievement.valid, false);
assert(reusedNumberForDifferentAchievement.errors.some((item) => item.kind === "numeric_achievement"));

const reusedDurationForDifferentWork = assessMessageDraftQuality({
  text: "有 3 年销售经验。",
  recentTexts: [],
  evidenceTexts: ["有 3 年开发经验。"]
});
assert.equal(reusedDurationForDifferentWork.valid, false);
assert(reusedDurationForDifferentWork.errors.some((item) => item.kind === "duration"));

const supportedAchievementParaphrase = assessMessageDraftQuality({
  text: "服务客户 200 个。",
  recentTexts: [],
  evidenceTexts: ["累计服务 200 个客户。"]
});
assert.equal(supportedAchievementParaphrase.valid, true, JSON.stringify(supportedAchievementParaphrase.errors));

const unsupportedResponseCount = assessMessageDraftQuality({
  text: "响应 100 次调用。",
  recentTexts: [],
  evidenceTexts: []
});
assert.equal(unsupportedResponseCount.valid, false);
assert(unsupportedResponseCount.errors.some((item) => item.kind === "numeric_achievement"));

const supportedSoftwareExperienceParaphrase = assessMessageDraftQuality({
  text: "有 3 年软件工程经验。",
  recentTexts: [],
  evidenceTexts: ["有 3 年软件开发经验。"]
});
assert.equal(supportedSoftwareExperienceParaphrase.valid, true,
  JSON.stringify(supportedSoftwareExperienceParaphrase.errors));

const supportedRequestCountParaphrase = assessMessageDraftQuality({
  text: "响应 100 次调用。",
  recentTexts: [],
  evidenceTexts: ["处理 100 个请求。"]
});
assert.equal(supportedRequestCountParaphrase.valid, true,
  JSON.stringify(supportedRequestCountParaphrase.errors));

for (const employerQuestion of [
  "想了解贵司团队目前有 20 人吗？",
  "这个岗位需要负责 3 个模块吗？",
  "我想了解岗位负责 3 个模块吗？",
  "感谢您介绍这 2 个方向。",
  "感谢您介绍这 2 个方向，我很有兴趣。",
  "这 2 个方向我都有兴趣。",
  "我有 2 个问题想请教。",
  "其中我有 2 个方向比较感兴趣。",
  "我有 2 个客户相关问题想请教。",
  "我有 2 个关于客户投诉处理的问题想请教。",
  "我想请教 2 个客户问题该如何处理。",
  "我有 2 个客户问题想请教如何解决？"
]) {
  const result = assessMessageDraftQuality({
    text: employerQuestion,
    recentTexts: [],
    evidenceTexts: []
  });
  assert.equal(result.valid, true, `${employerQuestion}: ${JSON.stringify(result.errors)}`);
}

for (const unsupportedCandidateClaim of [
  "我有 100 个客户。",
  "我有 100 个长期合作客户。",
  "我有 100 个优质客户。",
  "我有 100 个软件项目。",
  "我有 100 个落地项目。",
  "解决了 100 个客户问题。",
  "我解决过 100 个客户问题。",
  "累计解决 100 个客户问题。",
  "我曾解决 100 个客户问题，这样写可以吗？",
  "我有 100 个客户问题处理经验。",
  "我做过 100 个项目。",
  "100 个项目均已完成。"
]) {
  const result = assessMessageDraftQuality({
    text: unsupportedCandidateClaim,
    recentTexts: [],
    evidenceTexts: []
  });
  assert.equal(result.valid, false, unsupportedCandidateClaim);
  assert(result.errors.some((item) => item.kind === "numeric_achievement"));
}

const supportedSolvedProblems = assessMessageDraftQuality({
  text: "累计解决 100 个客户问题。",
  recentTexts: [],
  evidenceTexts: ["处理过 100 个客户问题。"]
});
assert.equal(supportedSolvedProblems.valid, true, JSON.stringify(supportedSolvedProblems.errors));

const benchmarkEvidence = "在2万条订单的测试数据上，压测平均响应从480ms降到190ms；没有记录生产环境同口径指标。";
for (const reply of [
  "在2万条订单测试数据上跑了优化前后对比。",
  "这个优化我是在测试环境用 2 万条订单数据做压测对比的。",
  "2 万条订单测试数据平均耗时从 480ms 降到 190ms。",
  "在2万条测试数据上平均响应从480ms降到190ms。"
]) {
  const result = assessMessageDraftQuality({ text: reply, evidenceTexts: [benchmarkEvidence] });
  assert.equal(result.valid, true, `${reply}: ${JSON.stringify(result.errors)}`);
}
for (const reply of [
  "在20万条订单测试数据上跑了优化前后对比。",
  "在2万条客户测试数据上跑了优化前后对比。",
  "处理了2万条生产订单。",
  "累计处理了2万条订单。",
  "在2万条订单测试数据上完成了20万条请求的压测。"
]) {
  const result = assessMessageDraftQuality({ text: reply, evidenceTexts: [benchmarkEvidence] });
  assert.equal(result.valid, false, reply);
  assert(result.errors.some((item) => item.kind === "numeric_achievement"));
}

for (const separator of ['，', ',', '；', ';']) {
  assert.equal(assessMessageDraftQuality({ text: `在5人团队参与接口开发${separator}个人完成发票导出。`, evidenceTexts: ['在5人团队参与接口开发，个人完成发票导出。'] }).valid, true);
  assert.equal(assessMessageDraftQuality({ text: `我完成100个客户问题${separator}参与接口开发。`, evidenceTexts: ['我处理10个客户问题，参与接口开发。'] }).valid, false,
    'consistent clause boundaries must still reject inflated personal achievements');
}
console.log("message_draft_quality_smoke ok");
