"use strict";
const assert = require("node:assert/strict");
const {
  WORK_MATCH_PROMPT,
  presentWorkMatchInput,
  normalizeWorkMatchOutput,
  validateWorkMatchOutput,
  runWorkMatch
} = require("../src/core/job_work_matching");
const { buildJobMatchEvidence } = require("../src/core/job_match_evidence");
const { createAttemptTelemetry, createAttemptTelemetryLogger } = require("../src/core/workflow_analysis_executor");

const profile = {
  candidate: { name: "虚拟候选人", city: "广州", targetTitles: ["后端开发工程师"] },
  source: { resumeEvidenceText: "计算机相关本科已毕业，独立开发订单接口，设计数据库表和索引，编写接口测试。" },
  education: [{ school: "示例大学", degree: "本科", major: "电子信息工程", status: "已毕业" }],
  experiences: [{ organization: "示例公司", role: "后端开发工程师", highlights: ["独立开发订单接口，设计数据库表和索引，编写接口测试。"] }],
  skills: [{ name: "Python", level: "熟练", evidence: "订单接口开发" }],
  projects: [], credentials: [], strengths: []
};
const job = { source: "test", title: "后端开发工程师", description: "负责订单接口、数据库表和索引设计、SQL优化、接口测试与线上故障处理；本科或相关专业，有业务接口经验。" };
const evidence = buildJobMatchEvidence({ candidateProfile: profile, jobFacts: job });
const input = {
  candidateProfile: { candidate: profile.candidate, resumeEvidenceText: profile.source.resumeEvidenceText,
    education: profile.education, experiences: profile.experiences, skills: profile.skills,
    projects: [], credentials: [], strengths: [] },
  candidateMatchCard: null,
  searchPreferences: { cities: ["广州"], jobTypes: ["全职"], directions: ["后端开发工程师"] },
  originalJob: job,
  runtimeContext: { analysisAsOfDate: "2026-10-10", timeZone: "Asia/Shanghai" },
  matchEvidence: evidence,
  evidenceCatalog: evidence.entries
};
const payload = presentWorkMatchInput(input);
const findAlias = path => Object.entries(payload.sourceIndex).find(([, source]) => source.path === path)?.[0];
const jd = findAlias("originalJob.description");
const candidate = findAlias("candidateProfile.resumeEvidenceText");
assert.ok(jd && candidate);
const good = {
  selectedWork: { summary: "订单后端接口开发及数据库优化", jdEvidenceRefs: [jd] },
  supportingEvidenceRefs: [candidate],
  materialConsiderations: [{ description: "业务接口交付有直接支持，普通学历细节留给后续沟通。",
    jdEvidenceRefs: [jd], candidateEvidenceRefs: [candidate] }],
  modelRecommendation: "primary",
  decisionExplanation: "主工作与实际接口和数据库交付相关，值得投递。"
};
const verify = raw => validateWorkMatchOutput(normalizeWorkMatchOutput(raw).raw, input);
const bad = raw => assert.throws(() => verify(raw), { code: "MODEL_CONTRACT_INVALID" });

