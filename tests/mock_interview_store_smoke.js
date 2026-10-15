const assert = require("node:assert");
const crypto = require("node:crypto");
const storage = require("../src/core/storage");

function profile(name) {
  return {
    candidate: { name, city: "广州", targetTitles: ["AI 应用工程师"] },
    skills: [{ name: "Node.js" }],
    projects: [{ name: "企业知识库" }]
  };
}

function document(hash, name) {
  const text = `${name}\n参与企业知识库开发\n技能：Node.js`;
  return {
    originalFileName: `${name}.txt`, format: "text", contentHash: hash, text,
    diagnostics: { extractionMethod: "text", inputBytes: Buffer.byteLength(text) }
  };
}

function job(sourceId) {
  return {
    source: "boss", sourceId, keyword: "AI 应用工程师", title: "AI 应用工程师", company: "示例科技",
    location: "广州", salary: "15-25K", experience: "1-3年", education: "本科", bossActiveText: "今日活跃",
    bossActiveDays: 0, url: `https://www.zhipin.com/job_detail/${sourceId}.html`, tags: ["Node.js"],
    description: "负责 Node.js 企业知识库应用开发、检索评估和接口交付，要求具备完整项目经验。",
    score: 18, level: "可投", matches: ["Node.js"], risks: [], qualityTags: [],
    analysis: { provider: "mock", model: "offline", semanticStatus: "complete", recommendation: "apply" }
  };
}

const db = storage.openDb(":memory:");

