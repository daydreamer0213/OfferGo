const assert = require('node:assert/strict');
const storage = require('../src/core/storage');
const interviewStore = require('../src/storage/mock_interview_store');
const evidence = require('../src/storage/candidate_evidence_store');
const { createMockInterviewService } = require('../src/application/mock_interview');

function runEvidenceSourceRegressions() {
  const db = storage.openDb(':memory:');
  try {
    const owner = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '来源边界' }, skills: [{ name: 'Node.js' }] },
      document: { contentHash: 'source-boundary', text: '参与开发', originalFileName: 'source.txt', format: 'text' },
      searchPlan: { directions: ['开发'] }
    });
    const service = createMockInterviewService({ db, adapter: {
      async generateMockInterviewStep() { throw new Error('This source regression must not call a model'); }
    } });
    function seed(answer, question = '请介绍实际做过的工作。') {
      const session = interviewStore.createMockInterviewSession(db, {
        profileId: owner.profileId, planId: owner.planId, sessionKind: 'resume_general',
        resumeVersionId: owner.resumeVersionId, context: { resumeEvidenceCatalog: [{ id: 'R1', text: '参与开发' }] },
        settings: { plannedQuestions: 3 }, initialQuestion: { text: question, focus: 'contribution', resumeEvidenceIds: ['R1'] }
      });
      db.prepare('UPDATE mock_interview_turns SET answer_text = ?, answer_review_json = ? WHERE session_id = ?')
        .run(answer, JSON.stringify({ conclusion: '仍需改善', strengths: [], improvements: [], turnNumbers: [1] }), session.id);
      return { profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1 };
    }
    const rejected = [
      ['self-admitted numbers', '我编了两个数字：转化提升37%、ROI提升52%。', '转化提升37%', '转化提升37%。'],
      ['number precedes the object noun', '我编了转化提高37%这个数字。', '转化提高37%', '转化提高37%。'],
      ['cleaned whole fictional story', '我把练习示范改成自己的经历：以前我独立负责全年利润预算并提升利润。', '以前我独立负责全年利润预算并提升利润', '我独立负责全年利润预算并提升利润。'],
      ['preceding declaration', '下面是练习示范，不是我的实际经历。以前我独立负责全年利润预算。', '以前我独立负责全年利润预算', '我负责全年利润预算。'],
      ['trailing declaration', '以前我独立负责全年利润预算。以上只是练习示范，不是我的实际经历。', '以前我独立负责全年利润预算', '我负责全年利润预算。'],
      ['narrowed scenario method', '我会先选一个商品。测试版只调整尺寸说明，对照版保留当前内容。', '测试版只调整尺寸说明，对照版保留当前内容', '我完成过尺寸说明对照测试。', '假设现在由你测试商品页，你会怎么做？'],
      ['scenario method without first-person preface', '先选一个商品。测试版调整尺寸说明，对照版保留当前内容。', '测试版调整尺寸说明，对照版保留当前内容', '我完成过尺寸说明对照测试。', '请假设现在由你测试商品页，你会怎么做？'],
      ['repeated quote with conflicting origin', '我参与过接口联调。下面是练习示范，不是我的经历。我参与过接口联调。', '我参与过接口联调', '我做过接口联调。']
    ];
    for (const [label, answer, sourceQuote, text, question] of rejected) {
      const identity = seed(answer, question);
      const before = db.prepare('SELECT count(*) n FROM candidate_evidence_entries').get().n;
      assert.throws(() => service.confirmEvidence({ ...identity, subject: label, sourceQuote, text }),
        error => String(error.code).startsWith('CANDIDATE_EVIDENCE_SOURCE_'), label);
      assert.equal(db.prepare('SELECT count(*) n FROM candidate_evidence_entries').get().n, before, `${label}: no write on rejection`);
    }
    const accepted = [
      ['real before fabricated numbers', '我把尺寸说明前置，客服同类咨询减少。我编了两个数字：转化提升37%、ROI提升52%。', '我把尺寸说明前置，客服同类咨询减少'],
      ['real after fiction', '下面是练习示范，不是我的经历。以前我独立负责利润预算。实际发生的是我整理了商品页信息，客服同类咨询减少。', '实际发生的是我整理了商品页信息，客服同类咨询减少'],
      ['qualitative without metrics', '我改了页面说明，咨询减少，但没有准确统计。', '我改了页面说明，咨询减少，但没有准确统计'],
      ['new real fact missing from CV', '我给同事做过系统培训。', '我给同事做过系统培训'],
      ['actual business hypothesis and code', '我参与业务假设验证，编写了接口校验代码。', '我参与业务假设验证，编写了接口校验代码'],
      ['denying fabrication', '这些结果不是编造的，我参与联调并完成验收。', '这些结果不是编造的，我参与联调并完成验收'],
      ['denying authorship of invented numbers', '这些观察不是我编造的，没有准确数字的部分我就不写百分比。', '这些观察不是我编造的，没有准确数字的部分我就不写百分比'],
      ['hypothetical question with actual history', '去年我参与过接口联调，当时比较日志定位问题。', '去年我参与过接口联调，当时比较日志定位问题', '假设接口异常，你会怎么处理？'],
      ['current learning in scenario', '我正在学习直播流程，并整理主播和场控的核对项。', '我正在学习直播流程，并整理主播和场控的核对项', '假设让你准备直播，你会怎么做？'],
      ['ordinary actual training in scenario', '我给客户做过系统操作培训，整理了操作说明。', '我给客户做过系统操作培训，整理了操作说明', '假设让你培训客户，你会怎么做？'],
      ['completed exercise in scenario', '我做过一次模拟讲解练习，记录了需要核对的商品信息。', '我做过一次模拟讲解练习，记录了需要核对的商品信息', '假设让你准备直播，你会怎么做？'],
      ['actual history after hypothetical method', '我会先比较日志。去年我参与过接口联调，并记录排查结果。', '去年我参与过接口联调，并记录排查结果', '假设接口异常，你会怎么处理？'],
      ['ordinary training after hypothetical method', '我会先比较日志。我给客户做过系统操作培训，现场回答了使用问题。', '我给客户做过系统操作培训，现场回答了使用问题', '假设接口异常，你会怎么处理？'],
      ['real quantity after an invented metric', '我编了转化提高37%这个数字，但实际改了5个商品页。', '但实际改了5个商品页。'],
      ['ordinary availability is not a scenario method', '我会在两周内到岗。', '我会在两周内到岗。'],
      ['independent real fact before a locally qualified example', '我负责接口联调并完成验收。下面举一个利润预算案例：我独立负责全年利润预算。刚才这个案例只是练习示范，不是我的经历。', '我负责接口联调并完成验收。']
    ];
    let saved;
    for (const [label, answer, sourceQuote, question] of accepted) {
      saved = service.confirmEvidence({ ...seed(answer, question), subject: label, sourceQuote, text: sourceQuote });
      assert.equal(saved.sourceQuote, sourceQuote, label);
      assert(evidence.listCandidateEvidence(db, { profileId: owner.profileId }).some(entry => entry.id === saved.id), label);
    }
    evidence.reviseCandidateEvidence(db, { profileId: owner.profileId, id: saved.id, subject: '正常整理', text: '去年我参与接口联调，整理排查记录。' });
    assert.throws(() => evidence.reviseCandidateEvidence(db, { profileId: owner.profileId, id: saved.id,
      subject: '明确编造的新文字', text: '下面是练习示范，不是我的经历。我独立负责全年利润预算。' }),
    error => String(error.code).startsWith('CANDIDATE_EVIDENCE_SOURCE_'));

    // A row written by the old implementation stays recoverable, but cannot be cleaned into reusable history.
    const legacy = seed('下面是练习示范，不是我的实际经历。以前我独立负责全年利润预算。');
    const legacyId = Number(db.prepare(`INSERT INTO candidate_evidence_entries(
      profile_id, subject, evidence_text, source_kind, source_id, source_item_key, source_quote, scope_json, created_at, updated_at
    ) VALUES (?, '旧示范', '我负责全年利润预算。', 'interview_turn', ?, 'turn:1', '以前我独立负责全年利润预算', '{}', ?, ?)`)
      .run(owner.profileId, String(legacy.sessionId), new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
    assert(!evidence.listCandidateEvidence(db, { profileId: owner.profileId }).some(entry => entry.id === legacyId), 'legacy nonfact excluded from generation');
    const retained = evidence.listCandidateEvidence(db, { profileId: owner.profileId, includeNonFacts: true }).find(entry => entry.id === legacyId);
    assert(retained?.sourceStatus, 'management retains legacy row with its source qualification');
    assert.throws(() => evidence.reviseCandidateEvidence(db, { profileId: owner.profileId, id: legacyId,
      subject: '删掉免责声明', text: '我负责全年利润预算并提升利润。' }), error => String(error.code).startsWith('CANDIDATE_EVIDENCE_SOURCE_'));
    evidence.withdrawCandidateEvidence(db, { profileId: owner.profileId, id: legacyId });
    assert.equal(db.prepare('SELECT count(*) n FROM candidate_evidence_entries WHERE id = ?').get(legacyId).n, 1, 'withdraw preserves evidence');
    console.log('candidate_evidence_source_regressions ok');
  } finally { db.close(); }
}

module.exports = { runEvidenceSourceRegressions };
if (require.main === module) runEvidenceSourceRegressions();
