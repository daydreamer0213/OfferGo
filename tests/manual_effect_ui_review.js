// Manual, zero-model replay of saved real outputs. Deliberately absent from the offline manifest.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const storage = require('../src/core/storage');
const { createResumeOptimizationService } = require('../src/application/resume_optimization');
const { createMockInterviewService } = require('../src/application/mock_interview');
const { createMessageReplyAnalyzer } = require('../src/core/message_reply_analyzer');
const { runBossMessageDiscovery } = require('../src/application/message_discovery/run');
const { createZhaopinMessageJobContextResolver } = require('../src/application/message_discovery/zhaopin_job_context');
const { ensureProgressCard } = require('../src/core/candidate_progress');
const { safeDigest } = require('../src/adapters/sites/boss_message_dom');
const { createDashboardServer } = require('../src/dashboard/server');
const { resolveRuntimeModelConfig, isModelReady } = require('../src/core/model_settings');

const workspace = path.resolve(__dirname, '..');
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  if (!arg.startsWith('--') || index < 0) throw Error('Use --runs-root=<D drive directory> or --output-root=<D drive directory>');
  return [arg.slice(2, index), arg.slice(index + 1)];
}));
const runsRoot = path.resolve(options['runs-root'] || 'D:/DevData/OfferGo-validation/2026-10-08/deep-effect/runs');
const outputRoot = path.resolve(options['output-root'] || path.join(runsRoot, 'ux-real-replayed'));
if (!/^D:[\\/]/i.test(outputRoot)) throw Error('Manual replay artifacts must stay on D:');
fs.mkdirSync(outputRoot, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(outputRoot, 'run-'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const result = {
  schema: 1, startedAt: new Date().toISOString(), runRoot,
  evidenceType: 'saved real output replay, not fresh generation; synthetic source material; no platform operations',
  modelCalls: 0, serverOptions: { forceMock: false, allowOfflineMock: false, apiKeyConfigured: false },
  sources: [], replayCalls: [], checks: [], screenshots: [], pageErrors: [], externalRequests: [], issues: []
};
function loadEvidence(name) {
  const file = path.join(runsRoot, name), bytes = fs.readFileSync(file);
  const evidence = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  assert.notEqual(evidence.model?.provider, 'mock');
  result.sources.push({ file, sha256: digest(bytes), model: evidence.model, evidenceType: evidence.evidenceType });
  const snapshot = path.join(runRoot, 'source-snapshots', name);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, bytes);
  return evidence;
}
function recordReplay(file, evidence, call, checks) {
  assert(call?.output, `Missing completed real output in ${file}`);
  result.replayCalls.push({ file, callIndex: evidence.calls.indexOf(call), method: call.method,
    outputSha256: digest(JSON.stringify(call.output)), factualInputChecks: checks });
  return structuredClone(call.output);
}
function check(label, evidence) { result.checks.push({ label, evidence }); }
function profileFor(persona) {
  return { candidate: { name: persona.name, city: persona.city, targetTitles: persona.target },
    projects: [{ name: '订单后台', canSay: [persona.resume] }] };
}
function seedOwner(db, persona) {
  return storage.saveProfileAnalysis(db, { profile: profileFor(persona),
    document: { text: persona.resume, contentHash: digest(persona.resume), format: 'text', originalFileName: `${persona.id}.txt` },
    searchPlan: { name: `${persona.id} 合成方案`, directions: persona.target } });
}
function seedJob(db, owner, input, analysis, sourceId) {
  const platform = input.source || 'boss';
  const batchId = storage.createBatch(db, platform, input.title, 'saved real output replay, not fresh generation',
    { profileId: owner.profileId, searchPlanId: owner.planId });
  return storage.upsertJob(db, { ...input, source: platform, sourceId: sourceId || input.sourceId,
    ...analysis, analysis }, batchId);
}

async function seedMessage(db, persona, evidence, richAnalysis, suffix) {
  const saved = evidence.cases.find(item => item.name === `${persona.id}/messages-${suffix}`);
  assert(saved, `Missing message case ${suffix}`);
  const owner = seedOwner(db, persona);
  for (const [factKey, factValue] of [['employment_status', persona.status], ['expected_salary', persona.salary], ['accepts_travel', persona.travel]]) {
    storage.saveCandidateFact(db, { profileId: owner.profileId, factKey, factValue, source: 'user_provided' });
  }
  const jobId = seedJob(db, owner, { ...saved.input.job, source: 'zhaopin' }, richAnalysis, '1234567890123456');
  ensureProgressCard(db, { profileId: owner.profileId, planId: owner.planId, jobId, source: 'zhaopin', stage: 'contact_started' });
  const now = '2026-10-08T01:00:00.000Z', text = saved.input.text;
  const sourceJobId = 'zhaopin:1234567890123456';
  const row = { rowIndex: 0, unread: true, selected: false, recruiterLabel: '合成HR', recruiterKey: safeDigest(['hr', suffix]),
    conversationKey: safeDigest([persona.id, 'zhaopin', suffix]), previewText: text, previewDigest: safeDigest([text]),
    previewKind: 'possible_hr_reply', transientSignature: safeDigest(['row', suffix]), sourceJobId,
    lastMessageId: '123456789011111', lastMessageDirection: 'friend', lastActivityAt: now, identityVerified: true };
  const reader = {
    async scanConversationRows() { return { tabId: 'saved-evidence', path: '/web/geek/chat', rows: [row], coverage: { complete: true } }; },
    async openQueuedConversation() { return { skipped: false, path: '/web/geek/chat', headerText: '合成HR',
      positionName: saved.input.job.title, city: persona.city, companyName: saved.input.job.company, sourceJobId,
      lastMessageId: row.lastMessageId,
      identityVerified: true, risk: false, login: false, rows: [{ ...row, selected: true }],
      messages: [{ direction: 'friend', messageId: row.lastMessageId, text, contentKind: 'text', occurredAt: now }] }; }
  };
  const adapter = { provider: 'recorded-real-model', model: evidence.model.model, async draftMessageGroup(input) {
    const call = evidence.calls.find(item => item.method === 'draftMessageGroup'
      && JSON.stringify(item.input.messages.map(message => message.text)) === JSON.stringify(input.messages.map(message => message.text))
      && item.input.currentResume?.text === input.currentResume?.text
      && Boolean(item.input.draftQualityRevision) === Boolean(input.draftQualityRevision));
    assert(call, `No exact recorded HR text/resume/revision for ${suffix}`);
    assert.deepEqual(input.facts.map(fact => [fact.key, fact.value]), call.input.facts.map(fact => [fact.key, fact.value]));
    assert.deepEqual(input.requestedActions, call.input.requestedActions);
    assert.equal(input.job.description, call.input.job.description);
    assert.equal(input.job.title, call.input.job.title);
    assert.deepEqual(input.answerMemories, call.input.answerMemories);
    assert.deepEqual(input.candidateEvidence, call.input.candidateEvidence);
    return recordReplay('messages-backend-current.json', evidence, call,
      ['exact HR text, masked source resume, user facts, actions, JD/title, empty memories/evidence; transport IDs and fact timestamps may differ',
        'visible matching analysis is the saved real jobs-first backend/job-1 result for these same duties']);
  } };
  const sync = await runBossMessageDiscovery({ db, profileId: owner.profileId, platform: 'zhaopin', reader,
    now: () => now, sleepFn: async () => {},
    resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: owner.profileId, now: () => now }),
    classifyMessageGroup: createMessageReplyAnalyzer({ adapter }) });
  assert.equal(sync.unresolved, 0);
  const item = sync.results[0];
  assert(item?.messages?.length, `No real reply rendered for ${suffix}`);
  check(`message-${suffix}-replayed`, { owner, originalHRText: text, visibleResult: item });
  return { owner, suffix, text, item };
}