try {
  const owner = storage.saveProfileAnalysis(db, {
    profile: profile("候选人甲"), document: document("interview-owner", "候选人甲"),
    searchPlan: { name: "Owner", cities: ["广州"], directions: ["AI 应用工程师"], keywords: [{ word: "知识库", priority: "A" }] }
  });
  const other = storage.saveProfileAnalysis(db, {
    profile: profile("候选人乙"), document: document("interview-other", "候选人乙"),
    searchPlan: { name: "Other", cities: ["深圳"], directions: ["后端"], keywords: [{ word: "后端", priority: "A" }] }
  });
  const batch = storage.createBatch(db, "boss", "知识库", "mock interview", {
    profileId: owner.profileId, searchPlanId: owner.planId
  });
  const jobId = storage.upsertJob(db, job("interview-owned"), batch);
  const now = "2026-08-29T08:00:00.000Z";
  const secondOwnerPlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Owner second plan', '{}', NULL, 1, ?, ?)`).run(owner.profileId, now, now).lastInsertRowid);

  assert.throws(() => storage.createMockInterviewSession(db, {
    profileId: other.profileId,
    planId: other.planId,
    sessionKind: "job_specific",
    jobId,
    resumeVersionId: other.resumeVersionId,
    context: { job: { id: jobId }, resume: { text: "其他简历" } },
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 5 },
    initialQuestion: { text: "外部岗位", focus: "intro", resumeEvidenceIds: ["R1"] }
  }), /岗位|不属于|not found/i);

  assert.throws(() => storage.createMockInterviewSession(db, {
    profileId: owner.profileId,
    planId: owner.planId,
    sessionKind: "job_specific",
    jobId: null,
    resumeVersionId: owner.resumeVersionId,
    context: { job: null, resume: { text: "冻结简历正文" } },
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    initialQuestion: { text: "岗位专项题", focus: "intro", resumeEvidenceIds: ["R1"] }
  }), /岗位|positive integer/i);

  assert.throws(() => storage.createMockInterviewSession(db, {
    profileId: other.profileId,
    planId: other.planId,
    sessionKind: "resume_general",
    jobId,
    resumeVersionId: other.resumeVersionId,
    context: { job: null, resume: { text: "其他简历" } },
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    initialQuestion: { text: "通用题", focus: "experience", resumeEvidenceIds: ["R1"] }
  }), /通用|岗位/);

  const frozenContext = {
    job: { id: jobId, title: "AI 应用工程师", company: "示例科技", description: "完整冻结 JD" },
    resume: { versionId: owner.resumeVersionId, text: "冻结简历正文" },
    resumeEvidenceCatalog: [{ id: "R1", kind: "resume", text: "冻结简历正文" }],
    facts: [{ key: "availability", value: "两周到岗" }]
  };
  db.exec(`CREATE TRIGGER fail_initial_interview_question BEFORE INSERT ON mock_interview_turns
    WHEN NEW.question_text = 'forced initial failure'
    BEGIN SELECT RAISE(ABORT, 'forced initial question failure'); END;`);
  assert.throws(() => storage.createMockInterviewSession(db, {
    profileId: owner.profileId,
    planId: owner.planId,
    sessionKind: "job_specific",
    jobId,
    resumeVersionId: owner.resumeVersionId,
    context: frozenContext,
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    initialQuestion: { text: "forced initial failure", focus: "intro", resumeEvidenceIds: ["R1"], basedOnTurnNumber: null, answerEvidence: "" }
  }), /forced initial question failure/);
  db.exec("DROP TRIGGER fail_initial_interview_question");
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM mock_interview_sessions").get().n, 0,
    "failed initial question must roll back the session row");

  const session = storage.createMockInterviewSession(db, {
    profileId: owner.profileId,
    planId: owner.planId,
    sessionKind: "job_specific",
    jobId,
    resumeVersionId: owner.resumeVersionId,
    context: frozenContext,
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    initialQuestion: { text: "请介绍你和该岗位最相关的经历。", focus: "intro", resumeEvidenceIds: ["R1"], basedOnTurnNumber: null, answerEvidence: "" },
    modelIdentity: { provider: "mock", model: "deterministic" }
  });
  assert.strictEqual(session.status, "active");
  assert.strictEqual(session.sessionKind, "job_specific");
  assert.strictEqual(session.jobId, jobId);
  assert.strictEqual(session.planId, owner.planId);
  assert.strictEqual(session.turns.length, 1);
  assert.deepStrictEqual(session.context, frozenContext);
  assert.strictEqual(session.contextHash, crypto.createHash("sha256").update(JSON.stringify(frozenContext)).digest("hex"));
  assert.strictEqual(storage.getMockInterviewSession(db, {
    profileId: other.profileId, planId: other.planId, sessionId: session.id
  }), null);
  assert.strictEqual(storage.getMockInterviewSession(db, {
    profileId: owner.profileId, planId: secondOwnerPlanId, sessionId: session.id
  }), null, "same-profile plans must not share interview sessions");
  assert.strictEqual(storage.listMockInterviewSessions(db, { profileId: other.profileId, planId: other.planId }).length, 0);

  const first = session.turns[0];
  assert.strictEqual(first.turnNumber, 1);
  assert.deepStrictEqual(first.resumeEvidenceIds, ["R1"]);
  assert.throws(() => storage.appendMockInterviewQuestion(db, {
    profileId: owner.profileId, planId: owner.planId,
    sessionId: session.id,
    question: { text: "不能跳过未回答问题", focus: "invalid", resumeEvidenceIds: ["R1"], basedOnTurnNumber: 1, answerEvidence: "" }
  }), /回答/);

  const nextQuestion = {
    text: "你刚才提到“知识库”，具体贡献是什么？",
    focus: "project",
    resumeEvidenceIds: ["R1"],
    basedOnTurnNumber: 1,
    answerEvidence: "知识库"
  };
  db.exec(`CREATE TRIGGER fail_interview_next_question BEFORE INSERT ON mock_interview_turns
    WHEN NEW.session_id = ${session.id} AND NEW.turn_number = 2
    BEGIN SELECT RAISE(ABORT, 'forced next question failure'); END;`);
  assert.throws(() => storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1,
    answerText: "我参与了企业知识库开发。",
    answerReview: { conclusion: "相关", strengths: ["直接"], improvements: ["补充贡献"], turnNumbers: [1] },
    nextQuestion
  }), /forced next question failure/);
  db.exec("DROP TRIGGER fail_interview_next_question");
  let rolledBack = storage.getMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id
  });
  assert.strictEqual(rolledBack.turns.length, 1);
  assert.strictEqual(rolledBack.turns[0].answerText, "", "failed next question must roll back the answer");

  const answered = storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1,
    answerText: "我参与了企业知识库开发。",
    answerReview: { conclusion: "相关", strengths: ["直接"], improvements: ["补充贡献"], turnNumbers: [1] },
    nextQuestion
  });
  assert.strictEqual(answered.answerText, "我参与了企业知识库开发。");
  assert.strictEqual(storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1,
    answerText: "我参与了企业知识库开发。",
    answerReview: answered.answerReview,
    nextQuestion
  }).id, answered.id);
  assert.throws(() => storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1,
    answerText: "迟到的不同回答", answerReview: answered.answerReview
  }), /已经回答/);

  const afterAdvance = storage.getMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id
  });
  const second = afterAdvance.turns[1];
  assert.strictEqual(second.turnNumber, 2);
  assert.strictEqual(second.basedOnTurnNumber, 1);
  assert.strictEqual(second.answerEvidence, "知识库");
  storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 2,
    answerText: "我负责接口联调。",
    answerReview: { conclusion: "清楚", strengths: ["边界明确"], improvements: [], turnNumbers: [2] }
  });
  assert.throws(() => storage.completeMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id,
    report: { conclusion: "提前结束" }
  }), /计划题数/);
  storage.appendMockInterviewQuestion(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id,
    question: {
      text: "你提到“接口”，请说明怎样验证联调结果？",
      focus: "technical",
      resumeEvidenceIds: ["R1"],
      basedOnTurnNumber: 2,
      answerEvidence: "接口"
    }
  });
  storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 3,
    answerText: "我会覆盖正常、异常和超时场景。",
    answerReview: { conclusion: "完整", strengths: ["有边界"], improvements: [], turnNumbers: [3] }
  });
  assert.throws(() => storage.appendMockInterviewQuestion(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id,
    question: {
      text: "你提到“超时”，再说明一个场景。",
      focus: "technical",
      resumeEvidenceIds: ["R1"],
      basedOnTurnNumber: 3,
      answerEvidence: "超时"
    }
  }), /计划题数/);

  const report = {
    conclusion: "项目相关性较好。", strengths: ["直接"], improvements: ["补充结果"],
    followUpRisks: [{ turnNumber: 2, reason: "结果不足" }],
    retryRecommendations: [{ turnNumber: 2, reason: "补充结果" }],
    answerStructures: [{ turnNumber: 2, outline: ["背景", "行动", "结果"] }]
  };
  db.exec(`CREATE TRIGGER fail_interview_report BEFORE UPDATE OF report_json ON mock_interview_sessions
    WHEN NEW.id = ${session.id} BEGIN SELECT RAISE(ABORT, 'forced report failure'); END;`);
  assert.throws(() => storage.completeMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, report
  }), /forced report failure/);
  db.exec("DROP TRIGGER fail_interview_report");
  assert.strictEqual(storage.getMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id
  }).status, "active");

  const completed = storage.completeMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, report
  });
  assert.strictEqual(completed.status, "completed");
  assert.deepStrictEqual(completed.report, report);
  assert.strictEqual(storage.completeMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, report
  }).id, session.id);
  assert.throws(() => storage.appendMockInterviewQuestion(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id,
    question: { text: "迟到问题", focus: "invalid", resumeEvidenceIds: ["R1"], basedOnTurnNumber: 2, answerEvidence: "接口" }
  }), /结束/);

  assert.throws(() => storage.recordMockInterviewRetry(db, {
    profileId: other.profileId, planId: other.planId, sessionId: session.id, turnNumber: 2,
    answerText: "越权重答", review: { turnNumber: 2 }
  }), /不存在|not found/i);
  const retry = storage.recordMockInterviewRetry(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 2,
    answerText: "我负责接口联调，并完成三个接口验收。",
    review: { turnNumber: 2, conclusion: "更具体", improved: true, strengths: ["有结果"], remainingImprovements: [] }
  });
  assert.strictEqual(retry.retryIndex, 1);
  const loaded = storage.getMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id
  });
  assert.strictEqual(loaded.turns.length, 3);
  assert.strictEqual(loaded.turns[1].retries.length, 1);

  const generalContext = {
    sessionKind: "resume_general",
    job: null,
    resume: { versionId: owner.resumeVersionId, text: "参与企业知识库开发" },
    resumeEvidenceCatalog: [{ id: "R1", kind: "resume", text: "参与企业知识库开发" }]
  };
  const general = storage.createMockInterviewSession(db, {
    profileId: owner.profileId,
    planId: owner.planId,
    sessionKind: "resume_general",
    jobId: null,
    resumeVersionId: owner.resumeVersionId,
    context: generalContext,
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    initialQuestion: {
      text: "简历中写到企业知识库，请介绍这段经历。",
      focus: "experience",
      resumeEvidenceIds: ["R1"],
      basedOnTurnNumber: null,
      answerEvidence: ""
    }
  });
  assert.strictEqual(general.sessionKind, "resume_general");
  assert.strictEqual(general.jobId, null);
  assert.deepStrictEqual(general.turns[0].resumeEvidenceIds, ["R1"]);

  storage.createMockInterviewSession(db, {
    profileId: owner.profileId,
    planId: secondOwnerPlanId,
    sessionKind: "resume_general",
    jobId: null,
    resumeVersionId: owner.resumeVersionId,
    context: generalContext,
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    initialQuestion: {
      text: "请梳理知识库经历。", focus: "experience", resumeEvidenceIds: ["R1"],
      basedOnTurnNumber: null, answerEvidence: ""
    }
  });
  const profileWideGeneral = storage.listMockInterviewSessions(db, {
    profileId: owner.profileId,
    sessionKind: "resume_general"
  });
  assert.strictEqual(profileWideGeneral.length, 2);
  assert(profileWideGeneral.every((item) => item.sessionKind === "resume_general"));

  const preparationContext = {
    sessionKind: "resume_general", job: null,
    resume: { versionId: owner.resumeVersionId, text: "参与企业知识库开发；负责接口联调" },
    resumeEvidenceCatalog: [
      { id: "R1", kind: "resume", text: "参与企业知识库开发" },
      { id: "R2", kind: "resume", text: "负责接口联调" }
    ]
  };
  const stories = [
    { id: "S1", title: "知识库开发", resumeEvidenceIds: ["R1"], text: "我参与企业知识库开发，承担检索接口实现。", missingDetails: ["如何选择检索方案？"] },
    { id: "S2", title: "接口联调", resumeEvidenceIds: ["R2"], text: "我负责接口联调，与前端核对接口约定。", missingDetails: [] }
  ];
  const createInput = {
    profileId: owner.profileId, planId: owner.planId, resumeVersionId: owner.resumeVersionId,
    context: preparationContext, stories,
    modelIdentity: { provider: "mock", model: "offline", operationId: "prepare-1", operationInputHash: "prepare-input-1" }
  };
  const sessionsBeforePreparation = db.prepare("SELECT count(*) AS n FROM mock_interview_sessions").get().n;
  const preparation = storage.createMockInterviewPreparation(db, createInput);
  assert.strictEqual(preparation.profileId, owner.profileId);
  assert.strictEqual(preparation.planId, owner.planId);
  assert.strictEqual(preparation.resumeVersionId, owner.resumeVersionId);
  assert.strictEqual(preparation.revision, 1);
  assert.deepStrictEqual(preparation.context, preparationContext);
  assert.strictEqual(preparation.contextHash, crypto.createHash("sha256").update(JSON.stringify(preparationContext)).digest("hex"));
  assert.deepStrictEqual(preparation.stories, stories);
  assert.deepStrictEqual(preparation.generatedStories, stories);
  assert(preparation.createdAt && preparation.updatedAt);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM mock_interview_sessions").get().n, sessionsBeforePreparation,
    "preparing stories must not create an interview session");
  assert.strictEqual(storage.createMockInterviewPreparation(db, createInput).id, preparation.id);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM mock_interview_preparations").get().n, 1,
    "retrying the same generation must read the stored preparation");
  assert.throws(() => storage.createMockInterviewPreparation(db, {
    ...createInput, modelIdentity: { ...createInput.modelIdentity, operationInputHash: "changed-input" }
  }), error => error.code === "MOCK_INTERVIEW_PREPARATION_OPERATION_CONFLICT");

  for (const scope of [
    { profileId: other.profileId, planId: other.planId },
    { profileId: owner.profileId, planId: secondOwnerPlanId }
  ]) {
    assert.strictEqual(storage.getMockInterviewPreparation(db, { ...scope, preparationId: preparation.id }), null);
    assert.strictEqual(storage.findMockInterviewPreparationOperation(db, { ...scope, operationId: "prepare-1" }), null);
    assert.deepStrictEqual(storage.listMockInterviewPreparations(db, scope), []);
    assert.throws(() => storage.updateMockInterviewPreparation(db, {
      ...scope, preparationId: preparation.id, expectedRevision: 1, stories
    }), error => error.code === "MOCK_INTERVIEW_PREPARATION_NOT_FOUND");
  }
  assert.throws(() => storage.createMockInterviewPreparation(db, {
    ...createInput, planId: other.planId
  }), error => error.code === "MOCK_INTERVIEW_PLAN_NOT_FOUND");
  assert.throws(() => storage.createMockInterviewPreparation(db, {
    ...createInput, resumeVersionId: other.resumeVersionId
  }), error => error.code === "MOCK_INTERVIEW_RESUME_NOT_FOUND");
  assert.throws(() => storage.createMockInterviewPreparation(db, {
    ...createInput, modelIdentity: {}, stories: [{ ...stories[0], resumeEvidenceIds: ["R999"] }]
  }), /依据|证据/);
  assert.throws(() => storage.createMockInterviewPreparation(db, {
    ...createInput, modelIdentity: {}, context: { ...preparationContext, resume: { versionId: other.resumeVersionId } }
  }), /简历|版本/);

  const editInput = {
    profileId: owner.profileId, planId: owner.planId, preparationId: preparation.id,
    expectedRevision: 1, stories: [{ ...stories[0], text: "我补充了自己负责的检索接口实现和选择原因。" }, stories[1]]
  };
  const edited = storage.updateMockInterviewPreparation(db, editInput);
  assert.strictEqual(edited.revision, 2);
  assert.deepStrictEqual(edited.stories, editInput.stories);
  assert.deepStrictEqual(edited.generatedStories, stories);
  assert.deepStrictEqual(edited.context, preparationContext);
  assert.deepStrictEqual(edited.modelIdentity, preparation.modelIdentity);
  assert.throws(() => storage.updateMockInterviewPreparation(db, {
    ...editInput, stories: [{ ...stories[0], text: "旧页面覆盖" }, stories[1]]
  }), error => error.code === "MOCK_INTERVIEW_PREPARATION_REVISION_CONFLICT");
  assert.throws(() => storage.updateMockInterviewPreparation(db, {
    ...editInput, expectedRevision: 2, stories: [{ ...stories[0], resumeEvidenceIds: ["R999"] }, stories[1]]
  }), /依据|证据/);

  const refineIdentity = { provider: "mock", model: "offline", operationId: "refine-1", operationInputHash: "refine-input-1" };
  const refinedStories = [{ ...editInput.stories[0], text: "补充实际情境后重新整理的知识库故事。" }, stories[1]];
  const refineInput = { ...editInput, expectedRevision: 2, stories: refinedStories, operationIdentity: refineIdentity };
  const refined = storage.updateMockInterviewPreparation(db, refineInput);
  assert.strictEqual(refined.revision, 3);
  assert.deepStrictEqual(refined.stories, refinedStories);
  assert.deepStrictEqual(refined.generatedStories, stories);
  assert.deepStrictEqual(refined.modelIdentity.operations, [refineIdentity]);
  assert.strictEqual(storage.updateMockInterviewPreparation(db, refineInput).revision, 3,
    "retrying an already saved refinement must not increment its revision");
  assert.throws(() => storage.updateMockInterviewPreparation(db, {
    ...refineInput, operationIdentity: { ...refineIdentity, operationInputHash: "changed-refine-input" }
  }), error => error.code === "MOCK_INTERVIEW_PREPARATION_OPERATION_CONFLICT");
  const secondRefineIdentity = { ...refineIdentity, operationId: "refine-2", operationInputHash: "refine-input-2" };
  storage.updateMockInterviewPreparation(db, {
    ...refineInput, expectedRevision: 3, operationIdentity: secondRefineIdentity
  });
  const saved = storage.updateMockInterviewPreparation(db, { ...editInput, expectedRevision: 4, stories: refinedStories });
  assert.strictEqual(saved.revision, 5);
  assert.deepStrictEqual(saved.modelIdentity.operations, [refineIdentity, secondRefineIdentity]);
  for (const identity of [createInput.modelIdentity, refineIdentity, secondRefineIdentity]) {
    const found = storage.findMockInterviewPreparationOperation(db, {
      profileId: owner.profileId, planId: owner.planId, operationId: identity.operationId
    });
    assert.strictEqual(found.preparation.id, preparation.id);
    assert.strictEqual(found.preparation.revision, 5);
    assert.deepStrictEqual(found.identity, identity);
  }

  db.exec(`CREATE TRIGGER fail_story_update BEFORE UPDATE OF stories_json ON mock_interview_preparations
    BEGIN SELECT RAISE(ABORT, 'forced preparation update failure'); END;`);
  assert.throws(() => storage.updateMockInterviewPreparation(db, {
    ...editInput, expectedRevision: 5, operationIdentity: { ...refineIdentity, operationId: "failed-refine" }
  }), /forced preparation update failure/);
  db.exec("DROP TRIGGER fail_story_update");
  assert.deepStrictEqual(storage.getMockInterviewPreparation(db, {
    profileId: owner.profileId, planId: owner.planId, preparationId: preparation.id
  }), saved, "a failed write must preserve stories, revision, context and operation history");
  assert.strictEqual(storage.findMockInterviewPreparationOperation(db, {
    profileId: owner.profileId, planId: owner.planId, operationId: "failed-refine"
  }), null);

  db.prepare("UPDATE candidate_resume_versions SET is_active = 0 WHERE id = ?").run(owner.resumeVersionId);
  assert.throws(() => storage.createMockInterviewPreparation(db, {
    ...createInput, modelIdentity: { ...createInput.modelIdentity, operationId: "inactive-create" }
  }), error => error.code === "MOCK_INTERVIEW_RESUME_NOT_FOUND");
  assert.strictEqual(storage.getMockInterviewPreparation(db, {
    profileId: owner.profileId, planId: owner.planId, preparationId: preparation.id
  }).id, preparation.id, "old resume preparations remain readable");
  assert.strictEqual(storage.updateMockInterviewPreparation(db, { ...editInput, expectedRevision: 5 }).revision, 6,
    "ownership and revision protect updates even after a resume is deactivated");
  const recoveredCreation = storage.createMockInterviewPreparation(db, createInput);
  assert.strictEqual(recoveredCreation.id, preparation.id);
  assert.strictEqual(recoveredCreation.revision, 6,
    "an already completed creation can be recovered after a resume change without replacing later edits");
  assert.deepStrictEqual(recoveredCreation.stories, editInput.stories);
  assert.strictEqual(storage.listMockInterviewPreparations(db, {
    profileId: owner.profileId, planId: owner.planId, resumeVersionId: owner.resumeVersionId
  }).length, 1);
  assert.deepStrictEqual(storage.listMockInterviewPreparations(db, {
    profileId: owner.profileId, planId: owner.planId, resumeVersionId: other.resumeVersionId
  }), []);

  console.log("mock_interview_store_smoke ok");
} finally {
  db.close();
}
