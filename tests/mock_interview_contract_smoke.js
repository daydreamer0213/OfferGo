const assert = require("node:assert");
const {
  normalizeInterviewSettings,
  buildInterviewBrief,
  buildInterviewProgress,
  buildResumeInterviewEvidenceCatalog,
  validateInterviewStep,
  validateInterviewReport,
  validateRetryReview
} = require("../src/core/mock_interview");

const resumeEvidenceCatalog = buildResumeInterviewEvidenceCatalog("个人总结\n参与知识库开发\n技能：Node.js");
assert.deepStrictEqual(resumeEvidenceCatalog.map((item) => item.id), ["R1", "R2", "R3"]);
assert.throws(() => buildResumeInterviewEvidenceCatalog(" \n "), /简历证据/);
const stepContext = { resumeEvidenceCatalog, sessionKind: "resume_general" };

const fullJd = '负责企业知识库开发和检索评估。\n任职要求：Node.js、检索质量评估与跨团队交付。';
const specificBrief = buildInterviewBrief({ sessionKind: 'job_specific', job: {
  description: fullJd,
  analysis: { jobUnderstanding: { roleSummary: '知识库工程师', coreResponsibilities: ['检索评估'],
    coreRequirements: [{ id: 'R1', text: 'Node.js' }] },
    requirementMatches: [{ id: 'R1', state: 'matched', resumeEvidence: '参与知识库开发' }],
    roleGaps: ['评估经验待验证'], questionsToVerify: ['如何评价检索效果'], roleResumeEvidence: ['参与知识库开发'] }
} });
assert.strictEqual(specificBrief.jobFocus.description, fullJd, 'brief must retain the full JD');
assert.deepStrictEqual(specificBrief.jobFocus.coreResponsibilities, ['检索评估']);
assert.deepStrictEqual(specificBrief.jobFocus.coreRequirements, [{ id: 'R1', text: 'Node.js' }]);
assert.deepStrictEqual(specificBrief.jobFocus.requirementMatches, [{ id: 'R1', state: 'matched', resumeEvidence: '参与知识库开发' }]);
assert.deepStrictEqual(specificBrief.jobFocus.roleGaps, ['评估经验待验证']);
assert.deepStrictEqual(specificBrief.jobFocus.questionsToVerify, ['如何评价检索效果']);
assert.deepStrictEqual(specificBrief.jobFocus.roleResumeEvidence, ['参与知识库开发']);
const productionBrief = buildInterviewBrief({ sessionKind: 'job_specific', job: {
  description: fullJd, analysis: { coreResponsibilities: ['检索评估'], coreRequirements: ['Node.js'],
    requirementMatches: [{ requirement: 'Node.js', state: 'matched' }] }
} });
assert.deepStrictEqual(productionBrief.jobFocus.coreResponsibilities, ['检索评估']);
assert.deepStrictEqual(productionBrief.jobFocus.coreRequirements, ['Node.js']);
assert.deepStrictEqual(productionBrief.jobFocus.requirementMatches, [{ requirement: 'Node.js', state: 'matched' }]);
const legacyBrief = buildInterviewBrief({ sessionKind: 'job_specific', job: {
  description: fullJd, analysis: { requirements: ['旧岗位要求'], evidence: { resume: ['旧证据'] } }
} });
assert.deepStrictEqual(legacyBrief.jobFocus.requirements, ['旧岗位要求']);
assert.deepStrictEqual(legacyBrief.jobFocus.matchingEvidence, { resume: ['旧证据'] });

