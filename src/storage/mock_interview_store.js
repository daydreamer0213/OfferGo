const crypto = require("node:crypto");
const { nowIso, parseJson, immediateTransaction, storageError } = require("./storage_shared");
const { validateInterviewReport } = require("../core/mock_interview");

function sha256(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex");
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError(`${label} must be a positive integer`);
  return id;
}

function requiredText(value, label, maxLength = 20_000) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function preparationRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    planId: Number(row.plan_id),
    resumeVersionId: Number(row.resume_version_id),
    context: parseJson(row.context_json, {}),
    contextHash: row.context_hash,
    generatedStories: parseJson(row.generated_stories_json, []),
    stories: parseJson(row.stories_json, []),
    revision: Number(row.revision),
    modelIdentity: parseJson(row.model_identity_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function ownedPreparationRow(db, profileId, planId, preparationId) {
  return db.prepare("SELECT * FROM mock_interview_preparations WHERE id = ? AND profile_id = ? AND plan_id = ?")
    .get(positiveId(preparationId, "preparationId"), positiveId(profileId, "profileId"), positiveId(planId, "planId"));
}

function preparationStories(value, context) {
  if (!Array.isArray(value) || !value.length) throw new Error("故事准备稿不能为空");
  const evidenceIds = new Set((context.resumeEvidenceCatalog || []).map(item => item.id));
  const storyIds = new Set();
  const text = (item, label, limit) => {
    if (typeof item !== "string") throw new Error(`${label}格式无效`);
    return requiredText(item, label, limit);
  };
  return value.map(story => {
    if (!story || typeof story !== "object" || Array.isArray(story)) throw new Error("故事格式无效");
    const id = text(story.id, "故事编号", 120);
    if (storyIds.has(id)) throw new Error("故事编号不能重复");
    storyIds.add(id);
    if (!Array.isArray(story.resumeEvidenceIds) || !story.resumeEvidenceIds.length
      || story.resumeEvidenceIds.some(evidenceId => !evidenceIds.has(evidenceId))) {
      throw new Error("故事必须引用冻结简历中的真实证据");
    }
    if (!Array.isArray(story.missingDetails)) throw new Error("故事待补充提示格式无效");
    return {
      id,
      title: text(story.title, "故事标题", 400),
      resumeEvidenceIds: [...new Set(story.resumeEvidenceIds)],
      text: text(story.text, "故事正文", 20_000),
      missingDetails: story.missingDetails.map(item => text(item, "待补充提示", 4_000))
    };
  });
}

function preparationOperationIdentity(value = {}, { required = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("故事整理操作身份格式无效");
  const { operations, ...identity } = value;
  if (required || identity.operationId != null || identity.operationInputHash != null) {
    identity.operationId = requiredText(identity.operationId, "操作编号", 200);
    identity.operationInputHash = requiredText(identity.operationInputHash, "操作输入哈希", 200);
  }
  return identity;
}

function getMockInterviewPreparation(db, { profileId, planId, preparationId }) {
  return preparationRow(ownedPreparationRow(db, profileId, planId, preparationId));
}

function findMockInterviewPreparationOperation(db, { profileId, planId, operationId }) {
  const id = requiredText(operationId, "操作编号", 200);
  const row = db.prepare(`SELECT * FROM mock_interview_preparations
    WHERE profile_id = ? AND plan_id = ? AND (
      json_extract(model_identity_json, '$.operationId') = ? OR EXISTS (
        SELECT 1 FROM json_each(model_identity_json, '$.operations')
        WHERE json_extract(value, '$.operationId') = ?
      )
    ) ORDER BY id DESC LIMIT 1`)
    .get(positiveId(profileId, "profileId"), positiveId(planId, "planId"), id, id);
  const preparation = preparationRow(row);
  if (!preparation) return null;
  const { operations = [], ...createdIdentity } = preparation.modelIdentity;
  const identity = createdIdentity.operationId === id
    ? createdIdentity : operations.find(item => item.operationId === id);
  return { preparation, identity };
}

function assertPreparationOperation(found, identity, preparationId = null) {
  if (found && (found.identity.operationInputHash !== identity.operationInputHash
    || (preparationId !== null && found.preparation.id !== preparationId))) {
    throw storageError("MOCK_INTERVIEW_PREPARATION_OPERATION_CONFLICT", "操作编号已用于其他故事整理请求，请刷新后重试");
  }
}

function createMockInterviewPreparation(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const resumeVersionId = positiveId(input.resumeVersionId, "resumeVersionId");
  if (!input.context || typeof input.context !== "object" || Array.isArray(input.context)) throw new Error("冻结故事上下文格式无效");
  const contextJson = JSON.stringify(input.context);
  const storiesJson = JSON.stringify(preparationStories(input.stories, input.context));
  const modelIdentity = preparationOperationIdentity(input.modelIdentity);
  return immediateTransaction(db, () => {
    const ownedPlan = db.prepare("SELECT id FROM search_plans WHERE id = ? AND profile_id = ?").get(planId, profileId);
    if (!ownedPlan) throw storageError("MOCK_INTERVIEW_PLAN_NOT_FOUND", "筛选方案不存在或不属于当前候选人");
    const ownedResume = db.prepare("SELECT id, is_active FROM candidate_resume_versions WHERE id = ? AND profile_id = ?")
      .get(resumeVersionId, profileId);
    if (!ownedResume) throw storageError("MOCK_INTERVIEW_RESUME_NOT_FOUND", "启用中的简历不存在或不属于当前候选人");
    if (input.context.resume?.versionId != null && Number(input.context.resume.versionId) !== resumeVersionId) {
      throw new Error("故事上下文与简历版本不一致");
    }
    if (modelIdentity.operationId) {
      const found = findMockInterviewPreparationOperation(db, { profileId, planId, operationId: modelIdentity.operationId });
      assertPreparationOperation(found, modelIdentity);
      if (found) return found.preparation;
    }
    if (!ownedResume.is_active) throw storageError("MOCK_INTERVIEW_RESUME_NOT_FOUND", "启用中的简历不存在或不属于当前候选人");
    const now = nowIso();
    const result = db.prepare(`INSERT INTO mock_interview_preparations(
      profile_id, plan_id, resume_version_id, context_hash, context_json,
      generated_stories_json, stories_json, revision, model_identity_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
      profileId, planId, resumeVersionId, sha256(contextJson), contextJson,
      storiesJson, storiesJson, JSON.stringify(modelIdentity), now, now
    );
    return getMockInterviewPreparation(db, { profileId, planId, preparationId: Number(result.lastInsertRowid) });
  });
}

function listMockInterviewPreparations(db, { profileId, planId, resumeVersionId, limit } = {}) {
  const params = [positiveId(profileId, "profileId"), positiveId(planId, "planId")];
  let resumeClause = "";
  if (resumeVersionId !== undefined && resumeVersionId !== null && resumeVersionId !== "") {
    resumeClause = " AND resume_version_id = ?";
    params.push(positiveId(resumeVersionId, "resumeVersionId"));
  }
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 30)));
  return db.prepare(`SELECT * FROM mock_interview_preparations
    WHERE profile_id = ? AND plan_id = ?${resumeClause} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(...params, boundedLimit).map(preparationRow);
}

function updateMockInterviewPreparation(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const preparationId = positiveId(input.preparationId, "preparationId");
  const expectedRevision = positiveId(input.expectedRevision, "expectedRevision");
  const identity = input.operationIdentity == null ? null
    : preparationOperationIdentity(input.operationIdentity, { required: true });
  return immediateTransaction(db, () => {
    const preparation = getMockInterviewPreparation(db, { profileId, planId, preparationId });
    if (!preparation) throw storageError("MOCK_INTERVIEW_PREPARATION_NOT_FOUND", "故事准备稿不存在或不属于当前候选人");
    if (identity) {
      const found = findMockInterviewPreparationOperation(db, { profileId, planId, operationId: identity.operationId });
      assertPreparationOperation(found, identity, preparationId);
      if (found) return found.preparation;
    }
    if (preparation.revision !== expectedRevision) {
      throw storageError("MOCK_INTERVIEW_PREPARATION_REVISION_CONFLICT", "故事准备稿已更新，请刷新后再保存");
    }
    const storiesJson = JSON.stringify(preparationStories(input.stories, preparation.context));
    const modelIdentity = identity ? {
      ...preparation.modelIdentity,
      operations: [...(preparation.modelIdentity.operations || []), identity]
    } : preparation.modelIdentity;
    db.prepare(`UPDATE mock_interview_preparations
      SET stories_json = ?, revision = revision + 1, model_identity_json = ?, updated_at = ?
      WHERE id = ? AND profile_id = ? AND plan_id = ? AND revision = ?`)
      .run(storiesJson, JSON.stringify(modelIdentity), nowIso(), preparationId, profileId, planId, expectedRevision);
    return getMockInterviewPreparation(db, { profileId, planId, preparationId });
  });
}

function questionInput(value = {}) {
  const basedOn = value.basedOnTurnNumber;
  const resumeEvidenceIds = [...new Set((Array.isArray(value.resumeEvidenceIds) ? value.resumeEvidenceIds : [])
    .map((item) => String(item || "").trim()).filter(Boolean))];
  if (resumeEvidenceIds.length < 1 || resumeEvidenceIds.length > 4) {
    throw new Error("问题必须引用 1-4 条简历证据");
  }
  return {
    text: requiredText(value.text, "问题", 4_000),
    questionKind: value.questionKind || 'follow_up',
    focus: requiredText(value.focus, "问题重点", 120),
    resumeEvidenceIds,
    basedOnTurnNumber: basedOn == null || basedOn === "" ? null : Number(basedOn),
    answerEvidence: String(value.answerEvidence || "").trim().slice(0, 300)
  };
}

function retryRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    turnId: Number(row.turn_id),
    turnNumber: Number(row.turn_number),
    retryIndex: Number(row.retry_index),
    answerText: row.answer_text,
    review: parseJson(row.review_json, {}),
    createdAt: row.created_at
  };
}

function turnRow(row, retries = []) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    turnNumber: Number(row.turn_number),
    questionText: row.question_text,
    questionFocus: row.question_focus,
    resumeEvidenceIds: parseJson(row.resume_evidence_ids_json, []),
    basedOnTurnNumber: row.based_on_turn_number == null ? null : Number(row.based_on_turn_number),
    answerEvidence: row.answer_evidence || "",
    answerText: row.answer_text || "",
    answerReview: parseJson(row.answer_review_json, null),
    answeredAt: row.answered_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retries
  };
}

function currentReportCorrection(db, row, turns) {
  if (!row.report_json) return null;
  const events = db.prepare(`SELECT payload_json FROM events
    WHERE event_type = 'mock_interview_report_corrected' AND json_valid(payload_json)
      AND json_extract(payload_json, '$.profileId') = ? AND json_extract(payload_json, '$.planId') = ?
      AND json_extract(payload_json, '$.sessionId') = ? AND json_extract(payload_json, '$.originalReportHash') = ?
    ORDER BY id DESC`).all(Number(row.profile_id), Number(row.plan_id), Number(row.id), sha256(row.report_json));
  for (const event of events) {
    const payload = parseJson(event.payload_json, {});
    try {
      return { note: requiredText(payload.note, "校正说明", 4_000),
        report: validateInterviewReport(payload.report, { turns }) };
    } catch {}
  }
  return null;
}

function sessionRow(db, row) {
  if (!row) return null;
  const rawTurns = db.prepare("SELECT * FROM mock_interview_turns WHERE session_id = ? ORDER BY turn_number, id")
    .all(Number(row.id));
  const rawRetries = db.prepare(`SELECT r.*, t.turn_number
    FROM mock_interview_retries r JOIN mock_interview_turns t ON t.id = r.turn_id
    WHERE r.session_id = ? ORDER BY t.turn_number, r.retry_index, r.id`).all(Number(row.id));
  const retriesByTurnId = new Map();
  for (const retry of rawRetries) {
    const items = retriesByTurnId.get(Number(retry.turn_id)) || [];
    items.push(retryRow(retry));
    retriesByTurnId.set(Number(retry.turn_id), items);
  }
  const turns = rawTurns.map((turn) => turnRow(turn, retriesByTurnId.get(Number(turn.id)) || []));
  const originalReport = parseJson(row.report_json, null);
  const correction = currentReportCorrection(db, row, turns);
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    planId: Number(row.plan_id),
    sessionKind: row.session_kind || "job_specific",
    jobId: row.job_id == null ? null : Number(row.job_id),
    resumeVersionId: Number(row.resume_version_id),
    contextHash: row.context_hash,
    context: parseJson(row.context_json, {}),
    settings: parseJson(row.settings_json, {}),
    status: row.status,
    report: correction?.report || originalReport,
    ...(correction ? { reportCorrection: { note: correction.note, originalReport } } : {}),
    modelIdentity: parseJson(row.model_identity_json, {}),
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turns
  };
}

