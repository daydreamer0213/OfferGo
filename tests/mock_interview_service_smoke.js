const assert = require("node:assert");
const { createHash } = require("node:crypto");
const storage = require("../src/core/storage");
const { createMockInterviewService } = require("../src/application/mock_interview");
const { projectInterviewFacts } = require("../src/core/mock_interview");

function profile(name) {
  return {
    candidate: { name, city: "广州", targetTitles: ["AI 应用工程师"] },
    skills: [{ name: "Node.js" }],
    projects: [{ name: "企业知识库", canSay: ["参与知识库开发"] }]
  };
}

function document(hash) {
  const text = "个人总结\n参与企业知识库开发\n技能：Node.js";
  return {
    originalFileName: "candidate.txt", format: "text", contentHash: hash, text,
    diagnostics: { extractionMethod: "text", inputBytes: Buffer.byteLength(text) }
  };
}

function job(sourceId) {
  return {
    source: "boss", sourceId, keyword: "AI 应用工程师", title: "AI 应用工程师", company: "示例科技",
    location: "广州", salary: "15-25K", experience: "1-3年", education: "本科", bossActiveText: "今日活跃",
    bossActiveDays: 0, url: `https://www.zhipin.com/job_detail/${sourceId}.html`, tags: ["Node.js", "知识库"],
    description: "负责 Node.js 企业知识库应用开发、检索评估和接口交付，要求具备完整项目经验。",
    score: 18, level: "可投", matches: ["Node.js"], risks: [], qualityTags: [],
    analysis: { provider: "mock", model: "offline", semanticStatus: "complete", recommendation: "apply" }
  };
}

function seedAnswerMemory(db, fixture, {
  key,
  scope,
  finalText,
  factKey,
  factValue,
  completedAt
}) {
  const [draft] = storage.recordMessageReplyDrafts(db, {
    profileId: fixture.profileId,
    cardId: fixture.cardId,
    jobId: fixture.jobId,
    messageGroupKey: `sha256:${createHash("sha256").update(key).digest("hex")}`,
    questionSummary: `测试问题 ${key}`,
    messageIntent: "interview_context",
    messageCategory: "other",
    messages: [`模型原稿 ${key}`],
    createdAt: completedAt
  });
  return storage.completeMessageReplyDraft(db, {
    profileId: fixture.profileId,
    draftId: draft.id,
    finalText,
    changedText: finalText,
    completionKind: "copied",
    scope,
    extractedFacts: [{ factKey, factValue, evidenceText: finalText }],
    completedAt
  });
}

function seedCompletedHistory(db, {
  profileId,
  planId,
  sessionKind,
  jobId = null,
  resumeVersionId,
  weakness,
  createdAt
}) {
  const context = { sessionKind, job: jobId ? { id: jobId } : null, resume: { versionId: resumeVersionId, text: "历史简历" } };
  const contextJson = JSON.stringify(context);
  return Number(db.prepare(`INSERT INTO mock_interview_sessions(
    profile_id, plan_id, session_kind, job_id, resume_version_id, context_hash, context_json, settings_json,
    status, report_json, model_identity_json, completed_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, '{}', ?, ?, ?)`).run(
    profileId,
    planId,
    sessionKind,
    jobId,
    resumeVersionId,
    createHash("sha256").update(contextJson).digest("hex"),
    contextJson,
    JSON.stringify({ type: "mixed", difficulty: "standard", plannedQuestions: 3 }),
    JSON.stringify({ improvements: [weakness], retryRecommendations: [] }),
    createdAt,
    createdAt,
    createdAt
  ).lastInsertRowid);
}

const db = storage.openDb(":memory:");