const generalBrief = buildInterviewBrief({ sessionKind: 'resume_general' });
const progress = buildInterviewProgress(generalBrief, [
  { turnNumber: 1, question: '请介绍职业方向。', focus: 'intro', answer: '想从事应用开发' },
  { turnNumber: 2, questionText: '遇到排障难题时如何定位？', questionFocus: 'problem_solving', answerText: '比较日志' },
  { turnNumber: 3, question: '请说明协作中的分歧。', focus: 'collaboration', answer: '对齐目标' }
]);
assert.deepStrictEqual(progress.askedQuestions, ['请介绍职业方向。', '遇到排障难题时如何定位？', '请说明协作中的分歧。']);
assert.deepStrictEqual(progress.coveredThemes, ['经历与求职方向', '解决问题与取舍', '协作与沟通']);
assert.deepStrictEqual(progress.remainingThemes, ['实际承担的工作', '成果与复盘'], 'short training must keep remaining themes as hints');
assert.deepStrictEqual(buildInterviewProgress(generalBrief, [{ focus: 'collaboration', question: '你会怎样把排查结果讲清楚，并和同事一起决定下一步？' }]).coveredThemes,
  ['协作与沟通'], 'mentioning results in a collaboration question does not mean outcomes have been assessed');

function trainingStep(text, withTurns = false) {
  return { answerReview: withTurns ? { conclusion: '复盘', strengths: [], improvements: [], turnNumbers: [1] } : null,
    nextQuestion: { text, focus: 'project', resumeEvidenceIds: ['R2'], basedOnTurnNumber: null, questionKind: 'topic_transition' },
    complete: false };
}
for (const question of ['你什么时候能到岗？', '你的期望薪资是多少？', '你目前是在职还是已离职？', '你预计何时入职？',
  '你的薪资范围是什么？', '你能接受多少薪资？', '你目前的就业状态是什么？', '结合简历项目经历，你预计什么时候能到岗？',
  '这个项目之后你什么时候到岗？', '结合技术经历，你什么时候能到岗？', '你目前在哪个城市？',
  '你希望在哪个城市工作？', '你能接受出差吗？', '明天几点方便参加面试？',
  '你最快什么时候可以来上班？', '你什么时候能开始工作？', '最早几号能报到？']) {
  assert.throws(() => validateInterviewStep(trainingStep(question), { ...stepContext, interviewBrief: generalBrief, turns: [] }),
    error => error.code === 'MOCK_INTERVIEW_LOGISTICS_QUESTION');
}
for (const question of ['为什么离开上一份工作？这段经历如何影响求职方向？', '空档期选择学习 Node.js 的原因是什么？',
  '请说明知识库项目中的接口设计取舍。', '你在薪资计算系统开发中遇到了什么技术难题？', '为满足客户到岗排班需求，你如何设计系统？',
  '请说明项目中的接口设计取舍；另外你什么时候能到岗？', '你目前为什么离职？', '你的期望薪资是多少，为什么选择知识库开发方向？',
  '请说说上班后遇到的技术难题。', '你什么时候开始这个项目，如何设计接口？']) {
  assert.strictEqual(validateInterviewStep(trainingStep(question), { ...stepContext, interviewBrief: generalBrief, turns: [] }).nextQuestion.text, question);
}
assert.throws(() => validateInterviewStep(trainingStep(' 请说明知识库项目中的接口设计取舍? ', true), {
  ...stepContext, interviewBrief: generalBrief,
  turns: [{ turnNumber: 1, question: '请说明知识库项目中的接口设计取舍？', answer: '选择统一接口' }]
}), error => error.code === 'MOCK_INTERVIEW_REPEATED_QUESTION');
assert.throws(() => validateInterviewStep(trainingStep('请说说项目中遇到的技术难点。', true), {
  ...stepContext, interviewBrief: generalBrief,
  turns: [{ turnNumber: 1, question: '请介绍项目中遇到的技术难题。', answer: '接口偶尔超时' }]
}), error => error.code === 'MOCK_INTERVIEW_REPEATED_QUESTION');
assert(validateInterviewStep(trainingStep('请说说项目中遇到的技术难题如何解决。', true), {
  ...stepContext, interviewBrief: generalBrief,
  turns: [{ turnNumber: 1, question: '请介绍项目中遇到的技术难题。', answer: '接口偶尔超时' }]
}).nextQuestion, 'a follow-up asking for a solution is new information');
for (const question of ['请介绍一下项目中遇到的技术难题。', '请问你能否说说项目中遇到的技术难点？']) {
  assert.throws(() => validateInterviewStep(trainingStep(question, true), {
    ...stepContext, interviewBrief: generalBrief,
    turns: [{ turnNumber: 1, question: '请介绍项目中遇到的技术难题。', answer: '接口偶尔超时' }]
  }), error => error.code === 'MOCK_INTERVIEW_REPEATED_QUESTION');
}

