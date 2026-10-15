const assert = require("node:assert/strict");
const storage = require("../src/core/storage");
const { openDb, saveProfileAnalysis } = storage;
const { createDashboardServer } = require("../src/dashboard/server");
const { renderMockInterviewPage, MOCK_INTERVIEW_SCRIPT } = require("../src/dashboard/pages/mock_interview");
const vm = require("node:vm");

const logger = {
  info() {}, warn() {}, error() {},
  requestId() { return "dashboard-mock-interview-smoke"; },
  listRecent() { return []; }
};

(async () => {
  const db = openDb(":memory:");
  const owner = saveProfileAnalysis(db, {
    profile: {
      candidate: { name: "页面候选人", city: "广州", targetTitles: ["AI 应用工程师"] },
      skills: [{ name: "Node.js" }], projects: [{ name: "知识库" }]
    },
    document: {
      originalFileName: "resume.txt", format: "text", contentHash: "interview-page-resume",
      text: "个人总结\n参与知识库开发", diagnostics: {}
    },
    searchPlan: {
      name: "页面测试方案", cities: ["广州"], directions: ["AI 应用工程师"],
      keywords: [{ word: "知识库", priority: "A" }]
    }
  });
  const calls = { dashboard: [], start: [], answer: [], finish: [], retry: [] };
  const selectedSession = {
    id: 51,
    profileId: owner.profileId,
    sessionKind: "resume_general",
    jobId: null,
    resumeVersionId: owner.resumeVersionId,
    context: {
      sessionKind: "resume_general",
      job: null,
      resume: { versionId: owner.resumeVersionId, name: "基础简历", text: "参与知识库开发" },
      resumeEvidenceCatalog: [{ id: "R1", kind: "resume", text: "参与知识库开发" }]
    },
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    status: "completed",
    report: {
      conclusion: "岗位动机清楚，但项目贡献要更具体。",
      strengths: ["回答直接", "岗位相关"], improvements: ["补充个人行动"],
      followUpRisks: [{ turnNumber: 1, reason: "贡献边界会被追问" }],
      retryRecommendations: [{ turnNumber: 1, reason: "用行动和结果重答" }],
      answerStructures: [{ turnNumber: 1, outline: ["背景", "行动", "结果"] }]
    },
    turns: [{
      id: 61, turnNumber: 1, questionText: "请介绍相关项目。", questionFocus: "project",
      resumeEvidenceIds: ["R1"],
      basedOnTurnNumber: null, answerText: "我参与了 <script>alert(1)</script> 知识库开发。",
      answerReview: { conclusion: "相关", strengths: ["直接"], improvements: ["补充贡献"], turnNumbers: [1] },
      retries: [{
        id: 81, turnNumber: 1, retryIndex: 1,
        answerText: "我参与知识库开发，并负责接口联调。",
        review: { turnNumber: 1, conclusion: "更具体", improved: true, strengths: ["补充行动"], remainingImprovements: ["补充结果"] }
      }]
    }]
  };
  let answerFailure = null;
  const service = {
    dashboard(input) {
      calls.dashboard.push(input);
      return {
        profile: { id: owner.profileId, displayName: "页面候选人" },
        plan: { id: owner.planId, profileId: owner.profileId, name: "页面测试方案" },
        resumes: [{ id: owner.resumeVersionId, name: "基础简历", isActive: true }],
        jobs: [{ id: 71, title: "AI <应用> 工程师", company: "示例科技", description: "完整 JD", analysis: { semanticStatus: "complete" } }],
        sessions: [selectedSession],
        selectedSession
      };
    },
    async startSession(input) { calls.start.push(input); return { id: 52 }; },
    async answerTurn(input) { calls.answer.push(input); if (answerFailure) throw answerFailure; return selectedSession; },
    async finishSession(input) { calls.finish.push(input); return selectedSession; },
    async retryTurn(input) { calls.retry.push(input); return selectedSession.turns[0].retries[0]; }
  };
  let readinessCalls = 0;
  const server = createDashboardServer({
    db,
    forceMock: true,
    allowOfflineMock: true,
    logger,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    browserReadinessProbe: async () => { readinessCalls += 1; throw new Error("local interview must not probe browser"); },
    mockInterviewService: service
  });
  const baseUrl = await listen(server);
  try {
    const page = await request(baseUrl, `/interview?planId=${owner.planId}&sessionId=51`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>模拟面试训练<\/title>/);
    assert.match(page.body, /class="[^"]*interview-workbench/);
    assert.match(page.body, /aria-current="page">面试训练<\/a>/);
    assert.match(page.body, /简历通用面试/);
    assert.match(page.body, /岗位专项面试/);
    assert.match(page.body, /题目侧重/);
    assert.match(page.body, /自我介绍与沟通/);
    assert.doesNotMatch(page.body, /面试类型/);
    assert.match(page.body, /value="resume_general" checked/);
    assert.match(page.body, /参与知识库开发/);
    assert.deepEqual(calls.dashboard, [{ profileId: owner.profileId, planId: owner.planId, sessionId: 51 }]);
    assert.match(page.body, /基础简历/);
    assert.match(page.body, /AI &lt;应用&gt; 工程师/);
    assert.doesNotMatch(page.body, /AI <应用> 工程师/);
    assert.match(page.body, /岗位动机清楚/);
    assert(page.body.indexOf("岗位动机清楚") < page.body.indexOf("请介绍相关项目"), "completed report must appear before transcript");
    assert.match(page.body, /我参与了 &lt;script&gt;alert\(1\)&lt;\/script&gt; 知识库开发/);
    assert.doesNotMatch(page.body, /<script>alert\(1\)<\/script>/);
    assert.match(page.body, /原回答/);
    assert.match(page.body, /<textarea name="sourceQuote"[^>]*required>/, 'users can select the factual original passage');
    assert.doesNotMatch(page.body, /type="hidden" name="sourceQuote"/, 'source selection must not be hidden');
    assert.match(page.body, /我参与知识库开发，并负责接口联调/);
    const retryFeedback = page.body.match(/<div class="interview-retries">([\s\S]*?)<\/div>/)?.[1];
    assert(retryFeedback, 'completed interview must show the retry feedback');
    for (const point of selectedSession.turns[0].retries[0].review.strengths) {
      assert(retryFeedback.includes(point), 'retry feedback must retain the concrete strengths returned by the review');
    }
    for (const point of selectedSession.turns[0].retries[0].review.remainingImprovements) {
      assert(retryFeedback.includes(point), 'retry feedback must retain the remaining improvements');
    }
    assert.match(page.body, /name="sessionId" value="51"/);
    assert.match(page.body, /name="turnNumber" value="1"/);
    assert.match(page.body, /data-interview-draft="retry"/);

    const ongoingSession = {
      ...selectedSession,
      status: "active",
      report: null,
      turns: [
        { ...selectedSession.turns[0], retries: [] },
        { id: 62, turnNumber: 2, questionText: "请说明你在项目中的个人贡献。", questionFocus: "project", resumeEvidenceIds: ["R1"], basedOnTurnNumber: 1, answerText: "", answerReview: null, retries: [] }
      ]
    };
    const ongoingPage = renderMockInterviewPage({
      dashboard: {
        profile: { id: owner.profileId }, plan: { id: owner.planId, name: "页面测试方案" },
        resumes: [{ id: owner.resumeVersionId, name: "基础简历", isActive: true }],
        jobs: [], sessions: [ongoingSession], selectedSession: ongoingSession
      },
      modelReady: true
    });
    assert.equal((ongoingPage.match(/请说明你在项目中的个人贡献。/g) || []).length, 1, "the unanswered current question must not be duplicated in the transcript");
    assert.doesNotMatch(ongoingPage, /等待回答/);
    assert.match(ongoingPage, /class="[^"]*interview-current-question/);
    assert.match(ongoingPage, /data-interview-draft="answer"/);

    const start = await request(baseUrl, "/api/interview/start", {
      method: "POST",
      body: new URLSearchParams({
        planId: String(owner.planId), sessionKind: "resume_general", resumeVersionId: String(owner.resumeVersionId),
        type: "mixed", difficulty: "standard", plannedQuestions: "5"
      }).toString()
    });
    assert.equal(start.status, 303);
    assert.equal(start.headers.location, `/interview?planId=${owner.planId}&sessionId=52#interview-active-step`);
    assert.deepEqual(calls.start[0], {
      profileId: owner.profileId, planId: owner.planId, sessionKind: "resume_general", jobId: null,
      resumeVersionId: owner.resumeVersionId,
      settings: { type: "mixed", difficulty: "standard", plannedQuestions: 5 }
    });

    const specificStart = await request(baseUrl, "/api/interview/start", {
      method: "POST",
      body: new URLSearchParams({
        planId: String(owner.planId), sessionKind: "job_specific", jobId: "71",
        resumeVersionId: String(owner.resumeVersionId), type: "mixed", difficulty: "standard", plannedQuestions: "5"
      }).toString()
    });
    assert.equal(specificStart.status, 303);
    assert.deepEqual(calls.start[1], {
      profileId: owner.profileId, planId: owner.planId, sessionKind: "job_specific", jobId: 71,
      resumeVersionId: owner.resumeVersionId,
      settings: { type: "mixed", difficulty: "standard", plannedQuestions: 5 }
    });

    const answer = await request(baseUrl, "/api/interview/answer", {
      method: "POST",
      body: new URLSearchParams({ planId: String(owner.planId), sessionId: "51", turnNumber: "1", answerText: "我的回答" }).toString()
    });
    assert.equal(answer.status, 303);
    assert.equal(answer.headers.location, `/interview?planId=${owner.planId}&sessionId=51#interview-active-step`);
    assert.deepEqual(calls.answer[0], { profileId: owner.profileId, planId: owner.planId, sessionId: 51, turnNumber: 1, answerText: "我的回答" });

    const finish = await request(baseUrl, "/api/interview/finish", {
      method: "POST", body: new URLSearchParams({ planId: String(owner.planId), sessionId: "51" }).toString()
    });
    assert.equal(finish.status, 303);
    assert.equal(finish.headers.location, `/interview?planId=${owner.planId}&sessionId=51#interview-report-title`);
    assert.deepEqual(calls.finish[0], { profileId: owner.profileId, planId: owner.planId, sessionId: 51 });

    const retry = await request(baseUrl, "/api/interview/retry", {
      method: "POST",
      body: new URLSearchParams({ planId: String(owner.planId), sessionId: "51", turnNumber: "1", answerText: "我的重答" }).toString()
    });
    assert.equal(retry.status, 303);
    assert.equal(retry.headers.location, `/interview?planId=${owner.planId}&sessionId=51#interview-turn-1`);
    assert.deepEqual(calls.retry[0], { profileId: owner.profileId, planId: owner.planId, sessionId: 51, turnNumber: 1, answerText: "我的重答" });
    assert.equal(readinessCalls, 0, "local interview workflow must not inspect browser readiness");

    answerFailure = new Error("simulated interview model failure");
    const unhandled = [];
    const recordUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", recordUnhandled);
    try {
      const failedAnswer = await request(baseUrl, "/api/interview/answer", {
        method: "POST",
        timeoutMs: 1_000,
        body: new URLSearchParams({ planId: String(owner.planId), sessionId: "51", turnNumber: "1", answerText: "失败时保留" }).toString()
      });
      assert.equal(failedAnswer.status, 500, "async interview failures must reach the dashboard error boundary");
      assert.match(failedAnswer.body, /requestId|请求|错误编号/);
      const health = await request(baseUrl, `/interview?planId=${owner.planId}&sessionId=51`);
      assert.equal(health.status, 200, "dashboard must remain available after an interview workflow failure");
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
    assert.equal(unhandled.length, 0, "interview failure must not become an unhandled rejection");
    await interviewDraftClientSmoke(MOCK_INTERVIEW_SCRIPT);
    await verifyDefaultServiceConcurrency();
    await verifyStoryPreparationFlow();
    await verifyPreparationClientRecovery();

    console.log("dashboard_mock_interview_smoke ok");
  } finally {
    await close(server);
    db.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function verifyDefaultServiceConcurrency() {
  const db = openDb(":memory:");
  const owner = saveProfileAnalysis(db, {
    profile: { candidate: { name: "并发候选人", city: "广州", targetTitles: ["AI 应用工程师"] } },
    document: {
      originalFileName: "concurrent.txt", format: "text", contentHash: "interview-concurrent-resume",
      text: "参与企业知识库开发", diagnostics: {}
    },
    searchPlan: {
      name: "并发完成方案", cities: ["广州"], directions: ["AI 应用工程师"],
      keywords: [{ word: "知识库", priority: "A" }]
    }
  });
  const batch = storage.createBatch(db, "boss", "知识库", "interview concurrency", {
    profileId: owner.profileId, searchPlanId: owner.planId
  });
  const jobId = storage.upsertJob(db, {
    source: "boss", sourceId: "interview-dashboard-concurrent", keyword: "知识库",
    title: "AI 应用工程师", company: "示例科技", location: "广州", salary: "15-25K",
    experience: "1-3年", education: "本科", bossActiveText: "今日活跃", bossActiveDays: 0,
    url: "https://www.zhipin.com/job_detail/interview-dashboard-concurrent.html", tags: ["Node.js"],
    description: "负责企业知识库开发、检索评估和接口交付，要求具备完整项目经验。",
    score: 18, level: "可投", matches: ["Node.js"], risks: [], qualityTags: [],
    analysis: { provider: "mock", model: "offline", semanticStatus: "complete", recommendation: "apply" }
  }, batch);
  const session = storage.createMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionKind: "job_specific", jobId, resumeVersionId: owner.resumeVersionId,
    context: {
      sessionKind: "job_specific",
      job: { id: jobId, title: "AI 应用工程师" },
      resume: { versionId: owner.resumeVersionId, text: "参与企业知识库开发" },
      resumeEvidenceCatalog: [{ id: "R1", kind: "resume", text: "参与企业知识库开发" }]
    },
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    initialQuestion: { text: "第一题", focus: "intro", resumeEvidenceIds: ["R1"], basedOnTurnNumber: null, answerEvidence: "" }
  });
  const answers = ["第一题回答", "第二题回答", "第三题回答"];
  for (let index = 0; index < answers.length; index += 1) {
    const turnNumber = index + 1;
    storage.answerMockInterviewTurn(db, {
      profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber,
      answerText: answers[index],
      answerReview: { conclusion: "已复盘", strengths: [], improvements: [], turnNumbers: [turnNumber] },
      nextQuestion: turnNumber < 3 ? {
        text: `你提到“${answers[index]}”，请继续。`, focus: "project",
        resumeEvidenceIds: ["R1"],
        basedOnTurnNumber: turnNumber, answerEvidence: answers[index]
      } : null
    });
  }
  let reportCalls = 0;
  const adapter = {
    provider: "counted",
    model: "dashboard-concurrency",
    async reviewMockInterview() {
      reportCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        conclusion: "完成", strengths: ["相关"], improvements: ["补充结果"],
        followUpRisks: [{ turnNumber: 2, reason: "需要细节" }],
        retryRecommendations: [{ turnNumber: 2, reason: "重新组织" }],
        answerStructures: [{ turnNumber: 2, outline: ["背景", "行动", "结果"] }]
      };
    }
  };
  const server = createDashboardServer({
    db,
    forceMock: true,
    allowOfflineMock: true,
    logger,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    mockInterviewAdapterResolver: () => adapter
  });
  const baseUrl = await listen(server);
  const body = new URLSearchParams({ planId: String(owner.planId), sessionId: String(session.id) }).toString();
  try {
    const [first, second] = await Promise.all([
      request(baseUrl, "/api/interview/finish", { method: "POST", body }),
      request(baseUrl, "/api/interview/finish", { method: "POST", body })
    ]);
    assert.equal(first.status, 303);
    assert.equal(second.status, 303);
    assert.equal(reportCalls, 1, "parallel HTTP finishes must share one Dashboard service and one model call");
  } finally {
    await close(server);
    db.close();
  }
}