(async () => {
  try {
    const owner = storage.saveProfileAnalysis(db, {
      profile: profile("候选人甲"), document: document("interview-service-resume"),
      searchPlan: { name: "Owner", cities: ["广州"], directions: ["AI 应用工程师"], keywords: [{ word: "知识库", priority: "A" }] }
    });
    const batch = storage.createBatch(db, "boss", "知识库", "mock interview service", {
      profileId: owner.profileId, searchPlanId: owner.planId
    });
    const jobId = storage.upsertJob(db, job("interview-service-owned"), batch);
    const now = "2026-08-29T08:00:00.000Z";
    const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(
      profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'boss', 'reply_ready', '处理草稿', ?, ?, ?)`).run(
      owner.profileId, owner.planId, jobId, now, now, now
    ).lastInsertRowid);
    const memoryFixture = { profileId: owner.profileId, cardId, jobId };
    const globalMemory = seedAnswerMemory(db, memoryFixture, {
      key: "global", scope: { kind: "global", key: "" },
      finalText: "通用回答：我可以在两周内到岗。", factKey: "availability", factValue: "两周内",
      completedAt: "2026-08-29T08:01:00.000Z"
    });
    const experienceMemory = seedAnswerMemory(db, memoryFixture, {
      key: "experience", scope: { kind: "experience", key: "知识库项目" },
      finalText: "经验回答：我负责知识库接口联调。", factKey: "project_role", factValue: "接口联调",
      completedAt: "2026-08-29T08:02:00.000Z"
    });
    seedAnswerMemory(db, memoryFixture, {
      key: "job", scope: { kind: "job", key: String(jobId) },
      finalText: `仅适用于岗位 ${jobId} 的回答。`, factKey: "job_only", factValue: `岗位 ${jobId}`,
      completedAt: "2026-08-29T08:03:00.000Z"
    });
    seedAnswerMemory(db, memoryFixture, {
      key: "company", scope: { kind: "company", key: "示例科技" },
      finalText: "仅适用于某公司的回答。", factKey: "company_only", factValue: "某公司",
      completedAt: "2026-08-29T08:04:00.000Z"
    });
    db.prepare(`INSERT INTO candidate_fact_revisions(
      profile_id, fact_key, fact_value, operation, source,
      answer_memory_id, evidence_text, withdrawn_at, created_at
    ) VALUES (?, 'direct_preference', '不接受夜班', 'set', 'user_provided', NULL, '', NULL, ?)`)
      .run(owner.profileId, "2026-08-29T08:05:00.000Z");

    assert.deepStrictEqual(projectInterviewFacts({
      factRevisions: [
        { id: 1, factKey: "direct", factValue: "保留", operation: "set", source: "user", answerMemoryId: null, createdAt: "2026-08-29T08:00:00.000Z" },
        { id: 2, factKey: "global_fact", factValue: "保留", operation: "set", source: "reply", answerMemoryId: globalMemory.id, createdAt: "2026-08-29T08:01:00.000Z" },
        { id: 3, factKey: "experience_fact", factValue: "保留", operation: "set", source: "reply", answerMemoryId: experienceMemory.id, createdAt: "2026-08-29T08:02:00.000Z" },
        { id: 4, factKey: "deleted", factValue: "", operation: "delete", source: "user", answerMemoryId: null, createdAt: "2026-08-29T08:03:00.000Z" },
        { id: 5, factKey: "withdrawn", factValue: "丢弃", operation: "set", source: "reply", answerMemoryId: globalMemory.id, withdrawnAt: "2026-08-29T08:04:00.000Z", createdAt: "2026-08-29T08:04:00.000Z" }
      ],
      answerMemories: [globalMemory, experienceMemory],
      allowedScopeKinds: ["global", "experience"]
    }), [
      { factKey: "direct", factValue: "保留", source: "user" },
      { factKey: "experience_fact", factValue: "保留", source: "reply" },
      { factKey: "global_fact", factValue: "保留", source: "reply" }
    ]);

    const factCount = db.prepare("SELECT count(*) AS n FROM candidate_facts WHERE profile_id = ?").get(owner.profileId).n;
    const memoryCount = db.prepare("SELECT count(*) AS n FROM candidate_answer_memories WHERE profile_id = ?").get(owner.profileId).n;

    const calls = [];
    let invalidStep = false;
    let prematureComplete = false;
    let failReport = false;
    let failStep = false;
    const adapter = {
      provider: "scripted",
      model: "interview-service-test",
      async generateMockInterviewStep(input) {
        calls.push({ kind: "step", input: JSON.parse(JSON.stringify(input)) });
        if (failStep) throw new Error("forced step failure");
        const turns = input.turns || [];
        const resumeEvidence = input.context.resumeEvidenceCatalog[0];
        if (!turns.length) {
          return {
            answerReview: null,
            nextQuestion: {
              text: input.context.sessionKind === "resume_general"
                ? `请结合简历中的“${resumeEvidence.text}”介绍你自己。`
                : `请结合目标岗位和简历中的“${resumeEvidence.text}”介绍你自己。`,
              focus: "intro",
              resumeEvidenceIds: [resumeEvidence.id],
              basedOnTurnNumber: null
            },
            complete: false
          };
        }
        const last = turns[turns.length - 1];
        if (prematureComplete) {
          return {
            answerReview: { conclusion: "收到", strengths: [], improvements: [], turnNumbers: [last.turnNumber] },
            nextQuestion: null,
            complete: true
          };
        }
        if (invalidStep) {
          return {
            answerReview: { conclusion: "收到", strengths: [], improvements: [], turnNumbers: [last.turnNumber] },
            nextQuestion: { text: "错误追问", focus: "invalid", resumeEvidenceIds: [resumeEvidence.id], basedOnTurnNumber: null },
            complete: false
          };
        }
        return {
          answerReview: {
            conclusion: `已复盘第 ${last.turnNumber} 题`,
            strengths: ["回答直接"], improvements: ["补充结果"], turnNumbers: [last.turnNumber]
          },
          nextQuestion: turns.length >= input.settings.plannedQuestions ? null : {
            text: `你刚才回答“${last.answer}”，请继续说明个人贡献。`,
            focus: "project",
            resumeEvidenceIds: [resumeEvidence.id],
            basedOnTurnNumber: last.turnNumber,
            answerEvidence: last.answer
          },
          complete: turns.length >= input.settings.plannedQuestions
        };
      },
      async reviewMockInterview(input) {
        calls.push({ kind: "report", input: JSON.parse(JSON.stringify(input)) });
        if (failReport) throw new Error("forced report failure");
        return {
          conclusion: "岗位动机清楚，项目贡献需要更具体。",
          strengths: ["回答直接", "岗位相关"], improvements: ["补充结果"],
          followUpRisks: [{ turnNumber: 2, reason: "结果不够具体" }],
          retryRecommendations: [{ turnNumber: 2, reason: "使用行动和结果重答" }],
          answerStructures: [{ turnNumber: 2, outline: ["背景", "行动", "结果"] }]
        };
      },
      async reviewMockInterviewRetry(input) {
        calls.push({ kind: "retry", input: JSON.parse(JSON.stringify(input)) });
        return {
          turnNumber: input.turn.turnNumber,
          conclusion: "新回答更具体。", improved: true,
          strengths: ["补充了行动"], remainingImprovements: ["结果可再明确"]
        };
      }
    };
    const service = createMockInterviewService({ db, adapter });
    const otherPlanId = Number(db.prepare(`INSERT INTO search_plans(
      profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
    ) VALUES (?, '同候选人其他方案', '{}', NULL, 1, ?, ?)`).run(owner.profileId, now, now).lastInsertRowid);
    seedCompletedHistory(db, {
      profileId: owner.profileId,
      planId: otherPlanId,
      sessionKind: "resume_general",
      resumeVersionId: owner.resumeVersionId,
      weakness: "跨方案通用弱点：项目结果需要量化",
      createdAt: "2026-08-29T08:06:00.000Z"
    });
    seedCompletedHistory(db, {
      profileId: owner.profileId,
      planId: owner.planId,
      sessionKind: "job_specific",
      jobId,
      resumeVersionId: owner.resumeVersionId,
      weakness: "岗位专用弱点不能进入通用训练",
      createdAt: "2026-08-29T08:07:00.000Z"
    });

    db.prepare("UPDATE candidate_resume_versions SET is_active = 0 WHERE id = ?").run(owner.resumeVersionId);
    await assert.rejects(() => service.startSession({
      profileId: owner.profileId,
      planId: owner.planId,
      resumeVersionId: owner.resumeVersionId,
      settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 }
    }), /启用|简历/);
    db.prepare("UPDATE candidate_resume_versions SET is_active = 1 WHERE id = ?").run(owner.resumeVersionId);

    const sessionsBeforeFailedStart = db.prepare("SELECT count(*) AS n FROM mock_interview_sessions").get().n;
    failStep = true;
    await assert.rejects(() => service.startSession({
      profileId: owner.profileId,
      planId: owner.planId,
      resumeVersionId: owner.resumeVersionId,
      settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 }
    }), /forced step failure/);
    failStep = false;
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM mock_interview_sessions").get().n, sessionsBeforeFailedStart,
      "failed first model step must not create a session");

    const session = await service.startSession({
      profileId: owner.profileId,
      planId: owner.planId,
      resumeVersionId: owner.resumeVersionId,
      settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 }
    });
    assert.strictEqual(session.turns.length, 1);
    assert.strictEqual(session.sessionKind, "resume_general");
    assert.strictEqual(session.jobId, null);
    const generalStartCall = calls.filter((call) => call.kind === "step").at(-1);
    const generalContext = generalStartCall.input.context;
    assert.strictEqual(generalContext.sessionKind, "resume_general");
    assert.strictEqual(generalContext.job, null);
    assert(generalContext.resume.text.includes("参与企业知识库开发"));
    assert(generalContext.resumeEvidenceCatalog.length > 0);
    assert(generalContext.answerMemories.every((item) => ["global", "experience"].includes(item.scope.kind)));
    assert.deepStrictEqual(generalContext.answerMemories.map((item) => item.scope.kind).sort(), ["experience", "global"]);
    assert(generalContext.candidateFacts.some((item) => item.factKey === "direct_preference"));
    assert(generalContext.candidateFacts.some((item) => item.factKey === "availability"));
    assert(generalContext.candidateFacts.some((item) => item.factKey === "project_role"));
    assert(!generalContext.candidateFacts.some((item) => ["job_only", "company_only"].includes(item.factKey)));
    assert(generalContext.priorWeaknesses.includes("跨方案通用弱点：项目结果需要量化"));
    assert(!generalContext.priorWeaknesses.includes("岗位专用弱点不能进入通用训练"));
    assert(!JSON.stringify(generalContext).includes("仅适用于某公司"));
    assert(!JSON.stringify(generalContext).includes(`仅适用于岗位 ${jobId}`));

    const storedContext = JSON.parse(db.prepare("SELECT context_json FROM mock_interview_sessions WHERE id = ?").get(session.id).context_json);
    delete storedContext.resumeEvidenceCatalog;
    const legacyContextJson = JSON.stringify(storedContext);
    const legacyContextHash = createHash("sha256").update(legacyContextJson).digest("hex");
    db.prepare("UPDATE mock_interview_sessions SET context_json = ?, context_hash = ? WHERE id = ?")
      .run(legacyContextJson, legacyContextHash, session.id);
    assert(service.getSession({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id })
      .context.resumeEvidenceCatalog.length > 0, "legacy active context must derive resume evidence in memory");
    const rawLegacyRow = db.prepare("SELECT context_json, context_hash FROM mock_interview_sessions WHERE id = ?").get(session.id);
    assert.strictEqual(rawLegacyRow.context_hash, legacyContextHash);
    assert.strictEqual(Object.hasOwn(JSON.parse(rawLegacyRow.context_json), "resumeEvidenceCatalog"), false,
      "legacy context derivation must not rewrite frozen storage");

    assert.strictEqual(service.getSession({
      profileId: owner.profileId, planId: otherPlanId, sessionId: session.id
    }), null, "same-profile plans must not share interview sessions");
    const stepCallsBeforeWrongPlan = calls.filter((call) => call.kind === "step").length;
    await assert.rejects(() => service.answerTurn({
      profileId: owner.profileId, planId: otherPlanId, sessionId: session.id, turnNumber: 1, answerText: "错误方案回答"
    }), /会话不存在/);
    assert.strictEqual(calls.filter((call) => call.kind === "step").length, stepCallsBeforeWrongPlan);

    const firstAnswer = "我参与了企业知识库开发，负责接口联调。";
    const afterFirst = await service.answerTurn({
      profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1, answerText: firstAnswer
    });
    assert.strictEqual(afterFirst.turns.length, 2);
    const secondStepCall = calls.filter((call) => call.kind === "step").at(-1);
    assert.strictEqual(secondStepCall.input.turns.at(-1).answer, firstAnswer);
    assert.strictEqual(secondStepCall.input.context.job, null);
    assert(secondStepCall.input.context.resumeEvidenceCatalog.length > 0);
    const stepCallsBeforeReplay = calls.filter((call) => call.kind === "step").length;
    const replayedFirst = await service.answerTurn({
      profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1, answerText: firstAnswer
    });
    assert.strictEqual(replayedFirst.turns.length, 2, "identical answer replay must be idempotent");
    assert.strictEqual(calls.filter((call) => call.kind === "step").length, stepCallsBeforeReplay,
      "identical answer replay must not call the model again");

    failStep = true;
    await assert.rejects(() => service.answerTurn({
      profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 2, answerText: "第二题回答"
    }), /forced step failure/);
    failStep = false;
    let loaded = service.getSession({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id });
    assert.strictEqual(loaded.turns[0].answerText, firstAnswer, "later model failure must preserve prior answers");
    assert.strictEqual(loaded.turns[1].answerText, "", "failed follow-up must not partially save the new answer");

    prematureComplete = true;
    await assert.rejects(() => service.answerTurn({
      profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 2, answerText: "第二题回答"
    }), /计划题数/);
    prematureComplete = false;
    loaded = service.getSession({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id });
    assert.strictEqual(loaded.turns[1].answerText, "", "early model completion must not strand an unfinished session");

    invalidStep = true;
    const callsBeforeInvalidStep = calls.filter(call => call.kind === 'step').length;
    await assert.rejects(() => service.answerTurn({
      profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 2, answerText: "第二题回答"
    }), /上一题|追问/);
    loaded = service.getSession({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id });
    assert.strictEqual(loaded.turns.length, 2, "invalid model output must not advance the session");
    assert.strictEqual(loaded.turns[1].answerText, "", "invalid model output must not partially save the current answer");
    assert.strictEqual(loaded.turns[0].answerText, firstAnswer, "prior completed answers must remain saved");
    assert.strictEqual(calls.filter(call => call.kind === 'step').length, callsBeforeInvalidStep + 1,
      'unrelated validation failure must not be retried');

    invalidStep = false;
    await service.answerTurn({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 2, answerText: "第二题回答" });
    await service.answerTurn({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 3, answerText: "第三题回答" });
    failReport = true;
    await assert.rejects(() => service.finishSession({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id }), /forced report failure/);
    loaded = service.getSession({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id });
    assert.strictEqual(loaded.status, "active");
    assert.strictEqual(loaded.turns.filter((turn) => turn.answerText).length, 3);

    failReport = false;
    const reportCallsBeforeConcurrentFinish = calls.filter((call) => call.kind === "report").length;
    const [completed, concurrentReplay] = await Promise.all([
      service.finishSession({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id }),
      service.finishSession({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id })
    ]);
    assert.strictEqual(completed.status, "completed");
    assert.strictEqual(concurrentReplay.id, completed.id);
    assert.strictEqual(calls.filter((call) => call.kind === "report").length, reportCallsBeforeConcurrentFinish + 1,
      "concurrent finish replay must share one model call");
    assert.strictEqual(completed.report.retryRecommendations[0].turnNumber, 2);
    const reportCallsBeforeReplay = calls.filter((call) => call.kind === "report").length;
    assert.strictEqual((await service.finishSession({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id })).id, session.id);
    assert.strictEqual(calls.filter((call) => call.kind === "report").length, reportCallsBeforeReplay,
      "completed finish replay must not call the model again");
    const retried = await service.retryTurn({
      profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 2,
      answerText: "第二题重答：我负责接口联调并完成验收。"
    });
    assert.strictEqual(retried.review.improved, true);
    const retryCallsBeforeReplay = calls.filter((call) => call.kind === "retry").length;
    assert.strictEqual((await service.retryTurn({
      profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 2,
      answerText: "第二题重答：我负责接口联调并完成验收。"
    })).id, retried.id);
    assert.strictEqual(calls.filter((call) => call.kind === "retry").length, retryCallsBeforeReplay,
      "identical retry replay must not call the model again");

    const jobSpecific = await service.startSession({
      profileId: owner.profileId,
      planId: owner.planId,
      sessionKind: "job_specific",
      jobId,
      resumeVersionId: owner.resumeVersionId,
      settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 }
    });
    assert.strictEqual(jobSpecific.sessionKind, "job_specific");
    assert.strictEqual(jobSpecific.jobId, jobId);
    const jobContext = calls.filter((call) => call.kind === "step").at(-1).input.context;
    assert(jobContext.job.description.includes("检索评估"));
    assert(jobContext.answerMemories.some((item) => item.scope.kind === "job"));
    assert(jobContext.answerMemories.some((item) => item.scope.kind === "company"));
    assert(jobContext.candidateFacts.some((item) => item.factKey === "job_only"));
    assert(jobContext.candidateFacts.some((item) => item.factKey === "company_only"));
    assert(jobContext.priorWeaknesses.includes("岗位专用弱点不能进入通用训练"));
    assert(!jobContext.priorWeaknesses.includes("跨方案通用弱点：项目结果需要量化"));
    const otherJobId = storage.upsertJob(db, { ...job('scope-other-job'), company: '另一家公司' }, batch);
    const scopeService = createMockInterviewService({ db, adapter: { async generateMockInterviewStep(input) {
      assert(!input.context.candidateFacts.some(item => ['job_only', 'company_only'].includes(item.factKey)), 'another job interview must not borrow original job/company conditions');
      assert(input.context.candidateFacts.some(item => item.factKey === 'direct_preference'));
      throw new Error('SCOPED_CONTEXT_VERIFIED');
    } } });
    await assert.rejects(scopeService.startSession({ profileId: owner.profileId, planId: owner.planId,
      sessionKind: 'job_specific', jobId: otherJobId, resumeVersionId: owner.resumeVersionId, settings: { plannedQuestions: 3 }
    }), /SCOPED_CONTEXT_VERIFIED/);

    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candidate_facts WHERE profile_id = ?").get(owner.profileId).n, factCount);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candidate_answer_memories WHERE profile_id = ?").get(owner.profileId).n, memoryCount);
    assert.strictEqual(service.listSessions({ profileId: owner.profileId, planId: owner.planId }).length, 3);

    const newerCompletedId = seedCompletedHistory(db, {
      profileId: owner.profileId,
      planId: owner.planId,
      sessionKind: "resume_general",
      resumeVersionId: owner.resumeVersionId,
      weakness: "较新的历史训练",
      createdAt: "2099-01-01T00:00:00.000Z"
    });
    assert.strictEqual(service.dashboard({ profileId: owner.profileId, planId: owner.planId }).selectedSession.id,
      jobSpecific.id, "打开面试页时应优先继续未完成的训练");
    assert.strictEqual(service.dashboard({ profileId: owner.profileId, planId: owner.planId,
      sessionId: newerCompletedId }).selectedSession.id, newerCompletedId,
    "主动查看历史训练时必须保留用户选择");

    // Regeneration must occur before persistence: one answer and one next turn are saved.
    for (const problem of ['repeat', 'logistics']) {
      const regenerationInputs = [];
      const regeneratedService = createMockInterviewService({ db, adapter: { ...adapter,
        async generateMockInterviewStep(input) {
          const raw = await adapter.generateMockInterviewStep(input);
          if (!input.turns.length) return raw;
          regenerationInputs.push(JSON.parse(JSON.stringify(input)));
          if (!input.questionRevision) {
            raw.nextQuestion = { questionKind: 'topic_transition', focus: 'project',
              resumeEvidenceIds: [input.context.resumeEvidenceCatalog[0].id], basedOnTurnNumber: null,
              text: problem === 'repeat' ? input.turns[0].question : '你的期望薪资是多少？' };
          }
          return raw;
        }
      } });
      const fresh = await regeneratedService.startSession({ profileId: owner.profileId, planId: owner.planId,
        resumeVersionId: owner.resumeVersionId, settings: { plannedQuestions: 3 } });
      const accepted = await regeneratedService.answerTurn({ profileId: owner.profileId, planId: owner.planId,
        sessionId: fresh.id, turnNumber: 1, answerText: firstAnswer });
      assert.strictEqual(regenerationInputs.length, 2, 'content error receives only one targeted regeneration');
      assert.strictEqual(regenerationInputs[1].questionRevision.reason,
        problem === 'repeat' ? 'MOCK_INTERVIEW_REPEATED_QUESTION' : 'MOCK_INTERVIEW_LOGISTICS_QUESTION');
      assert(regenerationInputs[1].questionRevision.avoidQuestions.includes(
        problem === 'repeat' ? fresh.turns[0].questionText : '你的期望薪资是多少？'));
      assert.deepStrictEqual(regenerationInputs[1].turns, regenerationInputs[0].turns, 'regeneration preserves original answers');
      assert.deepStrictEqual(regenerationInputs[1].progress.askedQuestions, [fresh.turns[0].questionText]);
      assert.strictEqual(accepted.turns.length, 2);
      assert.strictEqual(accepted.turns.filter(turn => turn.answerText).length, 1);
      assert.strictEqual(accepted.turns[0].answerText, firstAnswer);
      assert.strictEqual(accepted.turns[1].answerText, '');
      const replayed = await regeneratedService.answerTurn({ profileId: owner.profileId, planId: owner.planId,
        sessionId: fresh.id, turnNumber: 1, answerText: firstAnswer });
      assert.strictEqual(replayed.turns.length, 2);
      assert.strictEqual(regenerationInputs.length, 2, 'accepted regeneration replay does not persist or regenerate again');
    }

    let repeatedAttempts = 0;
    const rejectingService = createMockInterviewService({ db, adapter: { ...adapter,
      async generateMockInterviewStep(input) {
        const raw = await adapter.generateMockInterviewStep(input);
        if (!input.turns.length) return raw;
        repeatedAttempts += 1;
        raw.nextQuestion = { questionKind: 'topic_transition', focus: 'intro',
          resumeEvidenceIds: [input.context.resumeEvidenceCatalog[0].id], basedOnTurnNumber: null,
          text: input.turns[0].question };
        return raw;
      }
    } });
    const rejected = await rejectingService.startSession({ profileId: owner.profileId, planId: owner.planId,
      resumeVersionId: owner.resumeVersionId, settings: { plannedQuestions: 3 } });
    await assert.rejects(() => rejectingService.answerTurn({ profileId: owner.profileId, planId: owner.planId,
      sessionId: rejected.id, turnNumber: 1, answerText: firstAnswer }),
    error => error.code === 'MOCK_INTERVIEW_REPEATED_QUESTION');
    assert.strictEqual(repeatedAttempts, 2, 'rejected content regeneration must stop after one retry');
    const rejectedStored = rejectingService.getSession({ profileId: owner.profileId, planId: owner.planId, sessionId: rejected.id });
    assert.strictEqual(rejectedStored.turns.length, 1);
    assert.strictEqual(rejectedStored.turns[0].answerText, '', 'neither failed attempt partially persists the answer');

    const attemptsBeforeUnrelatedFailure = calls.filter(call => call.kind === 'step').length;
    failStep = true;
    await assert.rejects(() => service.answerTurn({ profileId: owner.profileId, planId: owner.planId,
      sessionId: rejected.id, turnNumber: 1, answerText: firstAnswer }), /forced step failure/);
    failStep = false;
    assert.strictEqual(calls.filter(call => call.kind === 'step').length, attemptsBeforeUnrelatedFailure + 1,
      'unrelated adapter failure must not be retried');

    let openingAttempts = 0;
    const openingService = createMockInterviewService({ db, adapter: { ...adapter,
      async generateMockInterviewStep(input) {
        openingAttempts += 1;
        const raw = await adapter.generateMockInterviewStep(input);
        if (!input.questionRevision) raw.nextQuestion.text = '你什么时候能到岗？';
        return raw;
      }
    } });
    const beforeOpening = db.prepare('SELECT count(*) AS n FROM mock_interview_sessions').get().n;
    const revisedOpening = await openingService.startSession({ profileId: owner.profileId, planId: owner.planId,
      resumeVersionId: owner.resumeVersionId, settings: { plannedQuestions: 3 } });
    assert.strictEqual(openingAttempts, 2);
    assert.strictEqual(revisedOpening.turns.length, 1);
    assert(revisedOpening.turns[0].questionText.includes('介绍你自己'));
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM mock_interview_sessions').get().n, beforeOpening + 1,
      'regenerating the initial question creates only one session');

    // The resume/JD stay frozen, while the next model call uses live confirmed supplements.
    const evidenceStore = require('../src/storage/candidate_evidence_store');
    const liveEntry = evidenceStore.saveCandidateEvidence(db, { profileId: owner.profileId,
      subject: '知识库排障', text: '通过日志定位知识库接口超时', sourceKind: 'manual',
      sourceId: 'live-context', sourceItemKey: 'old', sourceQuote: '通过日志定位知识库接口超时', scope: { kind: 'global', key: '' } });
    const live = await service.startSession({ profileId: owner.profileId, planId: owner.planId,
      resumeVersionId: owner.resumeVersionId, sessionKind: 'job_specific', jobId, settings: { plannedQuestions: 3 } });
    const frozenRow = db.prepare('SELECT context_json FROM mock_interview_sessions WHERE id = ?').get(live.id).context_json;
    assert(live.context.candidateEvidence.some(item => item.id === liveEntry.id));
    evidenceStore.withdrawCandidateEvidence(db, { profileId: owner.profileId, id: liveEntry.id });
    storage.withdrawCandidateAnswerMemory(db, { profileId: owner.profileId, memoryId: globalMemory.id });
    const newestEntry = evidenceStore.saveCandidateEvidence(db, { profileId: owner.profileId,
      subject: '知识库排障', text: '通过日志发现重试导致接口超时', sourceKind: 'manual',
      sourceId: 'live-context', sourceItemKey: 'new', sourceQuote: '通过日志发现重试导致接口超时', scope: { kind: 'global', key: '' } });
    storage.saveCandidateFact(db, { profileId: owner.profileId, factKey: 'direct_preference', factValue: '接受白班' });
    const liveInput = { profileId: owner.profileId, planId: owner.planId, sessionId: live.id };
    for (const turnNumber of [1, 2, 3]) await service.answerTurn({ ...liveInput, turnNumber, answerText: `第${turnNumber}题：参与排查接口超时` });
    await service.finishSession(liveInput);
    await service.retryTurn({ ...liveInput, turnNumber: 2, answerText: '进一步说明日志排查过程' });
    const currentInputs = calls.filter(call => (call.kind === 'step' && call.input.turns.length && call.input.turns[0].answer.startsWith('第1题'))
      || (['report', 'retry'].includes(call.kind) && call.input.context.candidateEvidence.some(item => item.id === newestEntry.id)));
    assert.strictEqual(currentInputs.length, 5, 'next questions, final report and retry must all refresh supplements');
    for (const { input } of currentInputs) {
      assert(!input.context.candidateEvidence.some(item => item.id === liveEntry.id));
      assert(input.context.candidateEvidence.some(item => item.id === newestEntry.id));
      assert(!input.context.answerMemories.some(item => item.id === globalMemory.id));
      assert.strictEqual(input.context.candidateFacts.find(item => item.factKey === 'direct_preference').factValue, '接受白班');
      assert.deepStrictEqual(input.context.resume, live.context.resume);
      assert.deepStrictEqual(input.context.job, live.context.job);
      assert(!JSON.stringify(input.context.interviewBrief).includes('通过日志定位知识库接口超时'));
    }
    assert.strictEqual(db.prepare('SELECT context_json FROM mock_interview_sessions WHERE id = ?').get(live.id).context_json, frozenRow);
    console.log("mock_interview_service_smoke ok");
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