assert.deepStrictEqual(normalizeInterviewSettings({
  type: "technical",
  difficulty: "challenging",
  plannedQuestions: "7"
}), { type: "technical", difficulty: "challenging", plannedQuestions: 7 });

for (const invalid of [
  { type: "sales", difficulty: "standard", plannedQuestions: 5 },
  { type: "mixed", difficulty: "easy", plannedQuestions: 5 },
  { type: "mixed", difficulty: "standard", plannedQuestions: 2 },
  { type: "mixed", difficulty: "standard", plannedQuestions: 13 }
]) {
  assert.throws(() => normalizeInterviewSettings(invalid), /面试类型|难度|题数/);
}

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "尚可", strengths: [], improvements: [], turnNumbers: [1] },
  nextQuestion: { text: "请介绍自己", focus: "intro", resumeEvidenceIds: ["R2"], basedOnTurnNumber: null },
  complete: false
}, { ...stepContext, turns: [] }), /首题/);

const first = validateInterviewStep({
  answerReview: null,
  nextQuestion: { text: "简历中写到知识库，请介绍这段经历。", focus: "intro", resumeEvidenceIds: ["R2"], basedOnTurnNumber: null },
  complete: false
}, { ...stepContext, turns: [] });
assert.strictEqual(first.nextQuestion.basedOnTurnNumber, null);
assert.deepStrictEqual(first.nextQuestion.resumeEvidenceIds, ["R2"]);

assert.throws(() => validateInterviewStep({
  answerReview: null,
  nextQuestion: {
    text: "请具体说说你负责的知识库开发工作。",
    focus: "contribution",
    resumeEvidenceIds: ["R2"],
    basedOnTurnNumber: null
  },
  complete: false
}, { ...stepContext, turns: [] }), /职责边界/);

const neutralContributionQuestion = validateInterviewStep({
  answerReview: null,
  nextQuestion: {
    text: "请具体说说你在知识库开发中参与了哪些工作。",
    focus: "contribution",
    resumeEvidenceIds: ["R2"],
    basedOnTurnNumber: null
  },
  complete: false
}, { ...stepContext, turns: [] });
assert.strictEqual(neutralContributionQuestion.nextQuestion.focus, "contribution");

const strongOwnershipContext = {
  ...stepContext,
  resumeEvidenceCatalog: buildResumeInterviewEvidenceCatalog("个人总结\n负责知识库接口联调\n技能：Node.js")
};
const supportedOwnershipQuestion = validateInterviewStep({
  answerReview: null,
  nextQuestion: {
    text: "请具体说说你负责的知识库接口联调工作。",
    focus: "contribution",
    resumeEvidenceIds: ["R2"],
    basedOnTurnNumber: null
  },
  complete: false
}, { ...strongOwnershipContext, turns: [] });
assert.strictEqual(supportedOwnershipQuestion.nextQuestion.focus, "contribution");

for (const resumeEvidenceIds of [[], ["UNKNOWN"], ["R1", "R2", "R3", "R4", "R5"]]) {
  assert.throws(() => validateInterviewStep({
    answerReview: null,
    nextQuestion: { text: "请介绍简历经历。", focus: "intro", resumeEvidenceIds, basedOnTurnNumber: null },
    complete: false
  }, { ...stepContext, turns: [] }), /简历证据/);
}

assert.throws(() => validateInterviewStep({
  answerReview: null,
  nextQuestion: { text: "首题不应引用回答", focus: "intro", resumeEvidenceIds: ["R2"], basedOnTurnNumber: null, answerEvidence: "回答" },
  complete: false
}, { ...stepContext, turns: [] }), /首题/);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "回答直接", strengths: ["有项目"], improvements: ["补充个人贡献"], turnNumbers: [1] },
  nextQuestion: { text: "继续说说项目难点。", focus: "project", resumeEvidenceIds: ["R2"], basedOnTurnNumber: null },
  complete: false
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "我参与了知识库项目。" }] }), /上一题|追问/);

