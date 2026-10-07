// Deliberate real-model sampling of synthetic material, never part of the offline gate.
// A completed request is evidence to inspect, not an automatic quality verdict.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const workspace = path.resolve(__dirname, '..');
const options = Object.fromEntries(process.argv.slice(2).filter(v => v.startsWith('--')).map(v => {
  const split = v.indexOf('='); return split < 0 ? [v.slice(2), true] : [v.slice(2, split), v.slice(split + 1)];
}));
if (options.live !== true || !options['settings-root'] || !options.output || !options.phase) {
  throw Error('Require --live --settings-root=<existing root> --output=<new D drive file> --phase=onboarding|reply|messages|resume|interview|learning|jobs|communication|matching-card');
}
const output = path.resolve(options.output);
if (!/^D:[\\/]/i.test(output) || fs.existsSync(output)) throw Error('Output must be a fresh D drive file');
fs.mkdirSync(path.dirname(output), { recursive: true });
const settingsRoot = path.resolve(options['settings-root']);
const settingsFile = path.join(settingsRoot, '.runtime', 'settings', 'model.json');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const settingsHash = () => digest(fs.readFileSync(settingsFile));
const casesFile = path.join(__dirname, 'fixtures/effect_acceptance/cases.json');
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8').replace(/^\uFEFF/, ''));
const settings = require('../src/core/model_settings');
const loaded = settings.resolveRuntimeModelConfig({ root: settingsRoot, readOnly: true });
if (!settings.isModelReady(loaded) || loaded.modelConfig.provider === 'mock') throw Error('A real, ready model is required');
const real = require('../src/adapters/models').createModelAdapter(loaded.modelConfig);
const results = { schema: 1, phase: options.phase, startedAt: new Date().toISOString(),
  evidenceType: 'real configured model; synthetic personas; in-memory SQLite; no platform operations; manual content verdict required',
  source: { sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
    diffHash: digest(execFileSync('git', ['-c', 'core.safecrlf=false', 'diff', '--binary'], { cwd: workspace })) },
  casesHash: digest(fs.readFileSync(casesFile)), model: { provider: real.provider, model: real.model },
  settingsHashBefore: settingsHash(), calls: [], cases: [] };