assert.equal(typeof WORK_MATCH_PROMPT, "string");
for (const key of ["candidateProfile", "candidateMatchCard", "searchPreferences", "originalJob", "runtimeContext"]) {
  assert.deepEqual(payload[key], input[key], `Full material preserved: ${key}`);
}
for (const tier of ["primary", "apply", "caution", "not_recommended"]) {
  const out = verify({ ...good, modelRecommendation: tier });
  assert.equal(out.modelRecommendation, tier, "Structural validation must preserve the model tier");
  assert.equal(out.supportingFacts[0].quote, profile.source.resumeEvidenceText);
  assert.equal(out.decisionExplanation, good.decisionExplanation);
}
for (const refs of [[jd], ["C99999"], [candidate, candidate]]) bad({ ...good, supportingEvidenceRefs: refs });
bad({ ...good, selectedWork: { ...good.selectedWork, jdEvidenceRefs: [candidate] } });
const missing = { ...good }; delete missing.modelRecommendation; bad(missing);
const normalized = normalizeWorkMatchOutput({ ...good, education: [] });
assert.deepEqual(normalized.raw, good);
assert.equal(normalized.changes.length, 1);
bad({ ...good, education: [{ degree: "虚构硕士" }] });
bad({ ...good, inventedQualification: [] });
  for (const [field, empty] of [['type', 'json_object'], ['contractRepair', null], ['decisionExplanationNote', '']]) {
    assert.deepEqual(normalizeWorkMatchOutput({ ...good, [field]: empty }).raw, good);
    bad({ ...good, [field]: 'nonempty or different metadata' });
  }
  const sensitive = '候选秘密姓名 13800000001';
  for (const invalid of [{ ...good, supportingEvidenceRefs: [sensitive] }, { ...good, [sensitive]: [] }]) {
    assert.throws(() => verify(invalid), error => error.code === 'MODEL_CONTRACT_INVALID'
      && !error.message.includes(sensitive), 'Raw invalid values must not enter diagnostics or saved failure reasons');
  }