function ownedSessionRow(db, profileId, planId, sessionId) {
  return db.prepare("SELECT * FROM mock_interview_sessions WHERE id = ? AND profile_id = ? AND plan_id = ?")
    .get(
      positiveId(sessionId, "sessionId"),
      positiveId(profileId, "profileId"),
      positiveId(planId, "planId")
    );
}

function createMockInterviewSession(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const sessionKind = String(input.sessionKind || "").trim();
  if (!["resume_general", "job_specific"].includes(sessionKind)) throw new Error("面试类型无效");
  const jobId = sessionKind === "job_specific" ? positiveId(input.jobId, "jobId") : null;
  if (sessionKind === "resume_general" && input.jobId !== undefined && input.jobId !== null && input.jobId !== "") {
    throw new Error("简历通用面试不能绑定岗位");
  }
  const resumeVersionId = positiveId(input.resumeVersionId, "resumeVersionId");
  const ownedPlan = db.prepare("SELECT id FROM search_plans WHERE id = ? AND profile_id = ?").get(planId, profileId);
  if (!ownedPlan) throw storageError("MOCK_INTERVIEW_PLAN_NOT_FOUND", "筛选方案不存在或不属于当前候选人");
  if (sessionKind === "job_specific") {
    const ownedJob = db.prepare(`SELECT jobs.id FROM jobs
      WHERE jobs.id = ? AND EXISTS (
        SELECT 1 FROM job_observations o JOIN batches b ON b.id = o.batch_id
        WHERE o.job_id = jobs.id AND b.profile_id = ? AND b.search_plan_id = ?
      )`).get(jobId, profileId, planId);
    if (!ownedJob) throw storageError("MOCK_INTERVIEW_JOB_NOT_FOUND", "岗位不存在或不属于当前筛选方案");
  }
  const ownedResume = db.prepare("SELECT id FROM candidate_resume_versions WHERE id = ? AND profile_id = ? AND is_active = 1")
    .get(resumeVersionId, profileId);
  if (!ownedResume) throw storageError("MOCK_INTERVIEW_RESUME_NOT_FOUND", "启用中的简历不存在或不属于当前候选人");
  if (!input.context || typeof input.context !== "object" || Array.isArray(input.context)) throw new Error("冻结面试上下文格式无效");
  if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) throw new Error("面试设置格式无效");
  const initialQuestion = questionInput(input.initialQuestion);
  if (initialQuestion.basedOnTurnNumber !== null || initialQuestion.answerEvidence) throw new Error("首题不能引用上一回答");
  const contextJson = JSON.stringify(input.context);
  return immediateTransaction(db, () => {
    const now = nowIso();
    const result = db.prepare(`INSERT INTO mock_interview_sessions(
      profile_id, plan_id, session_kind, job_id, resume_version_id, context_hash, context_json, settings_json,
      status, report_json, model_identity_json, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, NULL, ?, ?)`).run(
      profileId,
      planId,
      sessionKind,
      jobId,
      resumeVersionId,
      sha256(contextJson),
      contextJson,
      JSON.stringify(input.settings),
      JSON.stringify(input.modelIdentity || {}),
      now,
      now
    );
    const sessionId = Number(result.lastInsertRowid);
    insertQuestionRow(db, sessionId, initialQuestion, now);
    return sessionRow(db, db.prepare("SELECT * FROM mock_interview_sessions WHERE id = ?").get(sessionId));
  });
}

