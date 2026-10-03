"use strict";

const assert = require("node:assert/strict");
const { generateQualityCheckedDraft } = require("../src/application/message_draft_quality");

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  const storage = require('../src/core/storage');
  const { buildMessageDraftQualityContext } = require('../src/application/message_draft_quality');
  const { assessMessageDraftQuality } = require('../src/core/message_draft_quality');
  const db = storage.openDb(':memory:');
  try {
    const now = new Date().toISOString();
    const profile = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '匿名测试', targetTitles: ['工程师'] } },
      document: { contentHash: 'resume-fact-precedence', text: '目前在职，下周可以到岗。\n去年入职示例公司，负责接口联调。\n有3年软件开发经验。', format: 'text', originalFileName: 'resume.txt' },
      searchPlan: { name: '方案', directions: ['工程师'] }
    });
    storage.saveCandidateFact(db, { profileId: profile.profileId, factKey: 'employment_status', factValue: '已离职' });
    storage.saveCandidateFact(db, { profileId: profile.profileId, factKey: 'availability_date', factValue: '我无法下周到岗' });
    const context = buildMessageDraftQualityContext(db, { profileId: profile.profileId, now });
    assert.equal(assessMessageDraftQuality({ text: '目前在职，下周可以到岗。', ...context }).valid, false,
      'explicit current corrections take precedence over conflicting raw active resume clauses');
    assert.equal(assessMessageDraftQuality({ text: '我目前已离职，我无法下周到岗。', ...context }).valid, true);
    assert(context.evidenceTexts.some(text => text.includes('去年入职示例公司') && text.includes('接口联调')));
    assert.equal(assessMessageDraftQuality({ text: '我有3年软件开发经验。', ...context }).valid, true);
    const evidenceProfile = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '匿名经历测试' } },
      document: { contentHash: 'evidence-resume-precedence', text: '目前在职，下周可以到岗。\n参与接口联调。', format: 'text', originalFileName: 'resume.txt' }
    });
    const { saveCandidateEvidence } = require('../src/storage/candidate_evidence_store');
    for (const [index, text] of ['我目前在职，下周可以到岗。', '我目前已离职，无法下周到岗。'].entries()) {
      saveCandidateEvidence(db, { profileId: evidenceProfile.profileId, subject: '已确认求职状态', text, sourceQuote: text,
        sourceKind: 'interview_turn', sourceId: 'anonymous-test-interview', sourceItemKey: String(index),
        confirmedAt: new Date(Date.parse(now) - (1 - index) * 1000).toISOString() });
    }
    const evidenceContext = buildMessageDraftQualityContext(db, { profileId: evidenceProfile.profileId, now });
    assert.equal(assessMessageDraftQuality({ text: '我目前在职，下周可以到岗。', ...evidenceContext }).valid, false,
      'newest confirmed evidence overrides old evidence and resume without requiring a separate manual fact');
    assert.equal(assessMessageDraftQuality({ text: '我目前已离职，无法下周到岗。', ...evidenceContext }).valid, true);
  } finally { db.close(); }
  const calls = [];
  const output = await generateQualityCheckedDraft({
    generate: async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { messages: ["您好，我对贵司岗位很感兴趣，期待沟通。"] }
        : { messages: ["想结合岗位职责进一步了解团队目前的重点。"] };
    },
    input: { messageIntent: "follow_up" },
    recentTexts: ["您好，我对贵司岗位很感兴趣，期待沟通。"],
    evidenceTexts: []
  });
  assert.equal(output.attempts, 2);
  assert.equal(output.sendable, true);
  assert.equal(output.result.messages[0], "想结合岗位职责进一步了解团队目前的重点。");
  assert.equal(calls[1].draftQualityRevision.reasonCodes[0], "MESSAGE_DRAFT_RECENTLY_SIMILAR");

  const unsupported = await runSequence(
    [{ messages: ["我的期望薪资是 25K。"] }, { messages: ["方便的话，想进一步了解岗位职责。"] }],
    { evidenceTexts: [] }
  );
  assert.equal(unsupported.output.attempts, 2);
  assert.equal(unsupported.output.sendable, true);
  assert.deepEqual(unsupported.calls[1].draftQualityRevision.unsupportedClaims, [{ kind: "salary", value: "期望薪资是 25K" }]);

  const stillSimilar = await runSequence(
    [{ messages: ["您好，想了解岗位情况，期待沟通。"] }, { messages: ["您好，想了解岗位情况，期待进一步沟通。"] }],
    { recentTexts: ["您好，想了解岗位情况，期待沟通。"] }
  );
  assert.equal(stillSimilar.output.attempts, 2);
  assert.equal(stillSimilar.output.sendable, true);
  assert.equal(stillSimilar.output.assessment.warnings[0].code, "MESSAGE_DRAFT_RECENTLY_SIMILAR");

  const stillInvalid = await runSequence(
    [{ messages: ["手机号 13800138000。"] }, { messages: ["请联系 13900139000。"] }]
  );
  assert.equal(stillInvalid.output.attempts, 2);
  assert.equal(stillInvalid.output.sendable, false);
  assert.equal(stillInvalid.output.assessment.errors[0].kind, "phone");

  let failedCalls = 0;
  const failedRevision = await generateQualityCheckedDraft({
    generate: async () => {
      failedCalls += 1;
      if (failedCalls === 2) throw new Error("revision unavailable");
      return { messages: ["手机号 13800138000。"] };
    },
    input: {}, recentTexts: [], evidenceTexts: []
  });
  assert.equal(failedRevision.attempts, 1);
  assert.equal(failedRevision.sendable, false);
  assert.equal(failedRevision.result.messages[0], "手机号 13800138000。");
  assert.equal(failedRevision.revisionError.message, "revision unavailable");

  const empty = await runSequence([{ messages: [] }, { messages: [] }]);
  assert.equal(empty.output.attempts, 2);
  assert.equal(empty.output.sendable, false);
  assert.equal(empty.output.assessment.errors[0].code, "MESSAGE_DRAFT_EMPTY");

  let manualCalls = 0;
  const manual = await generateQualityCheckedDraft({
    generate: async () => {
      manualCalls += 1;
      return { messages: [], missingFact: { key: "availability_date" } };
    },
    shouldAssess: (result) => !result.missingFact,
    recentTexts: [],
    evidenceTexts: []
  });
  assert.equal(manualCalls, 1, "a deliberate manual result must not be rewritten as an empty draft");
  assert.equal(manual.sendable, true);
  assert.equal(manual.assessment.skipped, true);

  const mixed = await runSequence([
    { messages: ["您好，想了解团队重点。", "我的手机号是 13800138000。"] },
    { messages: ["您好，想了解团队重点。", "也想了解这个岗位的协作方式。"] }
  ]);
  assert.equal(mixed.output.sendable, true);
  assert.equal(mixed.calls.length, 2);

  console.log("message_draft_quality_service_smoke ok");
}

async function runSequence(results, options = {}) {
  const calls = [];
  const output = await generateQualityCheckedDraft({
    generate: async (input) => {
      calls.push(input);
      return results[Math.min(calls.length - 1, results.length - 1)];
    },
    input: {},
    recentTexts: options.recentTexts || [],
    evidenceTexts: options.evidenceTexts || []
  });
  return { calls, output };
}