const followUp = validateInterviewStep({
  answerReview: { conclusion: "回答直接", strengths: ["有项目"], improvements: ["补充个人贡献"], turnNumbers: [1] },
  nextQuestion: { text: "你刚才提到“接口联调”，结合简历中的知识库项目说明你具体做了什么。", focus: "contribution", resumeEvidenceIds: ["R2"], basedOnTurnNumber: 1, answerEvidence: "接口联调" },
  complete: false
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "我参与了知识库项目并完成接口联调。" }] });
assert.deepStrictEqual(followUp.answerReview.turnNumbers, [1]);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "引用错题", strengths: [], improvements: [], turnNumbers: [1] },
  nextQuestion: { text: "继续追问“第二题”。", focus: "project", resumeEvidenceIds: ["R2"], basedOnTurnNumber: 2, answerEvidence: "第二题" },
  complete: false
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "第一题" }, { turnNumber: 2, answer: "第二题" }] }), /刚回答|上一题.*复盘/);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "题号正确", strengths: [], improvements: [], turnNumbers: [2] },
  nextQuestion: { text: "请再介绍一个项目。", focus: "project", resumeEvidenceIds: ["R2"], basedOnTurnNumber: 2, answerEvidence: "第二题" },
  complete: false
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "第一题" }, { turnNumber: 2, answer: "第二题回答" }] }), /回答片段|承接/);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "复盘", strengths: [], improvements: [], turnNumbers: [1] },
  nextQuestion: { text: "你提到接口联调，请继续。", focus: "project", resumeEvidenceIds: [], basedOnTurnNumber: 1, answerEvidence: "接口联调" },
  complete: false
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "我做了接口联调" }] }), /简历证据/);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "完成", strengths: [], improvements: [], turnNumbers: [1] },
  nextQuestion: { text: "多余问题", focus: "extra", resumeEvidenceIds: ["R2"], basedOnTurnNumber: 1 },
  complete: true
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "回答" }] }), /结束|下一题/);

const turns = [{ turnNumber: 1 }, { turnNumber: 2 }];
const report = validateInterviewReport({
  conclusion: "岗位动机清楚，但项目贡献还需要更具体。",
  strengths: ["回答直接", "岗位动机明确"],
  improvements: ["补充个人贡献", "说明技术取舍"],
  followUpRisks: [{ turnNumber: 2, reason: "贡献边界不够清楚" }],
  retryRecommendations: [{ turnNumber: 2, reason: "用具体行动重答" }],
  answerStructures: [{ turnNumber: 2, outline: ["背景", "个人行动", "结果"] }]
}, { turns });
assert.strictEqual(report.retryRecommendations[0].turnNumber, 2);

assert.throws(() => validateInterviewReport({
  conclusion: "复盘",
  strengths: [],
  improvements: [],
  followUpRisks: [{ turnNumber: 9, reason: "不存在" }],
  retryRecommendations: [],
  answerStructures: []
}, { turns }), /题号/);

assert.throws(() => validateInterviewReport({
  conclusion: "复盘",
  offerProbability: 0.8,
  strengths: [],
  improvements: [],
  followUpRisks: [],
  retryRecommendations: [],
  answerStructures: []
}, { turns }), /录用概率/);

const retry = validateRetryReview({
  turnNumber: 2,
  conclusion: "比第一次更清楚",
  improved: true,
  strengths: ["补充了个人行动"],
  remainingImprovements: ["结果仍可量化"]
}, { turnNumber: 2 });
assert.strictEqual(retry.improved, true);
assert.throws(() => validateRetryReview({ ...retry, turnNumber: 1 }, { turnNumber: 2 }), /题号/);

console.log("mock_interview_contract_smoke ok");