function getMockInterviewSession(db, { profileId, planId, sessionId }) {
  return sessionRow(db, ownedSessionRow(db, profileId, planId, sessionId));
}

function findMockInterviewOperation(db, { profileId, planId, operationId }) {
  const row = db.prepare(`SELECT * FROM mock_interview_sessions WHERE profile_id = ? AND plan_id = ?
    AND json_extract(model_identity_json, '$.operationId') = ? ORDER BY id DESC LIMIT 1`)
    .get(positiveId(profileId, 'profileId'), positiveId(planId, 'planId'), String(operationId));
  return sessionRow(db, row);
}

function listMockInterviewSessions(db, input = {}) {
  const boundedLimit = Math.max(1, Math.min(100, Number(input.limit) || 30));
  const clauses = ["profile_id = ?"];
  const params = [positiveId(input.profileId, "profileId")];
  if (Array.isArray(input.sessionIds)) {
    const ids = [...new Set(input.sessionIds.map(value => positiveId(value, 'sessionId')))];
    if (!ids.length) return [];
    clauses.push(`id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  if (input.planId !== undefined && input.planId !== null && input.planId !== "") {
    clauses.push("plan_id = ?");
    params.push(positiveId(input.planId, "planId"));
  }
  if (input.sessionKind) {
    const sessionKind = String(input.sessionKind).trim();
    if (!["resume_general", "job_specific"].includes(sessionKind)) throw new Error("面试类型无效");
    clauses.push("session_kind = ?");
    params.push(sessionKind);
  }
  return db.prepare(`SELECT * FROM mock_interview_sessions
    WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(...params, boundedLimit)
    .map((row) => sessionRow(db, row));
}

function insertQuestionRow(db, sessionId, question, now = nowIso()) {
  const previous = db.prepare(`SELECT * FROM mock_interview_turns
    WHERE session_id = ? ORDER BY turn_number DESC, id DESC LIMIT 1`).get(sessionId);
  if (previous && !String(previous.answer_text || "").trim()) throw new Error("请先回答当前问题");
  const turnNumber = previous ? Number(previous.turn_number) + 1 : 1;
  const session = db.prepare("SELECT settings_json, context_json FROM mock_interview_sessions WHERE id = ?").get(sessionId);
  const plannedQuestions = Number(parseJson(session?.settings_json, {})?.plannedQuestions);
  if (!Number.isInteger(plannedQuestions) || turnNumber > plannedQuestions) {
    throw new Error("问题数量不能超过本轮计划题数");
  }
  const expectedBasedOn = previous ? Number(previous.turn_number) : null;
  const transition = question.questionKind === 'topic_transition' && parseJson(session?.context_json, {}).interviewBrief;
  if (transition && (question.basedOnTurnNumber !== null || question.answerEvidence)) throw new Error('转换主题不能伪造回答引用');
  if (!transition && question.basedOnTurnNumber !== expectedBasedOn) throw new Error("下一题必须承接上一题");
  if (previous && !transition && (!question.answerEvidence
    || !String(previous.answer_text).includes(question.answerEvidence)
    || (!parseJson(session?.context_json, {}).interviewBrief && !question.text.includes(question.answerEvidence)))) {
    throw new Error("下一题必须包含上一回答的真实片段");
  }
  if (!previous && question.answerEvidence) throw new Error("首题不能包含上一回答片段");
  const result = db.prepare(`INSERT INTO mock_interview_turns(
    session_id, turn_number, question_text, question_focus, resume_evidence_ids_json, based_on_turn_number, answer_evidence,
    answer_text, answer_review_json, answered_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, ?, ?)`).run(
    sessionId,
    turnNumber,
    question.text,
    question.focus,
    JSON.stringify(question.resumeEvidenceIds),
    question.basedOnTurnNumber,
    question.answerEvidence,
    now,
    now
  );
  db.prepare("UPDATE mock_interview_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
  return turnRow(db.prepare("SELECT * FROM mock_interview_turns WHERE id = ?").get(Number(result.lastInsertRowid)));
}

function appendMockInterviewQuestion(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const sessionId = positiveId(input.sessionId, "sessionId");
  const question = questionInput(input.question);
  return immediateTransaction(db, () => {
    const session = ownedSessionRow(db, profileId, planId, sessionId);
    if (!session) throw storageError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (session.status !== "active") throw storageError("MOCK_INTERVIEW_COMPLETED", "面试已经结束");
    return insertQuestionRow(db, sessionId, question);
  });
}

function answerMockInterviewTurn(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const sessionId = positiveId(input.sessionId, "sessionId");
  const turnNumber = positiveId(input.turnNumber, "turnNumber");
  const answerText = requiredText(input.answerText, "回答", 20_000);
  if (!input.answerReview || typeof input.answerReview !== "object") throw new Error("回答复盘格式无效");
  const nextQuestion = input.nextQuestion == null ? null : questionInput(input.nextQuestion);
  return immediateTransaction(db, () => {
    const session = ownedSessionRow(db, profileId, planId, sessionId);
    if (!session) throw storageError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (session.status !== "active") throw storageError("MOCK_INTERVIEW_COMPLETED", "面试已经结束");
    const row = db.prepare("SELECT * FROM mock_interview_turns WHERE session_id = ? AND turn_number = ?")
      .get(sessionId, turnNumber);
    if (!row) throw storageError("MOCK_INTERVIEW_TURN_NOT_FOUND", "面试题不存在");
    if (String(row.answer_text || "").trim()) {
      if (row.answer_text === answerText) return turnRow(row);
      throw storageError("MOCK_INTERVIEW_TURN_ALREADY_ANSWERED", "当前问题已经回答");
    }
    const now = nowIso();
    db.prepare(`UPDATE mock_interview_turns SET answer_text = ?, answer_review_json = ?, answered_at = ?, updated_at = ?
      WHERE id = ?`).run(answerText, JSON.stringify(input.answerReview), now, now, Number(row.id));
    db.prepare("UPDATE mock_interview_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    if (nextQuestion) insertQuestionRow(db, sessionId, nextQuestion, now);
    return turnRow(db.prepare("SELECT * FROM mock_interview_turns WHERE id = ?").get(Number(row.id)));
  });
}

function completeMockInterviewSession(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const sessionId = positiveId(input.sessionId, "sessionId");
  if (!input.report || typeof input.report !== "object" || Array.isArray(input.report)) throw new Error("面试复盘格式无效");
  const reportJson = JSON.stringify(input.report);
  return immediateTransaction(db, () => {
    const row = ownedSessionRow(db, profileId, planId, sessionId);
    if (!row) throw storageError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (row.status === "completed") {
      return sessionRow(db, row);
    }
    const counts = db.prepare(`SELECT count(*) AS total,
      sum(CASE WHEN trim(answer_text) = '' THEN 1 ELSE 0 END) AS unanswered
      FROM mock_interview_turns WHERE session_id = ?`).get(sessionId);
    if (!Number(counts.total)) throw new Error("面试还没有题目");
    if (Number(counts.unanswered)) throw new Error("请先回答当前问题");
    const plannedQuestions = Number(parseJson(row.settings_json, {})?.plannedQuestions);
    if (!Number.isInteger(plannedQuestions) || Number(counts.total) !== plannedQuestions) {
      throw new Error("已回答题数必须等于本轮计划题数");
    }
    const now = nowIso();
    db.prepare(`UPDATE mock_interview_sessions SET status = 'completed', report_json = ?,
      completed_at = ?, updated_at = ? WHERE id = ? AND profile_id = ? AND status = 'active'`)
      .run(reportJson, now, now, sessionId, profileId);
    return sessionRow(db, db.prepare("SELECT * FROM mock_interview_sessions WHERE id = ?").get(sessionId));
  });
}

function correctMockInterviewReport(db, input = {}) {
  return immediateTransaction(db, () => {
    const row = ownedSessionRow(db, input.profileId, input.planId, input.sessionId);
    if (!row) throw storageError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (row.status !== "completed" || !row.report_json) {
      throw storageError("MOCK_INTERVIEW_REPORT_NOT_COMPLETE", "只能校正已完成且已有报告的面试");
    }
    const current = sessionRow(db, row);
    const report = validateInterviewReport(input.report, { turns: current.turns });
    const note = requiredText(input.note, "校正说明", 4_000);
    if (JSON.stringify(report) === JSON.stringify(current.report)) return current;
    if (input.expectedReportHash !== sha256(JSON.stringify(current.report))) {
      throw storageError("MOCK_INTERVIEW_REPORT_CORRECTION_CONFLICT", "复盘已更新，请重新读取后再校正");
    }
    const payload = { profileId: Number(row.profile_id), planId: Number(row.plan_id), sessionId: Number(row.id),
      originalReportHash: sha256(row.report_json), report, note };
    db.prepare("INSERT INTO events(event_type, payload_json, created_at) VALUES ('mock_interview_report_corrected', ?, ?)")
      .run(JSON.stringify(payload), nowIso());
    return sessionRow(db, row);
  });
}

function recordMockInterviewRetry(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const sessionId = positiveId(input.sessionId, "sessionId");
  const turnNumber = positiveId(input.turnNumber, "turnNumber");
  const answerText = requiredText(input.answerText, "重答", 20_000);
  if (!input.review || typeof input.review !== "object" || Array.isArray(input.review)) throw new Error("重答复盘格式无效");
  return immediateTransaction(db, () => {
    const session = ownedSessionRow(db, profileId, planId, sessionId);
    if (!session) throw storageError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (session.status !== "completed") throw new Error("面试结束后才能重练");
    const turn = db.prepare(`SELECT * FROM mock_interview_turns
      WHERE session_id = ? AND turn_number = ? AND trim(answer_text) <> ''`).get(sessionId, turnNumber);
    if (!turn) throw storageError("MOCK_INTERVIEW_TURN_NOT_FOUND", "已回答的面试题不存在");
    const previous = db.prepare(`SELECT r.*, t.turn_number FROM mock_interview_retries r
      JOIN mock_interview_turns t ON t.id = r.turn_id
      WHERE r.session_id = ? AND r.turn_id = ? ORDER BY r.retry_index DESC, r.id DESC LIMIT 1`)
      .get(sessionId, Number(turn.id));
    if (previous && previous.answer_text === answerText) return retryRow(previous);
    const retryIndex = previous ? Number(previous.retry_index) + 1 : 1;
    const now = nowIso();
    const result = db.prepare(`INSERT INTO mock_interview_retries(
      session_id, turn_id, retry_index, answer_text, review_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(
      sessionId, Number(turn.id), retryIndex, answerText, JSON.stringify(input.review), now
    );
    db.prepare("UPDATE mock_interview_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    const row = db.prepare(`SELECT r.*, t.turn_number FROM mock_interview_retries r
      JOIN mock_interview_turns t ON t.id = r.turn_id WHERE r.id = ?`).get(Number(result.lastInsertRowid));
    return retryRow(row);
  });
}

module.exports = {
  createMockInterviewPreparation,
  getMockInterviewPreparation,
  listMockInterviewPreparations,
  updateMockInterviewPreparation,
  findMockInterviewPreparationOperation,
  createMockInterviewSession,
  getMockInterviewSession,
  findMockInterviewOperation,
  listMockInterviewSessions,
  appendMockInterviewQuestion,
  answerMockInterviewTurn,
  completeMockInterviewSession,
  correctMockInterviewReport,
  recordMockInterviewRetry
};