async function main() {
  await testRealTransport();
  const malformed = JSON.stringify(good) + "}";
  const calls = [];
  const result = await runWorkMatch({
    payload,
    verify,
    readInvalidJson: error => error.invalidResponseText,
    call: async value => {
      calls.push(structuredClone(value));
      if (calls.length === 1) throw Object.assign(new Error("bad JSON"), {
        code: "MODEL_INVALID_JSON", retryable: true, invalidResponseText: malformed
      });
      return good;
    }
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], payload);
  assert.equal(calls[1].contractRepair.invalidResponseText, malformed);
  const unchanged = { ...calls[1] }; delete unchanged.contractRepair;
  assert.deepEqual(unchanged, payload);
  assert.equal(result.modelRecommendation, "primary");

  let attempts = 0;
  await assert.rejects(runWorkMatch({ payload, verify, readInvalidJson: () => malformed,
    call: async () => { attempts++; throw Object.assign(new Error("bad JSON"), { code: "MODEL_INVALID_JSON", retryable: true }); }
  }), { code: "MODEL_INVALID_JSON" });
  assert.equal(attempts, 2, "A second failure must stop");

  attempts = 0;
  await assert.rejects(runWorkMatch({ payload, verify,
    call: async () => { attempts++; throw Object.assign(new Error("aborted"), { code: "OPERATION_ABORTED", name: "AbortError", retryable: true }); }
  }), { code: "OPERATION_ABORTED" });
  assert.equal(attempts, 1);
  for (const status of [401, 402, 403, 429]) {
    attempts = 0;
    await assert.rejects(runWorkMatch({ payload, verify, call: async () => {
      attempts++; throw Object.assign(new Error('http failure'), { status, retryable: true });
    } }));
    assert.equal(attempts, 1, 'Credentials and quota must stop without formatting recovery');
  }
  const canonical = verify(good);
  canonical.supportingFacts[0].quote = 'tampered cached quote';
  assert.equal(validateWorkMatchOutput(canonical, input, { useSourceAliases: false }).supportingFacts[0].quote,
    profile.source.resumeEvidenceText, 'cache rebinds facts to current original sources');
  console.log("Job work matching structure, source binding, tier preservation and bounded recovery passed.");
}
async function testRealTransport() {
  const { OpenAICompatibleAdapter } = require('../src/adapters/models/openai_compatible');
  const originalFetch = global.fetch, events = [], requests = [], telemetry = createAttemptTelemetry();
  const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.deepseek.com', apiKey: 'fixture-key',
    model: 'deepseek-v4-flash', thinkingMode: 'enabled', reasoningEffort: 'high', maxRetries: 3, maxTokens: 1700,
    logger: createAttemptTelemetryLogger({ info(event, data) { events.push({ event, data }); },
      warn(event, data) { events.push({ event, data }); } }, telemetry) });
  const malformed = JSON.stringify(good) + '}';
  const response = (content, finish = 'stop') => new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finish }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    for (const [field, empty] of [['decisionExplanation_note', ''], ['unrecognized_optional_text', '  \n']]) {
      requests.length = 0;
      global.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return response(JSON.stringify({ ...good, [field]: empty }));
      };
      const selected = await adapter.selectJob(input);
      assert.deepEqual(selected, verify(good), 'Empty optional text must not change the grounded decision');
      assert.equal(requests.length, 1, 'An empty unused field must not consume a repair or reject a job');
    }
    const privateFieldName = '候选秘密姓名 13800000001';
    const emptyExtra = normalizeWorkMatchOutput({ ...good, [privateFieldName]: '' });
    assert.deepEqual(emptyExtra.raw, good);
    assert(!JSON.stringify(emptyExtra.changes).includes(privateFieldName), 'Unknown names must not leak through normalization diagnostics');
    bad({ ...good, decisionExplanation_note: '有内容的未知附加断言' });
    bad({ ...good, unrecognized_optional_text: null });
    bad({ ...good, modelRecommendation: '', decisionExplanation_note: '' });
    bad({ ...good, selectedWork: { ...good.selectedWork, jdEvidenceRefs: [candidate] }, decisionExplanation_note: '' });
    requests.length = 0;
    Object.assign(telemetry, createAttemptTelemetry());
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response(requests.length === 1 ? malformed : JSON.stringify(good));
    };
    assert.equal((await adapter.selectJob(input)).modelRecommendation, 'primary');
    assert.equal(requests.length, 2);
    assert.equal(telemetry.modelCallCount, requests.length, 'The parser failure and recovery both consume real requests');
    assert.equal(JSON.parse(requests[1].messages[1].content).contractRepair.invalidResponseText, malformed,
      'Real parser error forwards the exact malformed response for the one recovery');
    assert(!JSON.stringify(events).includes(malformed), 'Raw candidate response must not enter diagnostic events');
    assert.equal(requests[0].max_tokens, 4096);
    assert.deepEqual(requests[0].thinking, { type: 'enabled' });
    assert.equal(requests[0].reasoning_effort, 'high');
    assert.equal(requests[0].temperature, undefined);
    assert.equal(adapter.maxRetries, 3);
    assert.equal(adapter.maxTokens, 1700, 'Operation-local limits do not change the shared transport');

    requests.length = 0;
    Object.assign(telemetry, createAttemptTelemetry());
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response(requests.length === 1 ? '' : JSON.stringify(good), requests.length === 1 ? 'length' : 'stop');
    };
    await adapter.selectJob(input);
    assert.deepEqual(requests.map(request => request.max_tokens), [4096, 8192]);
    assert.equal(telemetry.modelCallCount, requests.length, 'A truncated response remains a counted request');
    requests.length = 0;
    Object.assign(telemetry, createAttemptTelemetry());
    global.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return response(malformed); };
    await assert.rejects(adapter.selectJob(input), { code: 'MODEL_INVALID_JSON', modelRepairHandled: true });
    assert.equal(requests.length, 2, 'Transport retries cannot multiply the one recovery');
    assert.equal(telemetry.modelCallCount, requests.length, 'A terminal failure still counts both requests');

    requests.length = 0;
    global.fetch = async (_url, options) => {
      const request = JSON.parse(options.body), data = JSON.parse(request.messages[1].content);
      requests.push(request);
      if (!data.contractRepair) return response('invalid-' + data.originalJob.sourceId);
      assert.equal(data.contractRepair.invalidResponseText, 'invalid-' + data.originalJob.sourceId,
        'Concurrent jobs cannot receive another job response');
      return response(JSON.stringify(good));
    };
    await Promise.all(['one', 'two'].map(sourceId => adapter.selectJob({ ...input, originalJob: { ...job, sourceId } })));
    assert.equal(requests.length, 4);
    assert.equal(adapter.maxRetries, 3);
  } finally { global.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
