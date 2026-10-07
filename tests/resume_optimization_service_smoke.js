const assert = require("node:assert");
const storage = require("../src/core/storage");
const { createResumeOptimizationService } = require("../src/application/resume_optimization");
const { MockModelAdapter } = require("../src/adapters/models/mock");

function profile(name) {
  return {
    candidate: { name, city: "广州", targetTitles: ["AI 应用工程师"] },
    skills: [{ name: "Node.js" }],
    projects: [{ name: "企业知识库", canSay: ["参与知识库开发"] }]
  };
}

function document(hash, name) {
  const text = `${name}\n个人总结\n参与企业知识库开发\n技能：Node.js\n手机号 13800138000\n邮箱 ${name === "候选人甲" ? "owner" : "other"}@example.com`;
  return {
    originalFileName: `${name}.txt`,
    format: "text",
    contentHash: hash,
    text,
    diagnostics: { extractionMethod: "text", inputBytes: Buffer.byteLength(text) }
  };
}

function job(sourceId, overrides = {}) {
  return {
    source: "boss",
    sourceId,
    keyword: "AI 应用工程师",
    title: "AI 应用工程师",
    company: "示例科技",
    location: "广州",
    salary: "15-25K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Node.js", "知识库"],
    description: "负责 Node.js 企业知识库应用开发、检索评估和接口交付，要求具备完整项目经验。",
    score: 18,
    level: "可投",
    matches: ["Node.js"],
    risks: [],
    qualityTags: [],
    analysis: {
      provider: "mock",
      model: "offline",
      semanticStatus: "complete",
      recommendation: "apply",
      evidence: { jd: ["JD：负责 Node.js 企业知识库应用开发"], resume: ["简历：参与企业知识库开发"] }
    },
    ...overrides
  };
}

const db = storage.openDb(":memory:");