const save = () => fs.writeFileSync(output, JSON.stringify(results, null, 2));
const safeError = e => ({ code: e.code || e.name, message: String(e.message || '').replace(/[A-Za-z0-9_-]{32,}/g, '[token]') });
const adapter = new Proxy(real, { get(target, key) {
  const value = target[key]; if (typeof value !== 'function') return value;
  return async (...args) => {
    const call = { method: key, input: structuredClone(args[0]), startedAt: new Date().toISOString() };
    results.calls.push(call); save(); console.log(`START ${key}`); const started = Date.now();
    try { const result = await value.apply(target, args); call.output = result; return result; }
    catch (e) { call.error = safeError(e); throw e; }
    finally { call.elapsedMs = Date.now() - started; save(); console.log(`END ${key} ${call.elapsedMs}ms`); }
  };
} });
async function sample(name, input, action) {
  const record = { name, input: structuredClone(input), status: 'running' }; results.cases.push(record); save();
  try { record.result = await action(); record.status = 'completed'; }
  catch (e) { record.error = safeError(e); record.status = 'failed'; }
  save(); console.log(`CASE ${name} ${record.status}`); return record.result;
}
function fixture(persona, platform = 'boss', { fullPosting = false } = {}) {
  const storage = require('../src/core/storage'); const db = storage.openDb(':memory:');
  const profile = { candidate: { name: persona.name, city: persona.city, targetTitles: persona.target },
    projects: [{ name: persona.id === 'pm-intern' ? '客服工单系统' : persona.id === 'backend-junior' ? '订单后台' : '详情页迭代', canSay: [persona.resume] }] };
  const owner = storage.saveProfileAnalysis(db, { profile, document: { text: persona.resume, contentHash: digest(persona.resume),
    format: 'text', originalFileName: `${persona.id}.txt` }, searchPlan: { name: `${persona.id} 合成方案`, directions: persona.target } });
  const sourceKey = platform === 'zhaopin' ? '1234567890123456' : `synthetic-${persona.id}`;
  const jobInput = persona.jobs[0];
  // Message discovery requires a complete posting. Add only supplied metadata,
  // not new qualifications or duplicated duties, to the frozen concise JD.
  const description = fullPosting ? `岗位名称：${jobInput.title}\n公司名称：验收合成公司（虚构企业，仅供效果验收）\n工作地点：${persona.city}\n岗位职责及任职条件：\n${jobInput.jd}\n工作职责、经验要求及技能要求以上述描述为准。` : jobInput.jd;
  const batch = storage.createBatch(db, platform, jobInput.title, 'effect', { profileId: owner.profileId, searchPlanId: owner.planId });
  const jobId = storage.upsertJob(db, { source: platform, sourceId: sourceKey, title: jobInput.title,
    company: '验收合成公司', description, analysis: { semanticStatus: 'complete', recommendation: 'apply', coreResponsibilities: [jobInput.jd] } }, batch);
  return { db, owner, profile, sourceJobId: `${platform}:${sourceKey}`, job: { id: jobId, title: jobInput.title, company: '验收合成公司', description } };
}
async function runOnboarding(persona) {
  const service = require('../src/core/profile_onboarding');
  const analyzerFactory = () => require('../src/core/llm_analyzer').createLlmAnalyzer({ modelConfig: loaded.modelConfig, adapter });
  const input = { modelConfig: loaded.modelConfig, resume: { text: persona.resume, originalFileName: `${persona.id}.txt`, format: 'text' },
    identity: { names: [persona.name] }, strictPrivacy: true, analyzerFactory };
  const profile = await sample(`${persona.id}/profile`, { resume: persona.resume }, () => service.analyzeResumeProfile(input));
  if (profile) {
    await sample(`${persona.id}/search-plan`, { profile }, () => service.recommendPlanForProfile({ modelConfig: loaded.modelConfig, profile, analyzerFactory }));
    await sample(`${persona.id}/matching-card`, { profile }, () => service.buildCandidateMatchCard({ modelConfig: loaded.modelConfig, profile, adapter }));
  }
}
async function runResume(persona) {
  const f = fixture(persona);
  try {
    let resumeAdapter = adapter;
    if (options['replay-resume']) {
      const evidenceFile = path.resolve(options['replay-resume']);
      const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
      if (evidence.casesHash !== results.casesHash) throw Error('Resume evidence belongs to different cases');
      results.evidenceType = 'replay of untouched saved model output through current application; synthetic data; no new model call; not a fresh generation verdict';
      results.replayedEvidence = { file: evidenceFile, hash: digest(fs.readFileSync(evidenceFile)) };
      resumeAdapter = { provider: 'recorded-real-model', model: evidence.model.model, async generateResumeOptimization(input) {
        const call = evidence.calls.find(call => call.method === 'generateResumeOptimization' && call.input.mode === input.mode
          && call.input.sourceResume.contentHash === input.sourceResume.contentHash);
        if (!call?.output) throw Error('No exact saved model input found');
        return structuredClone(call.output);
      } };
    }
    const service = require('../src/application/resume_optimization').createResumeOptimizationService({ db: f.db, adapter: resumeAdapter });
    for (const mode of ['general', 'job_specific']) {
      if (options.mode && options.mode !== mode) continue;
      const input = { profileId: f.owner.profileId, planId: f.owner.planId, sourceResumeVersionId: f.owner.resumeVersionId, mode,
        ...(mode === 'job_specific' ? { jobId: f.job.id } : {}) };
      const draft = await sample(`${persona.id}/resume-${mode}`, input, () => service.createDraft(input));
      if (draft) await sample(`${persona.id}/activate-${mode}`, { draftId: draft.id, text: draft.generatedText },
        () => service.activateDraft({ ...input, draftId: draft.id, finalText: draft.generatedText }));
    }
  } finally { f.db.close(); }
}
async function runReply(persona) {
  const f = fixture(persona); const analyze = require('../src/core/message_reply_analyzer').createMessageReplyAnalyzer({ adapter });
  try {
    const hrMessages = [
      ['project-resume', `你在${f.profile.projects[0].name}里具体做了哪些工作？请发一份简历。`, [{ kind: 'resume_request' }]],
      ['known-conditions', '你现在在职吗？期望薪资多少？能接受长期出差吗？', []],
      ['unknown-method', '你是怎样验证这个项目的效果的？具体怎么做的？', []],
      ['resume-only', '方便发一下附件简历吗？', [{ kind: 'resume_request' }]],
      ['rejection', '不好意思，经历不太合适，这次就不继续了。', []],
      ['reschedule', '明天下午不太方便，后天的面试时间可以再沟通。', []]
    ];
    for (const [id, text, requestedActions] of hrMessages) {
      const input = { profile: f.profile, currentResume: { text: persona.resume }, job: f.job,
        platform: persona.id === 'backend-junior' ? 'zhaopin' : 'boss', messages: [{ text }], requestedActions,
        now: '2026-10-08T01:00:00.000Z', facts: [
          { key: 'employment_status', value: persona.status, source: 'user_confirmed', updatedAt: '2026-10-08T00:00:00Z' },
          { key: 'expected_salary', value: persona.salary, source: 'user_confirmed', updatedAt: '2026-10-08T00:00:00Z' },
          { key: 'accepts_travel', value: persona.travel, source: 'user_confirmed', updatedAt: '2026-10-08T00:00:00Z' }
        ] };
      await sample(`${persona.id}/reply-${id}`, input, () => analyze(input));
    }
  } finally { f.db.close(); }
}
async function runMessages(persona) {
  let messageAdapter = adapter;
  if (options['replay-messages']) {
    const evidenceFile = path.resolve(options['replay-messages']);
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    if (evidence.casesHash !== results.casesHash) throw Error('Message evidence belongs to different cases');
    results.evidenceType = 'untouched recorded real replies replayed through current discovery and quality checks; no fresh model generation or platform operations';
    results.replayedEvidence = { file: evidenceFile, hash: digest(fs.readFileSync(evidenceFile)) };
    messageAdapter = { provider: 'recorded-real-model', model: evidence.model.model, async draftMessageGroup(input) {
      const call = evidence.calls.find(item => item.method === 'draftMessageGroup'
        && JSON.stringify(item.input.messages) === JSON.stringify(input.messages)
        && item.input.currentResume?.text === input.currentResume?.text
        && Boolean(item.input.draftQualityRevision) === Boolean(input.draftQualityRevision));
      if (!call?.output) throw Error('No exact saved message and resume input');
      return structuredClone(call.output);
    } };
  }
  const platform = persona.id === 'backend-junior' ? 'zhaopin' : 'boss';
  const inputs = [
    ['project-and-resume', '你在最近的项目中具体做了哪些工作？请发一份简历。'],
    ['known-conditions', '你现在在职吗？期望薪资多少？能接受长期出差吗？'],
    ['resume-only', '方便发一下附件简历吗？'],
    ['rejection', '不好意思，经历不太合适，这次就不继续了。'],
    ['referral', '这个岗位暂停了，另一个相近的初级岗位愿意了解吗？'],
    ['interview-system', '这个岗位主要负责开发面试安排系统，不是通知你参加面试。'],
    ['member-promotion', '你与该职位竞争者PK情况共人投递，你超过竞争者优秀竞争者会，建议你查看详细分析'],
    ['unknown-method', '你是怎样验证这个项目的效果的？具体怎么做的？'],
    ['reschedule', cases.messageCases.find(item => item.id === 'scheduling-conflict').message],
    ['interest-greeting', cases.messageCases.find(item => item.id === 'interest-greeting').message]
  ];
  for (const [id, text] of inputs) {
    if (options['message-case'] && !String(options['message-case']).split(',').includes(id)) continue;
    const f = fixture(persona, platform, { fullPosting: true }); const storage = require('../src/core/storage');
    try {
      for (const [factKey, factValue] of [['employment_status', persona.status], ['expected_salary', persona.salary], ['accepts_travel', persona.travel]]) {
        storage.saveCandidateFact(f.db, { profileId: f.owner.profileId, factKey, factValue, source: 'user_provided' });
      }
      require('../src/core/candidate_progress').ensureProgressCard(f.db, { profileId: f.owner.profileId, planId: f.owner.planId,
        jobId: f.job.id, source: platform, stage: 'contact_started' });
      const { safeDigest } = require('../src/adapters/sites/boss_message_dom');
      const conversationKey = safeDigest([persona.id, platform, id]); const now = '2026-10-08T01:00:00.000Z';
      const row = { rowIndex: 0, unread: true, selected: false, recruiterLabel: '合成HR', recruiterKey: safeDigest(['hr', id]),
        conversationKey, previewText: text, previewDigest: safeDigest([text]), previewKind: 'possible_hr_reply',
        transientSignature: safeDigest(['row', id]), sourceJobId: f.sourceJobId, lastMessageId: '123456789011111',
        lastMessageDirection: 'friend', lastActivityAt: now, identityVerified: true };
      const reader = {
        async scanConversationRows() { return { tabId: 'fixture', path: '/web/geek/chat', rows: [row],
          coverage: { complete: true, reasonCode: '' } }; },
        async openQueuedConversation() { return { skipped: false, path: '/web/geek/chat', headerText: '合成HR',
          positionName: f.job.title, city: persona.city, companyName: f.job.company, sourceJobId: f.sourceJobId, lastMessageId: row.lastMessageId,
          identityVerified: true, risk: false, login: false, rows: [{ ...row, selected: true }],
          messages: [{ direction: id === 'member-promotion' ? 'platform' : 'friend', messageId: row.lastMessageId, text,
            contentKind: id === 'member-promotion' ? 'platform_notice' : 'text',
            ...(id === 'member-promotion' ? { noticeKind: 'competition_promotion' } : {}), occurredAt: now }] }; }
      };
      await sample(`${persona.id}/messages-${id}`, { platform, text, resume: persona.resume, job: f.job,
        browserEvidence: 'synthetic message reader; complete local JD; real platform reading not tested' }, async () => {
        const sync = await require('../src/application/message_discovery/run').runBossMessageDiscovery({ db: f.db,
          profileId: f.owner.profileId, platform, reader, now: () => now, sleepFn: async () => {},
          ...(platform === 'zhaopin' ? { resolveJobContext: require('../src/application/message_discovery/zhaopin_job_context')
            .createZhaopinMessageJobContextResolver({ db: f.db, profileId: f.owner.profileId, now: () => now }) } : {}),
          classifyMessageGroup: require('../src/core/message_reply_analyzer').createMessageReplyAnalyzer({ adapter: messageAdapter }) });
        return { sync, inbox: require('../src/storage/message_inbox_store').listMessageInboxItems(f.db, { profileId: f.owner.profileId }),
          drafts: storage.listOpenMessageReplyDrafts(f.db, { profileId: f.owner.profileId }) };
      });
    } finally { f.db.close(); }
  }
}
async function runLearning(persona) {
  const f = fixture(persona, 'boss', { fullPosting: true });
  const storage = require('../src/core/storage');
  const { createMessageReplyAnalyzer } = require('../src/core/message_reply_analyzer');
  const analyze = createMessageReplyAnalyzer({ adapter });
  const learning = require('../src/application/message_learning').createMessageReplyLearningService({ db: f.db, adapter });
  const question = '你是怎样验证这个项目的效果的？具体怎么做的？';
  const base = { profile: f.profile, currentResume: { text: persona.resume }, job: f.job, platform: 'boss',
    now: '2026-10-08T01:00:00.000Z', messages: [{ text: question }], requestedActions: [], facts: [] };
  const material = () => {
    const data = learning.listCommunicationProfile({ profileId: f.owner.profileId });
    return { answerMemories: data.answers, candidateEvidence: data.evidence };
  };
  try {
    await sample(`${persona.id}/learning-before`, base, () => analyze({ ...structuredClone(base), ...material() }));
    const card = require('../src/core/candidate_progress').ensureProgressCard(f.db, { profileId: f.owner.profileId,
      planId: f.owner.planId, jobId: f.job.id, source: 'boss', stage: 'contact_started' });
    const [draft] = storage.recordMessageReplyDrafts(f.db, { profileId: f.owner.profileId, cardId: card.id, jobId: f.job.id,
      messageGroupKey: `sha256:${digest(persona.id + '-learning')}`, questionSummary: question,
      messageIntent: 'information_request', messageCategory: 'project_fact', messages: ['我参与了这个项目。'] });
    const learned = await sample(`${persona.id}/adopt-edited-answer`, { finalText: persona.newEvidence,
      origin: 'controlled original draft; synthetic user adopts their frozen truthful addition; no platform send' },
      () => learning.completeDraft({ profileId: f.owner.profileId, draftId: draft.id, finalText: persona.newEvidence, completionKind: 'copied' }));
    if (!learned) return;
    await sample(`${persona.id}/learning-after`, { ...base, material: material() }, () => analyze({ ...structuredClone(base), ...material() }));
    const evidence = require('../src/storage/candidate_evidence_store').listCandidateEvidence(f.db, { profileId: f.owner.profileId });
    for (const entry of evidence) learning.withdrawEvidence({ profileId: f.owner.profileId, id: entry.id });
    // The full answer is also explicitly withdrawn through the ordinary service.
    const memories = learning.listCommunicationProfile({ profileId: f.owner.profileId }).answers || [];
    for (const memory of memories) learning.withdrawMemory({ profileId: f.owner.profileId, memoryId: memory.id });
    await sample(`${persona.id}/learning-withdrawn`, { ...base, material: material() }, () => analyze({ ...structuredClone(base), ...material() }));
  } finally { f.db.close(); }
}
async function runJobs(persona) {
  if (!options['onboarding-evidence']) throw Error('jobs requires frozen real onboarding evidence');
  const evidenceFile = path.resolve(options['onboarding-evidence']);
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  if (evidence.casesHash !== results.casesHash) throw Error('Onboarding evidence belongs to different cases');
  results.onboardingEvidence = { file: evidenceFile, hash: digest(fs.readFileSync(evidenceFile)) };
  const find = suffix => evidence.cases.find(item => item.name === `${persona.id}/${suffix}`)?.result;
  let profile = find('profile');
  const plan = find('search-plan'), card = find('matching-card');
  if (!profile || !plan || !card) throw Error('Missing actual onboarding outputs');
  if (options['replay-profile-with-source']) {
    const service = require('../src/core/profile_onboarding');
    const prepared = service.prepareResumeTextForModel(persona.resume, {
      originalFileName: `${persona.id}.txt`, identity: { names: [persona.name] }, strict: true
    });
    const call = evidence.calls.find(item => item.method === 'analyzeResume' && item.input.resumeText === prepared.text);
    if (!call?.output) throw Error('No exact masked resume input for profile replay');
    profile = await service.analyzeResumeProfile({ modelConfig: loaded.modelConfig,
      resume: { text: persona.resume, originalFileName: `${persona.id}.txt`, format: 'text' }, preparedModelInput: prepared,
      analyzerFactory: () => ({ analyzeResume: async input => {
        if (input.resumeText !== call.input.resumeText) throw Error('Profile replay input changed');
        return structuredClone(call.output);
      } }) });
    results.profileEvidenceType = 'untouched recorded profile model output, exact masked resume input, current profile normalization; matching calls are fresh real generation';
  }
  const configs = require('../src/core/search_plan').profileToRuntimeConfigs(require('../src/config').loadConfigs(workspace), profile, plan, [], card);
  configs.model = loaded.modelConfig;
  const db = require('../src/core/storage').openDb(':memory:');
  const analyzer = require('../src/core/llm_analyzer').createLlmAnalyzer({ modelConfig: loaded.modelConfig, adapter });
  const run = require('../src/core/job_analysis').createJobAnalysisRunner(configs, [], { db, analyzer, errorMode: 'throw' });
  try {
    for (const [index, item] of persona.jobs.entries()) {
      if (options['job-class'] && options['job-class'] !== item.id) continue;
      const job = { source: 'boss', sourceId: `synthetic-${persona.id}-${index}`, title: item.title, company: '验收合成公司',
        location: persona.city, salary: '', bossActiveText: '今日活跃', tags: [], qualityTags: [], risks: [],
        description: `岗位名称：${item.title}\n公司：验收合成公司（虚构企业，仅供效果验收）\n工作地点：${persona.city}\n岗位职责及任职条件：\n${item.jd}\n具体职责和条件以上述说明为准。`,
        detailRead: true, detailRequired: true };
      await sample(`${persona.id}/job-${index + 1}`, { job, expectedClass: item.id, candidateProfile: profile, matchingCard: card }, () => run(job));
    }
  } finally { db.close(); }
}
async function runCommunication(persona) {
  if (!options['jobs-evidence']) throw Error('communication requires saved actual matching evidence');
  const evidenceFile = path.resolve(options['jobs-evidence']);
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  if (evidence.casesHash !== results.casesHash) throw Error('Matching evidence belongs to different cases');
  const saved = evidence.cases.find(item => item.name === `${persona.id}/job-1`);
  if (!saved?.result || !saved.input?.candidateProfile) throw Error('Missing actual direct job/profile');
  results.sourceMatchingEvidence = { file: evidenceFile, hash: digest(fs.readFileSync(evidenceFile)) };
  results.evidenceType = 'fresh communication generation through production analyzer contract; same saved real profile/JD/matching projection as Dashboard; no eligibility or platform execution claim';
  const { riskMessaging: ignored, ...candidateProfile } = saved.input.candidateProfile;
  const job = saved.input.job, analysis = saved.result;
  const analyzer = require('../src/core/llm_analyzer').createLlmAnalyzer({ modelConfig: loaded.modelConfig, adapter });
  const input = {
    candidateProfile,
    resumeVersions: [],
    jobUnderstanding: { jobId: job.sourceId, realRoleType: analysis.realRoleType || 'unknown',
      businessScenario: analysis.businessScenario || '', coreRequirements: analysis.coreRequirements || [],
      coreStack: analysis.coreStack || [], hiddenRisks: analysis.hiddenRisks || [], evidenceSnippets: analysis.evidence?.jd || [] },
    matchDecision: analysis,
    jobEvidence: { title: job.title, company: job.company, description: job.description, salary: job.salary, experience: job.experience },
    hrMessage: '', userProvidedFacts: persona.facts || []
  };
  // Greeting eligibility remains a product concern: do not bypass it for non-primary samples.
  const modes = analysis.recommendation === 'primary' ? ['greeting', 'follow_up'] : ['follow_up'];
  for (const mode of modes) {
    if (options.mode && options.mode !== mode) continue;
    await sample(`${persona.id}/${mode}`, { ...input, mode },
      () => analyzer.draftCommunication({ ...structuredClone(input), mode }));
  }
}
async function runMatchingCard(persona) {
  if (!options['onboarding-evidence']) throw Error('matching-card requires saved actual onboarding evidence');
  const file = path.resolve(options['onboarding-evidence']);
  const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (evidence.casesHash !== results.casesHash) throw Error('Profile evidence belongs to different cases');
  const profile = evidence.cases.find(item => item.name === `${persona.id}/profile`)?.result;
  if (!profile) throw Error('Missing actual profile');
  results.sourceProfileEvidence = { file, hash: digest(fs.readFileSync(file)) };
  await sample(`${persona.id}/matching-card`, { profile }, () => require('../src/core/profile_onboarding')
    .buildCandidateMatchCard({ modelConfig: loaded.modelConfig, profile: structuredClone(profile), adapter }));
}
function truthfulInterviewAnswer(persona, question) {
  // Synthetic user answers are selected from already frozen facts, never a model-written ideal story.
  const lines = persona.resume.split('\n');
  const meaningful = lines.filter(line => line.length > 30 && !line.startsWith('联系方式'));
  let answer;
  if (/验证|反馈|效果|复盘/.test(question)) answer = persona.newEvidence;
  else if (/状态|异常|开发|工单/.test(question) && persona.id === 'pm-intern') {
    answer = meaningful.find(line => line.includes('状态流转图'));
  } else if (/性能|查询|索引|SQL|响应/.test(question) && persona.id === 'backend-junior') {
    answer = meaningful.find(line => line.includes('480ms'));
  } else if (/Python|FastAPI|转语言/.test(question) && persona.id === 'backend-junior') {
    answer = meaningful.find(line => line.includes('SQLite'));
  } else if (/会员|分组|触达/.test(question) && persona.id === 'ecommerce-ops') {
    answer = meaningful.find(line => line.includes('会员分组'));
  } else answer = meaningful.find(line => /参与|完成|负责|分析|整理|制作|协助|改写|迭代/.test(line));
  return `${answer || persona.newEvidence} 我能确认的是上述个人工作；没有记录的具体做法或结果，我不能补成做过。`;
}
async function runInterview(persona) {
  const f = fixture(persona);
  try {
    let interviewAdapter = adapter;
    let replayedInterviewEvidence;
    if (options['replay-interview-steps']) {
      const evidenceFile = path.resolve(options['replay-interview-steps']);
      const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
      if (evidence.casesHash !== results.casesHash) throw Error('Interview evidence belongs to different cases');
      replayedInterviewEvidence = evidence;
      results.sourceStepsEvidence = { file: evidenceFile, hash: digest(fs.readFileSync(evidenceFile)) };
      results.evidenceType = 'saved real questions and user answers replayed through current service; newly generated real reports; no platform operations';
      interviewAdapter = { provider: adapter.provider, model: adapter.model,
        reviewMockInterview: adapter.reviewMockInterview, reviewMockInterviewRetry: adapter.reviewMockInterviewRetry,
        async generateMockInterviewStep(input) {
          const call = evidence.calls.find(call => call.method === 'generateMockInterviewStep'
            && call.input.context.sessionKind === input.context.sessionKind && call.input.turns.length === input.turns.length
            && !call.input.questionRevision);
          if (!call?.output) throw Error('Missing exact saved step');
          if (JSON.stringify(call.input.context.resumeEvidenceCatalog) !== JSON.stringify(input.context.resumeEvidenceCatalog)
            || JSON.stringify(call.input.turns.map(turn => [turn.question, turn.answer])) !== JSON.stringify(input.turns.map(turn => [turn.question, turn.answer]))) {
            throw Error('Saved step belongs to different resume or answers');
          }
          return structuredClone(call.output);
        }
      };
      if (options['replay-interview-report']) {
        const reportFile = path.resolve(options['replay-interview-report']);
        const savedReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        if (savedReport.casesHash !== results.casesHash) throw Error('Report belongs to different cases');
        results.sourceReportEvidence = { file: reportFile, hash: digest(fs.readFileSync(reportFile)) };
        results.evidenceType = 'exact recorded questions, answers and reports replayed through service; only retry comparison is fresh real generation';
        interviewAdapter.reviewMockInterview = async input => {
          const call = savedReport.calls.find(item => item.method === 'reviewMockInterview'
            && item.input.context.sessionKind === input.context.sessionKind);
          if (!call?.output || JSON.stringify(call.input.turns.map(turn => [turn.question, turn.answer]))
            !== JSON.stringify(input.turns.map(turn => [turn.question, turn.answer]))) throw Error('Report replay answers changed');
          return structuredClone(call.output);
        };
      }
    }
    const service = require('../src/application/mock_interview').createMockInterviewService({ db: f.db, adapter: interviewAdapter });
    for (const sessionKind of ['resume_general', 'job_specific']) {
      if (options.mode && options.mode !== sessionKind) continue;
      const identity = { profileId: f.owner.profileId, planId: f.owner.planId, resumeVersionId: f.owner.resumeVersionId };
      const input = { ...identity, sessionKind, settings: { plannedQuestions: 3, type: 'mixed', difficulty: 'standard' },
        ...(sessionKind === 'job_specific' ? { jobId: f.job.id } : {}) };
      let session = await sample(`${persona.id}/${sessionKind}/first`, input, () => service.startSession(input));
      if (!session) continue;
      const sessionId = session.id;
      for (let turnNumber = 1; turnNumber <= 3; turnNumber++) {
        const turn = session.turns.find(turn => turn.turnNumber === turnNumber); if (!turn) break;
        const answerText = replayedInterviewEvidence
          ? replayedInterviewEvidence.cases.find(item => item.name === `${persona.id}/${sessionKind}/answer-${turnNumber}`)?.input.answerText
          : turnNumber === 1 ? '我主要参与了相关工作，做了一些整理，具体做法一时没想清楚。'
            : truthfulInterviewAnswer(persona, turn.questionText);
        if (!answerText) throw Error('Missing exact recorded user answer');
        const answer = { ...identity, sessionId, turnNumber, answerText };
        session = await sample(`${persona.id}/${sessionKind}/answer-${turnNumber}`, answer, () => service.answerTurn(answer));
        if (!session) break;
      }
      if (!session) continue;
      const report = await sample(`${persona.id}/${sessionKind}/report`, { sessionId },
        () => service.finishSession({ ...identity, sessionId }));
      if (!report) continue;
      if (options['report-only']) continue;
      const firstQuestion = session.turns.find(turn => turn.turnNumber === 1).questionText;
      for (const [type, answerText] of [
        ['long-off-topic', '我昨晚看电影，今天准备逛公园，晚饭吃火锅，我喜欢聊旅行和综艺节目。'.repeat(7)],
        ['relevant-evidence', truthfulInterviewAnswer(persona, firstQuestion)]
      ]) {
        const retry = { ...identity, sessionId, turnNumber: 1, answerText };
        await sample(`${persona.id}/${sessionKind}/retry-${type}`, retry, () => service.retryTurn(retry));
      }
    }
  } finally { f.db.close(); }
}
async function main() {
  const tasks = { onboarding: runOnboarding, resume: runResume, reply: runReply, interview: runInterview, messages: runMessages, learning: runLearning, jobs: runJobs, communication: runCommunication, 'matching-card': runMatchingCard };
  const task = tasks[options.phase]; if (!task) throw Error('Phase not implemented; do not claim acceptance');
  const personas = options.phase === 'resume' ? [...cases.personas, cases.goodResumeControl] : cases.personas;
  for (const persona of personas) if (!options.persona || String(options.persona).split(',').includes(persona.id)) await task(persona);
}
main().catch(e => { results.fatal = safeError(e); process.exitCode = 1; }).finally(() => {
  results.settingsHashAfter = settingsHash(); results.settingsUnchanged = results.settingsHashBefore === results.settingsHashAfter;
  results.finishedAt = new Date().toISOString(); save(); console.log('SAMPLING FINISHED; CONTENT VERDICT PENDING');
});