(async () => {
  const dbPath = path.join(runRoot, 'synthetic.sqlite');
  const db = storage.openDb(dbPath);
  let server, browser, page;
  try {
    const casesBytes = fs.readFileSync(path.join(__dirname, 'fixtures/effect_acceptance/cases.json'));
    const persona = JSON.parse(casesBytes).personas.find(item => item.id === 'backend-junior');
    const resumeEvidence = loadEvidence('resume-first.json');
    const messageEvidence = loadEvidence('messages-backend-current.json');
    const jobEvidence = loadEvidence('jobs-first.json');
    const interviewEvidence = loadEvidence('interview-backend-first.json');
    const reportEvidence = loadEvidence('interview-report-fixed-backend.json');
    for (const evidence of [resumeEvidence, messageEvidence, jobEvidence, interviewEvidence, reportEvidence]) {
      assert.equal(evidence.casesHash, digest(casesBytes), 'Evidence must belong to the frozen personas');
    }
    const jobCase = jobEvidence.cases.find(item => item.name === 'backend-junior/job-1');
    assert.equal(jobCase.input.expectedClass, 'direct');
    assert(jobCase.result.roleResumeEvidence?.length && jobCase.result.responsibilityEvidence?.length);
    const owner = seedOwner(db, persona);
    const jobId = seedJob(db, owner, jobCase.input.job, jobCase.result);
    const resumeCall = resumeEvidence.calls.find(call => call.method === 'generateResumeOptimization'
      && call.input.mode === 'general' && call.input.sourceResume.contentHash === digest(persona.resume));
    assert(resumeCall);
    const resumeService = createResumeOptimizationService({ db, adapter: {
      provider: 'recorded-real-model', model: resumeEvidence.model.model,
      async generateResumeOptimization(input) {
        assert.equal(input.sourceResume.text, resumeCall.input.sourceResume.text);
        assert.equal(input.sourceResume.contentHash, resumeCall.input.sourceResume.contentHash);
        for (const key of ['candidateEvidence', 'candidateFacts', 'answerMemories']) assert.deepEqual(input[key], resumeCall.input[key]);
        assert.deepEqual(input.evidenceCatalog.filter(item => item.kind === 'resume'), resumeCall.input.evidenceCatalog.filter(item => item.kind === 'resume'));
        return recordReplay('resume-first.json', resumeEvidence, resumeCall, ['exact source text/hash, facts, memories, resume evidence anchors; current renderer']);
      }
    } });
    const draft = await resumeService.createDraft({ profileId: owner.profileId, planId: owner.planId,
      sourceResumeVersionId: owner.resumeVersionId, mode: 'general' });
    result.resume = { owner, draftId: draft.id, sourceText: draft.sourceText, generatedText: draft.generatedText,
      suggestions: draft.suggestions, sourceRawOutput: resumeCall.output, modelIdentity: draft.modelIdentity };

    const messages = [];
    for (const suffix of ['project-and-resume', 'known-conditions', 'unknown-method']) {
      messages.push(await seedMessage(db, persona, messageEvidence, jobCase.result, suffix));
    }
    const interview = createMockInterviewService({ db, adapter: {
      provider: 'recorded-real-model', model: interviewEvidence.model.model,
      async generateMockInterviewStep(input) {
        const call = interviewEvidence.calls.find(item => item.method === 'generateMockInterviewStep'
          && item.input.context.sessionKind === input.context.sessionKind && item.input.turns.length === input.turns.length
          && Boolean(item.input.questionRevision) === Boolean(input.questionRevision));
        assert(call, 'Missing exact recorded interview step');
        assert.deepEqual(input.context.resumeEvidenceCatalog, call.input.context.resumeEvidenceCatalog);
        assert.deepEqual(input.turns.map(turn => [turn.question, turn.answer]), call.input.turns.map(turn => [turn.question, turn.answer]));
        assert.deepEqual(input.settings, call.input.settings);
        return recordReplay('interview-backend-first.json', interviewEvidence, call, ['exact resume evidence, settings, questions and user answers']);
      },
      async reviewMockInterview(input) {
        const call = reportEvidence.calls.find(item => item.method === 'reviewMockInterview'
          && item.input.context.sessionKind === input.context.sessionKind && item.output);
        assert(call, 'Fixed real report must have finished before review');
        assert.deepEqual(input.context.resumeEvidenceCatalog, call.input.context.resumeEvidenceCatalog);
        assert.deepEqual(input.turns.map(turn => [turn.question, turn.answer]), call.input.turns.map(turn => [turn.question, turn.answer]));
        return recordReplay('interview-report-fixed-backend.json', reportEvidence, call, ['exact questions, answers and resume evidence; untouched completed real repaired report']);
      }
    } });
    const interviewInput = { profileId: owner.profileId, planId: owner.planId, resumeVersionId: owner.resumeVersionId,
      sessionKind: 'resume_general', settings: { plannedQuestions: 3, type: 'mixed', difficulty: 'standard' } };
    let session = await interview.startSession(interviewInput);
    const modelState = resolveRuntimeModelConfig({ root: runRoot, fallbackModelConfig: require('../configs/model.json') });
    assert.equal(isModelReady(modelState), false);
    assert.equal(modelState.keyConfigured, false);
    result.ordinaryModelState = { source: modelState.source, provider: modelState.modelConfig.provider, ready: false, keyConfigured: false };
    const logger = { info() {}, warn() {}, error() {}, requestId() { return crypto.randomUUID(); }, listRecent() { return []; } };
    server = createDashboardServer({ db, root: workspace, dataRoot: runRoot, dbPath,
      resumeOptimizationService: resumeService, mockInterviewService: interview, logger,
      browserAuthority: { browserMode: 'portable', cdpPort: 9222, profilePath: path.join(runRoot, 'isolated-edge') },
      browserFactory() { throw Error('No recruitment platform access permitted'); },
      spawnProcess() { throw Error('No product child process permitted'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) { result.externalRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', error => result.pageErrors.push(error.message));
    const go = async url => { await page.goto(base + url); await page.waitForLoadState('networkidle'); };
    const shot = async name => {
      const file = path.join(runRoot, `${name}.png`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: file, fullPage: true });
      result.screenshots.push({ file, evidenceType: result.evidenceType, url: page.url() });
    };

    await go(`/jobs?planId=${owner.planId}&batch=all`);
    const jobCard = page.locator('article.job').filter({ hasText: jobCase.input.job.title }).first();
    await jobCard.waitFor();
    const jobText = await jobCard.innerText();
    assert(jobText.includes('接口') && jobText.includes('SQL'));
    result.jobPage = { sourceCase: jobCase.name, text: jobText, explanationSource: jobCase.result };
    await shot('01-real-job-explanation');
    await jobCard.locator('details > summary').click();
    await shot('02-real-job-evidence-expanded');
    check('job explanation uses saved real responsibilities and personal evidence', { text: await jobCard.innerText() });

    for (const item of messages) {
      await go(`/messages?profileId=${item.owner.profileId}`);
      await page.locator('.message-list-item').first().click();
      const detail = page.locator('[data-message-detail-panel]:not([hidden])');
      await detail.waitFor();
      const actualDrafts = [];
      const draftFields = detail.locator('[data-draft-text]');
      for (let index = 0; index < await draftFields.count(); index++) actualDrafts.push(await draftFields.nth(index).inputValue());
      assert.deepEqual(actualDrafts, item.item.messages);
      const text = await detail.innerText();
      assert(text.includes(item.text));
      const order = await detail.evaluate(node => {
        const inbound = node.querySelector('.message-timeline, .message-inbound');
        const job = node.querySelector('.message-job-understanding');
        const draft = node.querySelector('.message-draft');
        const precedes = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
        return { hrBeforeJob: precedes(inbound, job), jobBeforeReply: precedes(job, draft) };
      });
      assert.deepEqual(order, { hrBeforeJob: true, jobBeforeReply: true });
      const controls = await detail.locator('button').allTextContents();
      if (item.suffix === 'project-and-resume') {
        assert(controls.some(label => label === '确认发送'));
        if (!controls.includes('同意发送简历')) result.issues.push({
          code: 'TEXT_RESUME_REQUEST_HAS_NO_RESUME_ACTION', sourceCase: `${persona.id}/messages-${item.suffix}`,
          originalInput: item.text, observation: 'Text-only request renders the project reply and text-send control, but no separate resume-send action. Original sample contains no platform resume card; action support must be judged within this scope.'
        });
      }
      const analysis = detail.locator('details.message-job-details');
      if (await analysis.count()) await analysis.locator('summary').click();
      result.messagePages ||= [];
      result.messagePages.push({ suffix: item.suffix, hrText: item.text, drafts: actualDrafts, text: await detail.innerText(), order, controls });
      await shot(`03-message-${item.suffix}`);
      check(`no-Key saved message ${item.suffix} is readable with original drafts`, { order, controls });
    }

    await go(`/resume-optimization?planId=${owner.planId}&draftId=${draft.id}`);
    const editor = page.locator('#resume-opt-final-text');
    assert.equal(await editor.inputValue(), draft.generatedText);
    assert.equal(await page.locator('details.resume-opt-technical').getAttribute('open'), null);
    const resumeActions = await page.getByRole('button').allTextContents();
    for (const label of ['复制当前全文', '保存草稿', '启用为新版本', '下载文字版', '打印 / 保存 PDF']) assert(resumeActions.includes(label));
    assert(await page.locator('button[data-resume-create-ready]').isDisabled());
    result.resume.pageText = await page.locator('#main-content').innerText();
    result.resume.editorText = await editor.inputValue();
    result.resume.controls = resumeActions;
    await shot('04-real-resume-general');
    const downloadWait = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载文字版', exact: true }).click();
    const download = await downloadWait, exportPath = path.join(runRoot, 'resume-current-renderer.txt');
    await download.saveAs(exportPath);
    assert.equal(fs.readFileSync(exportPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), draft.generatedText);
    const popupWait = page.waitForEvent('popup');
    await page.getByRole('button', { name: '打印 / 保存 PDF', exact: true }).click();
    const printPage = await popupWait;
    await printPage.waitForLoadState('networkidle');
    assert.equal(await printPage.locator('.resume-text').innerText(), draft.generatedText);
    assert.equal(await printPage.locator('.primary-nav,.resume-opt-ledger').count(), 0);
    await printPage.screenshot({ path: path.join(runRoot, '05-real-resume-print.png'), fullPage: true });
    await printPage.pdf({ path: path.join(runRoot, 'resume-current-renderer.pdf'), format: 'A4', preferCSSPageSize: true });
    result.screenshots.push({ file: path.join(runRoot, '05-real-resume-print.png'), evidenceType: result.evidenceType });
    await printPage.close();
    check('no-Key draft remains fully readable and exports exactly the current renderer text', { exportPath });

    const interviewUrl = `/interview?planId=${owner.planId}&sessionId=${session.id}`;
    await go(interviewUrl);
    assert.equal(await page.locator('#interview-current-question').innerText(), session.turns[0].questionText);
    await shot('06-real-interview-first-question');
    for (let turnNumber = 1; turnNumber <= 3; turnNumber++) {
      const savedAnswer = interviewEvidence.cases.find(item => item.name === `backend-junior/resume_general/answer-${turnNumber}`);
      assert(savedAnswer?.input.answerText);
      session = await interview.answerTurn({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id,
        turnNumber, answerText: savedAnswer.input.answerText });
      await go(interviewUrl);
      const feedback = page.locator('.interview-latest-feedback');
      await feedback.waitFor();
      assert(await feedback.isVisible());
      const conclusion = session.turns.find(turn => turn.turnNumber === turnNumber).answerReview.conclusion;
      assert((await feedback.innerText()).includes(conclusion));
      const layout = await feedback.evaluate(node => {
        const nextAction = document.querySelector('#interview-current-question, #interview-active-step form[action="/api/interview/finish"]');
        return { latestFeedbackBeforeNextQuestionOrFinish: nextAction ? Boolean(node.compareDocumentPosition(nextAction) & Node.DOCUMENT_POSITION_FOLLOWING) : null };
      });
      assert.equal(layout.latestFeedbackBeforeNextQuestionOrFinish, true);
      result.interviewSteps ||= [];
      result.interviewSteps.push({ turnNumber, answer: savedAnswer.input.answerText, feedback: await feedback.innerText(), layout,
        nextQuestion: session.turns.at(-1).questionText });
      await shot(`07-real-interview-answer-${turnNumber}-feedback`);
      check(`real feedback after answer ${turnNumber} is visible without opening history`, layout);
    }
    session = await interview.finishSession({ profileId: owner.profileId, planId: owner.planId, sessionId: session.id });
    await go(interviewUrl);
    await page.locator('#interview-report-title').waitFor();
    assert.equal(await page.locator('#interview-report-title').innerText(), '本轮训练复盘');
    const reportConclusion = page.locator('.interview-report-conclusion');
    assert.equal(await reportConclusion.innerText(), session.report.conclusion, 'The whole original conclusion must remain readable');
    const conclusionTypography = await reportConclusion.evaluate(node => ({
      tag: node.tagName, fontSize: parseFloat(getComputedStyle(node).fontSize),
      titleFontSize: parseFloat(getComputedStyle(document.querySelector('#interview-report-title')).fontSize)
    }));
    assert.equal(conclusionTypography.tag, 'P');
    assert(conclusionTypography.fontSize <= 18 && conclusionTypography.fontSize < conclusionTypography.titleFontSize,
      'Long conclusion should use normal body typography, below the short title size');
    result.conclusionTypography = conclusionTypography;
    assert.equal(await page.locator('.interview-turn-detail[open]').count(), 0);
    const outlines = page.locator('details.interview-answer-structure');
    assert.equal(await outlines.count(), session.report.answerStructures.length, 'Each real detailed outline should have its own disclosure');
    assert.equal(await page.locator('details.interview-answer-structure[open]').count(), 0, 'Detailed outlines should start collapsed');
    for (let index = 0; index < session.report.answerStructures.length; index++) {
      const outline = outlines.nth(index);
      await outline.locator('summary').click();
      assert.deepEqual(await outline.locator('li').allTextContents(), session.report.answerStructures[index].outline);
      await outline.locator('summary').click();
    }
    result.reportLayout = { detailedOutlineCount: await outlines.count(), collapsedByDefault: true,
      completeOriginalOutlinesVerified: true, height: await page.locator('body').evaluate(node => node.scrollHeight) };
    result.interviewReport = { sessionId: session.id, report: session.report, text: await page.locator('#main-content').innerText() };
    await shot('08-real-interview-fixed-report');
    const priorityPosition = await page.locator('.interview-report-grid section').last().boundingBox();
    const priorityTextPosition = await page.locator('.interview-report-grid section').last().locator('li').last().boundingBox();
    result.firstScreenPriority = { viewportHeight: page.viewportSize().height,
      top: priorityPosition.y, panelBottom: priorityPosition.y + priorityPosition.height,
      textBottom: priorityTextPosition.y + priorityTextPosition.height };
    assert(result.firstScreenPriority.textBottom <= result.firstScreenPriority.viewportHeight,
      'The original priority text of this real long report should be readable on the first desktop screen');
    const reportViewport = path.join(runRoot, '08-real-interview-fixed-report-first-screen.png');
    await page.screenshot({ path: reportViewport });
    result.screenshots.push({ file: reportViewport, evidenceType: result.evidenceType, url: page.url() });
    await outlines.first().locator('summary').click();
    await shot('08-real-interview-outline-opened');
    await outlines.first().locator('summary').click();
    const retryLinks = page.getByRole('link', { name: '重练这题', exact: true });
    assert(await retryLinks.count() > 0);
    await retryLinks.first().click();
    const retry = page.locator('.interview-turn-detail[open] textarea[name=answerText]');
    await retry.waitFor();
    assert(await retry.evaluate(field => document.activeElement === field));
    await shot('09-real-report-retry-entry');
    check('completed real repaired report remains readable without Key; retry link opens the selected original question', { retryLinks: await retryLinks.count() });

    await go('/settings');
    assert(!fs.existsSync(path.join(runRoot, '.runtime/settings/model.json')), 'Viewing records must not save model credentials');
    await shot('10-ordinary-no-key-settings');
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual(result.externalRequests, []);
    result.completed = true;
    console.log(`manual_effect_ui_review verified saved real output replay, not fresh generation: ${runRoot}`);
  } catch (error) {
    result.failure = { message: error.message, stack: error.stack };
    if (page) await page.screenshot({ path: path.join(runRoot, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(runRoot, 'results.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(outputRoot, 'latest.json'), JSON.stringify({ runRoot, completed: Boolean(result.completed), failure: result.failure || null }, null, 2));
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