async function verifyStoryPreparationFlow() {
  const db = openDb(':memory:');
  const owner = saveProfileAnalysis(db, {
    profile: { candidate: { name: '故事页面候选人', city: '广州', targetTitles: ['开发工程师'] }, skills: [], projects: [{ name: '检索项目' }] },
    document: { originalFileName: 'stories.txt', format: 'text', contentHash: 'story-page-resume',
      text: '检索项目\n负责检索链路，组合两种召回方式。\n维护评估样例。\n交付查询接口。', diagnostics: {} },
    searchPlan: { name: '故事页面', cities: ['广州'], directions: ['开发工程师'], keywords: [{ word: '检索', priority: 'A' }] }
  });
  let generations = 0;
  let failRefine = false;
  let frozenStory = null;
  const structuredStory = [
    '【我负责什么】', '我负责检索链路的实现。', '',
    '【当时要解决的问题】', '需要处理两种召回结果。', '',
    '【我做了什么】', '- 我组合了两种召回方式。', '- 我核对了 <script>unsafe()</script> 样例。', '',
    '【为什么这样做】', '组合两种方式，可以覆盖不同类型的查询。', '',
    '【结果如何】', '检索链路已交付，效果数据仍需补充。', '',
    '【复盘与启发】', '待核实思路：回想评估样例是否帮助发现问题。'
  ].join('\n');
  const legacyStory = '我负责评估样例。\n为什么这样做：这行是旧稿原话。\n\n【用户自己的标题】\n原文和空行后的内容都要保留。';
  const adapter = { provider: 'controlled', model: 'story-flow',
    async generateMockInterviewPreparation({ preparation, storyId, supplement }) {
      generations += 1;
      if (failRefine) throw Error('controlled preparation unavailable');
      if (storyId) return { stories: [{ ...preparation.stories.find(story => story.id === storyId), text: `补充后的故事：${supplement}`, missingDetails: [] }] };
      return { stories: ['检索链路', '评估样例', '查询接口'].map((title, i) => ({ id: `S${i + 1}`, title,
        resumeEvidenceIds: [`R${i + 2}`], text: i === 0 ? structuredStory : i === 1 ? legacyStory : `我负责${title}，会比较已有做法，并记录实际结果。`,
        missingDetails: i === 0 ? ['当时为什么选择这套做法？'] : [] })) };
    },
    async generateMockInterviewStep({ context }) {
      frozenStory = context.storyPreparation;
      const story = frozenStory.stories[0];
      return { nextQuestion: { questionKind: 'topic_transition', text: `请介绍${story.title}这部分工作。`, focus: story.id,
        resumeEvidenceIds: story.resumeEvidenceIds, basedOnTurnNumber: null, answerEvidence: '' }, complete: false };
    }
  };
  const server = createDashboardServer({ db, forceMock: true, allowOfflineMock: true, logger,
    browserAuthority: { browserMode: 'edge', cdpPort: null, profilePath: '' }, mockInterviewAdapterResolver: () => adapter });
  const baseUrl = await listen(server);
  const post = (route, values) => request(baseUrl, route, { method: 'POST', body: new URLSearchParams({ planId: String(owner.planId), ...values }).toString() });
  try {
    const landing = await request(baseUrl, `/interview?planId=${owner.planId}`);
    assert.equal(landing.status, 200);
    assert.equal(generations, 0, 'opening the preparation page never calls a model');
    const made = await post('/api/interview/prepare', { resumeVersionId: String(owner.resumeVersionId), operationId: 'http-story-preparation' });
    assert.equal(made.status, 303, 'the preparation form must create and save a story draft');
    assert.match(made.headers.location, /preparationId=\d+/);
    const preparationId = Number(new URL(made.headers.location, baseUrl).searchParams.get('preparationId'));
    const page = await request(baseUrl, made.headers.location);
    assert.match(page.body, /id="interview-preparation"/);
    assert.match(page.body, /检索链路/);
    assert.match(page.body, /评估样例/);
    assert.match(page.body, /查询接口/);
    assert.match(page.body, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(page.body, /<script>unsafe\(\)<\/script>/);
    assert.match(page.body, /action="\/api\/interview\/preparation\/save"/);
    assert.match(page.body, /name="storyIds"/);
    const previews = [...page.body.matchAll(/<summary><strong>[^<]+<\/strong><span>([\s\S]*?)<\/span><\/summary>/g)].map(match => match[1]);
    assert.match(previews[0], /^我负责检索链路的实现。 需要处理两种召回结果。 - 我组合了两种召回方式。/,
      'the preview keeps body lines while omitting the recognized standalone headings');
    assert.doesNotMatch(previews[0], /【(?:我负责什么|当时要解决的问题|我做了什么|为什么这样做|结果如何|复盘与启发)】/);
    assert.match(previews[1], /【用户自己的标题】/, 'unknown legacy headings remain in the preview');
    const storyBodies = [...page.body.matchAll(/<(p|div) class="interview-story-text">([\s\S]*?)<\/\1>/g)].map(match => match[2]);
    assert.equal(storyBodies.length, 3, 'each story must render its own readable body');
    assert.deepEqual([...storyBodies[0].matchAll(/<h4>([^<]+)<\/h4>/g)].map(match => match[1]),
      ['我负责什么', '当时要解决的问题', '我做了什么', '为什么这样做', '结果如何', '复盘与启发']);
    assert.equal((storyBodies[0].match(/<section\b/g) || []).length, 6, 'the explicit headings must create semantic sections');
    assert.match(storyBodies[0], /<ul><li>我组合了两种召回方式。<\/li><li>我核对了 &lt;script&gt;unsafe\(\)&lt;\/script&gt; 样例。<\/li><\/ul>/,
      'the two concrete actions must be a list and escape embedded HTML');
    assert.deepEqual([...storyBodies[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map(match => match[1]),
      ['我负责评估样例。\n为什么这样做：这行是旧稿原话。', '【用户自己的标题】\n原文和空行后的内容都要保留。'],
      'legacy paragraphs retain all content without inferring section meaning');
    assert.doesNotMatch(storyBodies[1], /<h4>/);
    const editedStory = structuredStory.replace('我负责检索链路的实现。', '我先比较两种召回，再确定组合方式。');
    const saved = await post('/api/interview/preparation/save', { preparationId, expectedRevision: 1, storyId: 'S1', storyText: editedStory });
    assert.equal(saved.status, 303);
    assert.equal(generations, 1, 'saving an edit must not regenerate the stories');
    const reopened = await request(baseUrl, saved.headers.location);
    assert.match(reopened.body, /我先比较两种召回，再确定组合方式。/);
    const reopenedEditor = reopened.body.match(/<textarea name="storyText"[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
    assert.equal(reopenedEditor, editedStory.replace('<script>unsafe()</script>', '&lt;script&gt;unsafe()&lt;/script&gt;'),
      'formatting must not rewrite the editable text after save and reopen');
    assert.equal(storage.getMockInterviewPreparation(db, { profileId: owner.profileId, planId: owner.planId, preparationId }).stories[0].text,
      editedStory, 'the stored story remains exactly the submitted plain text');
    const refined = await post('/api/interview/preparation/refine', { preparationId, expectedRevision: 2, storyId: 'S1', supplement: '比较了失败查询。', operationId: 'http-story-refine' });
    assert.equal(refined.status, 303);
    const operation = await request(baseUrl, `/api/interview/preparation/operation?planId=${owner.planId}&operationId=http-story-refine`);
    assert.equal(operation.status, 200);
    assert.equal(JSON.parse(operation.body).resultId, preparationId);
    failRefine = true;
    const failed = await post('/api/interview/preparation/refine', { preparationId, expectedRevision: 3, storyId: 'S1', supplement: '失败不得覆盖。', operationId: 'http-failed-refine' });
    assert.equal(failed.status, 500);
    const afterFailure = await request(baseUrl, refined.headers.location);
    assert.match(afterFailure.body, /补充后的故事：比较了失败查询。/);
    assert.match(afterFailure.body, /我负责评估样例/);
    const started = await post('/api/interview/start', { resumeVersionId: owner.resumeVersionId, preparationId, preparationRevision: 3,
      storyIds: 'S1', sessionKind: 'resume_general', type: 'mixed', difficulty: 'standard', plannedQuestions: 3 });
    assert.equal(started.status, 303);
    assert.equal(frozenStory.stories.length, 1);
    assert.equal(frozenStory.stories[0].text, '补充后的故事：比较了失败查询。');
  } finally { await close(server); db.close(); }
}

async function verifyPreparationClientRecovery() {
  const scope = '7:1:91:2:S1';
  const fieldKey = `roleflow:interview-preparation-draft:${scope}:supplement`;
  const values = new Map([[fieldKey, '同一版本尚未提交的补充']]);
  function client({ revisionScope = scope, mode = 'saved' } = {}) {
    const handlers = new Map();
    const inputHandlers = new Map();
    const field = { value: '服务器当前正文', addEventListener(type, fn) { inputHandlers.set(type, fn); } };
    const button = { disabled: false, textContent: '补充并重新整理这一条' };
    const error = { textContent: '' };
    const form = {
      action: '/api/interview/preparation/refine',
      dataset: { interviewDraft: 'preparation', interviewDraftField: 'supplement', interviewDraftScope: revisionScope,
        interviewOperationUrl: '/api/interview/preparation/operation', interviewResultParam: 'preparationId', interviewSuccessTarget: 'interview-preparation' },
      elements: { planId: { value: '1' }, preparationId: { value: '91' }, expectedRevision: { value: revisionScope.split(':')[3] }, storyId: { value: 'S1' }, supplement: field },
      querySelector(selector) {
        if (selector === 'textarea[name="supplement"]') return field;
        if (selector === 'button') return button;
        if (selector === '[data-interview-error]') return error;
        return null;
      },
      addEventListener(type, fn) { handlers.set(type, fn); }
    };
    const requests = [];
    const navigations = [];
    class FormDataFixture {
      constructor(source) { this.source = source; }
      *[Symbol.iterator]() { for (const [name, control] of Object.entries(this.source.elements)) yield [name, control.value]; }
    }
    vm.runInNewContext(MOCK_INTERVIEW_SCRIPT.replace(/^<script>|<\/script>$/g, ''), {
      document: { readyState: 'complete', getElementById() { return null; },
        querySelectorAll(selector) { return selector === '[data-interview-submit]' ? [form] : []; } },
      localStorage: { getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, String(value)); }, removeItem(key) { values.delete(key); } },
      FormData: FormDataFixture, URLSearchParams, setTimeout, console,
      location: { href: 'http://127.0.0.1/interview?planId=1&preparationId=91', hash: '', assign(url) { navigations.push(url); }, reload() {} },
      fetch: async (url, options = {}) => {
        requests.push({ url, method: options.method || 'GET' });
        if (mode === 'unknown') throw Error('network interrupted');
        return { ok: true, async text() { return JSON.stringify({ saved: true, resultId: 91 }); } };
      }
    });
    return { field, button, error, requests, navigations, handlers, inputHandlers };
  }
  const saved = client();
  assert.equal(saved.field.value, '同一版本尚未提交的补充', 'only the matching story revision restores its pending edit');
  await saved.handlers.get('submit')({ preventDefault() {}, submitter: saved.button });
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.requests[0].method, 'GET', 'a saved generation is reopened without another POST or provider call');
  assert.match(saved.navigations[0], /preparationId=91#interview-preparation$/);
  assert.equal(values.has(fieldKey), false, 'completed recovery clears only the submitted draft');
  values.set(fieldKey, '旧版本输入');
  const newer = client({ revisionScope: '7:1:91:3:S1', mode: 'unknown' });
  assert.equal(newer.field.value, '服务器当前正文', 'an old revision must not overwrite a newer saved story');
  newer.field.value = '网络中断后要保留的补充';
  newer.inputHandlers.get('input')();
  await newer.handlers.get('submit')({ preventDefault() {}, submitter: newer.button });
  assert.equal(newer.requests.length, 1);
  assert.equal(newer.requests[0].method, 'GET', 'unknown operation status must not issue a new generation');
  assert.equal(newer.field.value, '网络中断后要保留的补充');
  assert.equal(values.get('roleflow:interview-preparation-draft:7:1:91:3:S1:supplement'), newer.field.value);
  assert([...values.keys()].some(key => key.startsWith('offergo:pending-generation:')), 'unknown outcome keeps the original operation id');
  assert.match(newer.error.textContent, /无法确认/);
  assert.equal(newer.button.disabled, false);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function request(baseUrl, pathname, options = {}) {
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  if (timeout && typeof timeout.unref === "function") timeout.unref();
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method || "GET",
      headers: options.method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
      body: options.body,
      redirect: "manual",
      signal: controller?.signal
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
}

async function interviewDraftClientSmoke(markup) {
  const script = markup.replace(/^<script>|<\/script>$/g, "");
  const handlers = new Map();
  const fieldHandlers = new Map();
  const field = {
    value: "",
    addEventListener(type, handler) { fieldHandlers.set(type, handler); }
  };
  const button = { disabled: false, textContent: "提交回答并继续" };
  const error = { textContent: "" };
  const form = {
    action: "/api/interview/answer",
    dataset: { interviewDraft: "answer", interviewSuccessTarget: "interview-active-step" },
    elements: {
      planId: { value: "1" }, sessionId: { value: "51" }, turnNumber: { value: "2" }, answerText: field
    },
    querySelector(selector) {
      if (selector === 'textarea[name="answerText"]') return field;
      if (selector === "button") return button;
      if (selector === "[data-interview-error]") return error;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(type, handler) { handlers.set(type, handler); }
  };
  const values = new Map([["roleflow:interview-draft:51:2:answer", "刷新后恢复的回答"]]);
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  class FakeFormData {
    constructor(source) { this.source = source; }
    *[Symbol.iterator]() {
      for (const [name, control] of Object.entries(this.source.elements)) yield [name, control.value];
    }
  }
  let response = { ok: false, url: "", async text() { return JSON.stringify({ error: "模型暂时不可用，请稍后重试。" }); } };
  const navigations = [];
  let reloads = 0;
  let revealedTarget = "";
  const activeTarget = { scrollIntoView() { revealedTarget = "interview-active-step"; } };
  const location = {
    href: "http://127.0.0.1/interview?planId=1&sessionId=51#interview-active-step",
    hash: "#interview-active-step",
    assign(url) { navigations.push(url); },
    reload() { reloads += 1; }
  };
  const context = {
    document: {
      readyState: "complete",
      querySelector(selector) { return selector === ".interview-start-form" ? null : null; },
      querySelectorAll(selector) { return selector === "[data-interview-submit]" ? [form] : []; },
      getElementById(id) { return id === "interview-active-step" ? activeTarget : null; }
    },
    localStorage: storage,
    FormData: FakeFormData,
    URLSearchParams,
    fetch: async () => response,
    location,
    setTimeout,
    console
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(revealedTarget, "interview-active-step", "a reloaded interview step must be scrolled into view");
  assert.equal(field.value, "刷新后恢复的回答");
  field.value = "失败后仍要保留的回答";
  fieldHandlers.get("input")();
  assert.equal(values.get("roleflow:interview-draft:51:2:answer"), field.value);
  await handlers.get("submit")({ preventDefault() {}, submitter: button });
  assert.equal(field.value, "失败后仍要保留的回答");
  assert.equal(values.get("roleflow:interview-draft:51:2:answer"), field.value);
  assert.match(error.textContent, /模型暂时不可用/);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "提交回答并继续");

  response = { ok: true, url: "http://127.0.0.1/interview?planId=1&sessionId=51", async text() { return ""; } };
  await handlers.get("submit")({ preventDefault() {}, submitter: button });
  assert.equal(values.has("roleflow:interview-draft:51:2:answer"), false, "successful submission must clear only the submitted local draft");
  assert.deepEqual(navigations, []);
  assert.equal(location.hash, "interview-active-step");
  assert.equal(reloads, 1, "a same-session result must reload so the next question or report replaces the old DOM");
}