(async () => {
try {
  const owner = storage.saveProfileAnalysis(db, {
    profile: profile("候选人甲"),
    document: document("resume-owner", "候选人甲"),
    searchPlan: { name: "Owner plan", cities: ["广州"], directions: ["AI 应用工程师"], keywords: [{ word: "知识库", priority: "A" }] }
  });
  const other = storage.saveProfileAnalysis(db, {
    profile: profile("候选人乙"),
    document: document("resume-other", "候选人乙"),
    searchPlan: { name: "Other plan", cities: ["深圳"], directions: ["后端工程师"], keywords: [{ word: "后端", priority: "A" }] }
  });
  const ownerBatch = storage.createBatch(db, "boss", "知识库", "resume optimization service", {
    profileId: owner.profileId,
    searchPlanId: owner.planId
  });
  const validJobId = storage.upsertJob(db, job("resume-service-valid"), ownerBatch);
  const representativeJobIds = [validJobId];
  for (const [index, company] of ["示例科技", "甲公司", "乙公司", "丙公司", "丁公司"].entries()) {
    representativeJobIds.push(storage.upsertJob(db, job(`resume-service-${index + 2}`, {
      company,
      analysis: {
        ...job("analysis-template").analysis,
        recommendation: index === 0 ? "primary" : index === 1 ? "caution" : "apply",
        realRoleType: "AI 应用工程师",
        businessScenario: `企业知识库场景 ${index + 2}`
      }
    }), ownerBatch));
  }
  const incompleteJobId = storage.upsertJob(db, job("resume-service-incomplete", {
    description: "",
    analysis: { semanticStatus: "failed", errorCode: "MODEL_TIMEOUT" }
  }), ownerBatch);

  storage.saveCandidateFact(db, {
    profileId: owner.profileId,
    factKey: "availability",
    factValue: "两周内到岗",
    source: "user_provided"
  });
  const now = new Date().toISOString();
  const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', 'reply_ready', '处理草稿', ?, ?, ?)`)
    .run(owner.profileId, owner.planId, validJobId, now, now, now).lastInsertRowid);
  const [replyDraft] = storage.recordMessageReplyDrafts(db, {
    profileId: owner.profileId,
    cardId,
    jobId: validJobId,
    messageGroupKey: `sha256:${require("node:crypto").createHash("sha256").update("resume-service-memory").digest("hex")}`,
    questionSummary: "到岗时间",
    messageIntent: "availability",
    messageCategory: "basic",
    messages: ["一个月内可以到岗"],
    createdAt: now
  });
  storage.completeMessageReplyDraft(db, {
    profileId: owner.profileId,
    draftId: replyDraft.id,
    finalText: "两周内可以到岗",
    changedText: "两周内可以到岗",
    completionKind: "copied",
    scope: { kind: "global", key: "" },
    extractedFacts: [],
    completedAt: now
  });

  const calls = [];
  const adapter = {
    provider: "scripted",
    model: "resume-test",
    async generateResumeOptimization(input) {
      calls.push(input);
      return {
        headline: "突出知识库项目与 Node.js 技术栈",
        suggestions: [{
          id: "S1",
          operation: "replace",
          originalText: "参与企业知识库开发",
          proposedText: "参与 Node.js 企业知识库开发",
          reason: "补充简历中已有且岗位需要的技术栈",
          evidenceIds: ["R3", "R4", "J1"],
          editingPrinciple: "jd_vocabulary"
        }]
      };
    }
  };
  const service = createResumeOptimizationService({ db, adapter });
  const preview = service.dashboard({ profileId: owner.profileId, planId: owner.planId });
  const previewJobs = preview.sampleJobsByDirection["AI 应用工程师"];
  assert(previewJobs.length >= 3 && previewJobs.length <= 5);
  assert(previewJobs.every((item) => item.id && item.title && item.company));

  assert.rejects(() => service.createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    targetDirection: "后端工程师"
  }), (error) => error.code === "RESUME_OPTIMIZATION_DIRECTION_NOT_OWNED");
  assert.rejects(() => service.createDraft({
    profileId: other.profileId,
    planId: other.planId,
    sourceResumeVersionId: other.resumeVersionId,
    targetDirection: "后端工程师"
  }), (error) => error.code === "RESUME_OPTIMIZATION_NO_COMPLETE_JD");

  const rowsBeforeMalformed = db.prepare("SELECT count(*) AS n FROM resume_optimizations").get().n;
  const malformedService = createResumeOptimizationService({
    db,
    adapter: {
      provider: "scripted",
      model: "malformed",
      async generateResumeOptimization() {
        return { headline: "错误", suggestions: [{
          id: "S1",
          operation: "replace",
          originalText: "不存在的原文",
          proposedText: "改写",
          reason: "错误",
          evidenceIds: ["R1"],
          editingPrinciple: "concision"
        }] };
      }
    }
  });
  await assert.rejects(() => malformedService.createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    targetDirection: "AI 应用工程师"
  }), /原文/);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM resume_optimizations").get().n, rowsBeforeMalformed);

  const unchangedService = createResumeOptimizationService({ db, adapter: {
    async generateResumeOptimization() { return { headline: '现稿已清楚，无需修改', suggestions: [] }; }
  } });
  for (const mode of ['general', 'job_specific']) {
    const unchanged = await unchangedService.createDraft({ profileId: owner.profileId, planId: owner.planId,
      sourceResumeVersionId: owner.resumeVersionId, mode, jobId: mode === 'job_specific' ? validJobId : undefined });
    assert.deepStrictEqual(unchanged.changeLedger, []);
    assert.strictEqual(unchanged.finalText, document('resume-owner', '候选人甲').text);
    const savedUnchanged = unchangedService.saveDraft({ profileId: owner.profileId, planId: owner.planId,
      draftId: unchanged.id, finalText: unchanged.finalText });
    assert.strictEqual(savedUnchanged.integrity.valid, true);
    assert.strictEqual(unchangedService.activateDraft({ profileId: owner.profileId, planId: owner.planId,
      draftId: unchanged.id, finalText: unchanged.finalText }).status, 'activated');
    assert.strictEqual(require('../src/storage/candidate_store').getCandidateResumeDocument(db,
      { profileId: owner.profileId, resumeVersionId: owner.resumeVersionId }).text, document('resume-owner', '候选人甲').text);
  }

  const descriptiveIdsService = createResumeOptimizationService({ db, adapter: {
    async generateResumeOptimization() {
      return { headline: "展开已有工作与技能", suggestions: [
        { id: "workorder-detail", operation: "replace", originalText: "参与企业知识库开发",
          proposedText: "参与 Node.js 企业知识库开发", reason: "补充已有技能",
          evidenceIds: ["R3", "R4"], editingPrinciple: "contribution_clarity" },
        { id: "workorder-detail", operation: "replace", originalText: "技能:Node.js",
          proposedText: "技能：Node.js；用于企业知识库开发", reason: "关联实际项目",
          evidenceIds: ["R3", "R4"], editingPrinciple: "contribution_clarity" }
      ] };
    }
  } });
  const descriptiveDraft = await descriptiveIdsService.createDraft({
    profileId: owner.profileId, planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId, mode: "general"
  });
  assert.deepStrictEqual(descriptiveDraft.suggestions.map(item => item.id), ["S1", "S2"]);
  assert.match(descriptiveDraft.finalText, /参与 Node\.js 企业知识库开发/);
  const unsupportedNumberService = createResumeOptimizationService({ db, adapter: {
    async generateResumeOptimization() {
      return { suggestions: [{ id: "project-detail", operation: "replace",
        originalText: "参与企业知识库开发", proposedText: "参与企业知识库开发，效率提升99%",
        reason: "没有依据的效果", evidenceIds: ["R3"], editingPrinciple: "result_visibility" }] };
    }
  } });
  const rowsBeforeUnsupported = db.prepare("SELECT count(*) AS n FROM resume_optimizations").get().n;
  await assert.rejects(() => unsupportedNumberService.createDraft({
    profileId: owner.profileId, planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId, mode: "general"
  }), /没有证据支持的数字/);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM resume_optimizations").get().n, rowsBeforeUnsupported);

  const draft = await service.createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    targetDirection: "AI 应用工程师"
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].sourceResume.id, owner.resumeVersionId);
  assert(calls[0].sourceResume.text.includes("参与企业知识库开发"));
  assert(!calls[0].sourceResume.text.includes("候选人甲"), "model input must redact the candidate identity");
  assert(draft.targetJobIds.length >= 3 && draft.targetJobIds.length <= 5);
  assert.deepStrictEqual(previewJobs.map((item) => item.id).sort((a, b) => a - b),
    [...draft.targetJobIds].sort((a, b) => a - b),
    "生成前显示的参考岗位应与实际用于生成的岗位一致");
  assert(!draft.targetJobIds.includes(incompleteJobId));
  const selectedJobs = calls[0].jobs;
  assert.strictEqual(new Set(selectedJobs.map((item) => item.company)).size, selectedJobs.length);
  assert(selectedJobs.every((item) => representativeJobIds.includes(item.id)));
  assert(selectedJobs.every((item) => item.description === job("expected").description));
  assert(selectedJobs.every((item) => item.analysis.semanticStatus === "complete"));
  assert(calls[0].evidenceCatalog.some((item) => item.kind === "fact" && item.text.includes("两周内到岗")));
  assert(calls[0].evidenceCatalog.some((item) => item.kind === "answer" && item.text.includes("两周内可以到岗")));
  assert.strictEqual(draft.targetDirection, "AI 应用工程师");
  assert.match(draft.generatedText, /Node\.js 企业知识库/);
  assert.strictEqual(draft.finalText, draft.generatedText);
  assert.strictEqual(draft.changeLedger[0].editingPrinciple, "jd_vocabulary");
  assert.strictEqual(draft.suggestions[0].decision, "accepted");
  assert.strictEqual(draft.modelIdentity.provider, "scripted");

  const otherOwnerPlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, is_active, created_at, updated_at
  ) VALUES (?, 'Owner second plan', ?, 0, ?, ?)`)
    .run(owner.profileId, JSON.stringify({ directions: ["AI 应用工程师"] }), now, now).lastInsertRowid);
  assert.throws(() => service.saveDraft({
    profileId: owner.profileId,
    planId: otherOwnerPlanId,
    draftId: draft.id,
    finalText: `${draft.finalText}\n越权修改`
  }), (error) => error.code === "RESUME_OPTIMIZATION_PLAN_MISMATCH");

  const nearlyUnchanged = service.saveDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    draftId: draft.id,
    finalText: document("resume-owner", "候选人甲").text
  });
  assert.equal(nearlyUnchanged.integrity.valid, true);
  assert(nearlyUnchanged.integrity.warnings.some((item) => item.code === "RESUME_NEARLY_UNCHANGED"));
  const draftDashboard = service.dashboard({ profileId: owner.profileId, planId: owner.planId, draftId: draft.id });
  assert.equal(draftDashboard.selectedIntegrity.valid, true);
  assert(draftDashboard.selectedIntegrity.warnings.some((item) => item.code === "RESUME_NEARLY_UNCHANGED"));

  const saved = service.saveDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    draftId: draft.id,
    finalText: `${draft.finalText}\n用户补充：已校对`
  });
  assert(saved.finalText.includes("用户补充：已校对"));
  assert(!saved.finalText.includes("参与企业知识库开发"));

  const versionsBeforeFailure = storage.listCandidateResumeVersions(db, owner.profileId).length;
  const roundsBeforeFailure = storage.listFunnelStrategyRounds(db, {
    profileId: owner.profileId,
    planId: owner.planId
  }).length;
  assert.throws(() => service.activateDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    draftId: draft.id,
    finalText: saved.finalText.replace("13800138000", "13900139000")
  }), (error) => error.code === "RESUME_ACTIVATION_INTEGRITY_FAILED"
    && error.issues.some((item) => item.code === "RESUME_CONTACT_REMOVED"));
  assert.strictEqual(storage.listCandidateResumeVersions(db, owner.profileId).length, versionsBeforeFailure);
  assert.strictEqual(storage.listFunnelStrategyRounds(db, {
    profileId: owner.profileId,
    planId: owner.planId
  }).length, roundsBeforeFailure);

  assert.throws(() => service.activateDraft({
    profileId: owner.profileId,
    planId: otherOwnerPlanId,
    draftId: draft.id,
    finalText: saved.finalText
  }), (error) => error.code === "RESUME_OPTIMIZATION_PLAN_MISMATCH");
  assert.strictEqual(storage.listCandidateResumeVersions(db, owner.profileId).length, versionsBeforeFailure);
  assert.strictEqual(storage.listFunnelStrategyRounds(db, {
    profileId: owner.profileId,
    planId: otherOwnerPlanId
  }).length, 0);

  const activated = service.activateDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    draftId: draft.id,
    finalText: saved.finalText
  });
  assert.strictEqual(activated.status, "activated");
  assert(storage.listCandidateResumeVersions(db, owner.profileId).some((version) => version.id === activated.resultResumeVersionId));
  const activatedVersion = storage.listCandidateResumeVersions(db, owner.profileId)
    .find((version) => version.id === activated.resultResumeVersionId);
  assert.strictEqual(activatedVersion.name, "AI 应用工程师定向版");
  assert.deepStrictEqual(activatedVersion.targetRoles, ["AI 应用工程师"]);
  const modelCallsBeforeCopy = calls.length;
  const copyInput = { profileId: owner.profileId, planId: owner.planId, draftId: draft.id };
  const editableCopy = service.copyDraft(copyInput);
  assert.notStrictEqual(editableCopy.id, draft.id);
  assert.strictEqual(editableCopy.status, 'draft');
  assert.strictEqual(editableCopy.finalText, saved.finalText, 'copy must include edits made before activation');
  assert.strictEqual(editableCopy.generatedText, draft.generatedText, 'copy retains the generation baseline and evidence');
  assert.deepStrictEqual(editableCopy.targetJobIds, draft.targetJobIds);
  assert.strictEqual(service.copyDraft(copyInput).id, editableCopy.id, 'repeat click returns the existing editable copy');
  for (let index = 0; index < 101; index++) require('../src/storage/resume_optimization_store').createResumeOptimization(db, {
    ...draft, headline: '其他历史草稿', generatedText: draft.generatedText
  });
  assert.strictEqual(service.copyDraft(copyInput).id, editableCopy.id, 'an existing copy must not disappear behind the history display limit');
  service.saveDraft({ ...copyInput, draftId: editableCopy.id, finalText: saved.finalText + '\n继续校对' });
  assert.strictEqual(service.getDraft(copyInput).finalText, saved.finalText, 'editing the copy preserves the enabled snapshot');
  assert.strictEqual(calls.length, modelCallsBeforeCopy, 'continuing edits does not regenerate through the model');
  assert.throws(() => service.copyDraft({ ...copyInput, profileId: other.profileId }),
    error => error.code === 'RESUME_OPTIMIZATION_NOT_FOUND');
  assert.throws(() => service.copyDraft({ ...copyInput, planId: otherOwnerPlanId }),
    error => error.code === 'RESUME_OPTIMIZATION_PLAN_MISMATCH');
  const strategyRound = storage.getActiveFunnelStrategyRound(db, {
    profileId: owner.profileId,
    planId: owner.planId
  });
  assert.strictEqual(activated.strategyRoundId, strategyRound.id);
  assert.strictEqual(strategyRound.sourceKey, `resume_optimization:${draft.id}`);
  assert.strictEqual(storage.listCandidateResumeVersions(db, owner.profileId).length, versionsBeforeFailure + 1);
  assert.strictEqual(storage.listFunnelStrategyRounds(db, {
    profileId: owner.profileId,
    planId: owner.planId
  }).length, roundsBeforeFailure + 1);

  const dashboard = service.dashboard({ profileId: owner.profileId, planId: owner.planId, draftId: draft.id });
  assert.strictEqual(dashboard.selectedDraft.id, draft.id);
  assert(dashboard.resumes.some((resume) => resume.id === activated.resultResumeVersionId));
  assert(dashboard.jobs.some((item) => item.id === validJobId));
  assert(!dashboard.jobs.some((item) => item.id === incompleteJobId));
  assert.deepStrictEqual(dashboard.directions, ["AI 应用工程师"]);
  assert.deepStrictEqual(new Set(dashboard.selectedJobs.map((item) => item.id)), new Set(draft.targetJobIds));

  const mockDraft = await createResumeOptimizationService({ db, adapter: new MockModelAdapter() }).createDraft({
    profileId: owner.profileId,
    planId: owner.planId,
    sourceResumeVersionId: owner.resumeVersionId,
    targetDirection: "AI 应用工程师"
  });
  assert.strictEqual(mockDraft.suggestions.length, 0);
  assert.strictEqual(mockDraft.finalText, document('unused', '候选人甲').text);

  const punctuationText = '标点测试\n项目经历：参与接口联调，做检索测试。\n技能：Ｎｏｄｅ．ｊｓ';
  const punctuation = storage.saveProfileAnalysis(db, {
    profile: { candidate: { name: '标点测试', targetTitles: ['工程师'] } },
    document: { text: punctuationText, contentHash: 'normalization-anchors', format: 'text', originalFileName: 'punctuation.txt' },
    searchPlan: { name: '标点方案', directions: ['工程师'] }
  });
  const punctuationService = createResumeOptimizationService({ db, adapter: { async generateResumeOptimization(input) {
    const evidence = input.evidenceCatalog.find(item => item.text.includes('接口联调'));
    return { headline: '写清具体工作', suggestions: [{ id: 'S1', operation: 'replace', originalText: evidence.text,
      proposedText: '项目经历：参与接口联调与检索测试。', reason: '明确工作范围', evidenceIds: [evidence.id], editingPrinciple: 'concision' }] };
  } } });
  const normalizedDraft = await punctuationService.createDraft({ profileId: punctuation.profileId, planId: punctuation.planId,
    sourceResumeVersionId: punctuation.resumeVersionId, mode: 'general' });
  assert.equal(normalizedDraft.suggestions[0].originalText, '项目经历：参与接口联调，做检索测试。');
  assert(normalizedDraft.generatedText.includes('项目经历：参与接口联调与检索测试。'));
  assert(normalizedDraft.generatedText.includes('技能：Ｎｏｄｅ．ｊｓ'), 'unmodified formatting must remain intact');
  const { restoreResumeSuggestionAnchors } = require('../src/core/resume_optimization');
  assert.throws(() => restoreResumeSuggestionAnchors({ suggestions: [{ originalText: 'AA' }] }, { sourceText: 'ＡＡＡ', modelText: 'AAA' }), /不唯一/);
  assert.throws(() => restoreResumeSuggestionAnchors({ suggestions: [{ originalText: '[姓名已隐藏]' }] }, { sourceText: '真实姓名', modelText: '[姓名已隐藏]' }), /不存在/);

  const { saveCandidateEvidence, withdrawCandidateEvidence, reviseCandidateEvidence } = require('../src/storage/candidate_evidence_store');
  const { deleteCandidateFact, recordCandidateFactValue } = require('../src/storage/message_learning_store');
  for (const change of ['unchanged', 'withdraw', 'delete', 'correct', 'scope']) {
    const person = storage.saveProfileAnalysis(db, {
      profile: profile('资料测试'), document: document(`current-material-${change}`, '资料测试'),
      searchPlan: { name: '资料方案', directions: ['AI 应用工程师'] }
    });
    const identity = { profileId: person.profileId, planId: person.planId, sourceResumeVersionId: person.resumeVersionId, mode: 'general' };
    const salary = saveCandidateEvidence(db, { profileId: person.profileId, subject: '求职补充', text: '目前期望薪资20K',
      sourceKind: 'manual', sourceId: 'salary', sourceItemKey: 'salary', sourceQuote: '用户已确认', scope: { kind: 'global' } });
    for (let index = 0; index < 12; index++) saveCandidateEvidence(db, {
      profileId: person.profileId, subject: '参与企业知识库开发', text: '参与企业知识库开发，完成项目交付。',
      sourceKind: 'manual', sourceId: `project-${index}`, sourceItemKey: 'project', sourceQuote: '用户已确认', scope: { kind: 'global' }
    });
    const current = createResumeOptimizationService({ db, adapter: { async generateResumeOptimization(input) {
      assert.equal(input.candidateEvidence.length, 12);
      assert(!input.candidateEvidence.some(item => item.text.includes('20K')));
      const fact = input.evidenceCatalog.find(item => item.kind === 'fact' && item.text.includes('20K'));
      assert(fact, 'all current facts must remain available beyond the selected material budget');
      return { headline: '补充已确认求职信息', suggestions: [{ id: 'S1', operation: 'replace', originalText: '参与企业知识库开发',
        proposedText: '参与企业知识库开发\n期望薪资：20K', reason: '补充确认信息', evidenceIds: [fact.id], editingPrinciple: 'contribution_clarity' }] };
    } } });
    const generated = await current.createDraft(identity);
    if (change === 'withdraw') withdrawCandidateEvidence(db, { profileId: person.profileId, id: salary.id });
    if (change === 'delete') deleteCandidateFact(db, { profileId: person.profileId, factKey: 'expected_salary', recordIfMissing: true });
    if (change === 'correct') recordCandidateFactValue(db, { profileId: person.profileId, factKey: 'expected_salary', factValue: '25K' });
    if (change === 'scope') saveCandidateEvidence(db, { ...salary, scope: { kind: 'job', key: String(validJobId) } });
    const versions = storage.listCandidateResumeVersions(db, person.profileId).length;
    const activate = () => current.activateDraft({ ...identity, draftId: generated.id, finalText: generated.finalText });
    if (change === 'unchanged') {
      const enabled = activate();
      assert.equal(enabled.status, 'activated');
      assert.equal(activate().resultResumeVersionId, enabled.resultResumeVersionId);
      assert.equal(require('../src/storage/candidate_store').getCandidateResumeDocument(db, { profileId: person.profileId, resumeVersionId: person.resumeVersionId }).text,
        document(`current-material-${change}`, '资料测试').text);
    } else {
      assert.throws(activate, error => error.code === 'RESUME_ACTIVATION_INTEGRITY_FAILED'
        && error.issues.some(item => item.code === 'RESUME_FACT_UNSUPPORTED'), change);
      assert.equal(storage.listCandidateResumeVersions(db, person.profileId).length, versions, change);
      // Make the old salary relevant to ensure the raw material cannot bypass a deletion or correction.
      if (['delete', 'correct'].includes(change)) {
        reviseCandidateEvidence(db, { profileId: person.profileId, id: salary.id, subject: '参与企业知识库开发', text: salary.text });
        // Preserve its confirmation time; revising the subject must not reconfirm the deleted salary.
        db.prepare('UPDATE candidate_evidence_entries SET updated_at = ? WHERE id = ?').run(salary.updatedAt, salary.id);
        assert.throws(activate, error => error.code === 'RESUME_ACTIVATION_INTEGRITY_FAILED', `${change} relevant evidence`);
      }
    }
  }

  const currentSource = '当前测试\n计算机本科\n参与企业知识库接口开发，使用Node.js与SQL进行接口联调及异常场景测试。\n我目前在职，下周可以到岗。';
  const correctedOwner = storage.saveProfileAnalysis(db, { profile: profile('当前测试'),
    document: { text: currentSource, contentHash: 'resume-current-correction', format: 'text', originalFileName: 'current.txt' },
    searchPlan: { name: '更正测试', directions: ['AI 应用工程师'] } });
  const correctionService = createResumeOptimizationService({ db, adapter: new MockModelAdapter() });
  const correctionIdentity = { profileId: correctedOwner.profileId, planId: correctedOwner.planId, sourceResumeVersionId: correctedOwner.resumeVersionId, mode: 'general' };
  const correctionDraft = await correctionService.createDraft(correctionIdentity);
  recordCandidateFactValue(db, { profileId: correctedOwner.profileId, factKey: 'employment_status', factValue: '已离职' });
  recordCandidateFactValue(db, { profileId: correctedOwner.profileId, factKey: 'availability_date', factValue: '我无法下周到岗' });
  assert.throws(() => correctionService.activateDraft({ ...correctionIdentity, draftId: correctionDraft.id, finalText: correctionDraft.finalText }),
    error => error.code === 'RESUME_ACTIVATION_INTEGRITY_FAILED');
  const correctedText = correctionDraft.finalText.replace('我目前在职，下周可以到岗。', '我已离职，我无法下周到岗。');
  assert.equal(correctionService.activateDraft({ ...correctionIdentity, draftId: correctionDraft.id, finalText: correctedText }).status, 'activated');
  assert.equal(require('../src/storage/candidate_store').getCandidateResumeDocument(db, {
    profileId: correctedOwner.profileId, resumeVersionId: correctedOwner.resumeVersionId }).text, currentSource);

  console.log("resume_optimization_service_smoke ok");
} finally {
  db.close();
}
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
