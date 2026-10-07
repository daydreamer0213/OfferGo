const assert = require('node:assert/strict');
const { test } = require('node:test');
const { analyzeResumeProfile } = require('../src/core/profile_onboarding');
const { normalizeCandidateProfile } = require('../src/core/profile_schema');
const { createJobAnalysisRunner } = require('../src/core/job_analysis');
const { loadConfigs } = require('../src/config');

test('matching retains the supplied masked resume when structural extraction omits an explicit boundary', async () => {
  const masked = '候选人\n后端开发两年，负责订单接口。未使用Kubernetes，不负责微服务架构或团队管理。';
  const profile = await analyzeResumeProfile({
    modelConfig: { provider: 'mock' }, resume: { text: '个人资料仅在本地', format: 'text' },
    preparedModelInput: { text: masked, preview: masked, redactions: {} },
    analyzerFactory: () => ({ async analyzeResume() {
      return { candidate: { targetTitles: ['后端开发工程师'] }, experiences: [{ role: '后端开发', highlights: ['负责订单接口'] }] };
    } })
  });
  assert.equal(profile.source.resumeEvidenceText, masked);
  assert.equal(normalizeCandidateProfile(profile).source.resumeEvidenceText, masked);
  let captured;
  const sentinel = Object.assign(new Error('captured matching input'), { code: 'TEST_CAPTURE' });
  const run = createJobAnalysisRunner({ ...loadConfigs(require('node:path').resolve(__dirname, '..')),
    model: { provider: 'mock' }, candidateProfile: profile }, [], { errorMode: 'throw',
    analyzer: { understandJob: input => new (require('../src/adapters/models/mock').MockModelAdapter)().understandJob(input),
      matchJob: async input => { captured = input; throw sentinel; } } });
  await assert.rejects(run({ title: '架构师', description: '主导生产Kubernetes与架构', source: 'boss' }), error => error === sentinel);
  assert.equal(captured.candidateProfile.resumeEvidenceText, masked);
  assert.equal(captured.candidateProfile.candidate.expectedSalary, undefined);
});

test('the retained matching source is the privacy-prepared input, never the local original', async () => {
  const profile = await analyzeResumeProfile({ modelConfig: { provider: 'mock' },
    resume: { text: '张宁\n手机：13800138000\n邮箱：zhangning@example.com\n后端接口开发；未使用Kubernetes。', format: 'text', originalFileName: '张宁.txt' },
    identity: { names: ['张宁'] }, strictPrivacy: true,
    analyzerFactory: () => ({ analyzeResume: async () => ({ candidate: { targetTitles: ['后端开发工程师'] } }) }) });
  assert(!/张宁|13800138000|zhangning@example\.com/.test(profile.source.resumeEvidenceText));
  assert(profile.source.resumeEvidenceText.includes('未使用Kubernetes'));
});
