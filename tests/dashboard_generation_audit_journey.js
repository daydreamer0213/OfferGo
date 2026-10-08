const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const storage = require('../src/core/storage');
const { MockModelAdapter } = require('../src/adapters/models/mock');
const { createDashboardServer } = require('../src/dashboard/server');
const { createResumeOptimizationService } = require('../src/application/resume_optimization');
const { createMockInterviewService } = require('../src/application/mock_interview');

(async () => {
  const artifactRoot = process.env.OFFERGO_VALIDATION_ROOT || 'D:/DevData/OfferGo-validation/2026-10-07/audit-repairs';
  fs.mkdirSync(artifactRoot, { recursive: true });
  const dataRoot = fs.mkdtempSync(path.join(artifactRoot, 'generation-journey-'));
  const dbPath = path.join(dataRoot, 'synthetic.sqlite');
  const db = storage.openDb(dbPath);
  let server, browser;
  try {
    const owner = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '页面测试', city: '广州', targetTitles: ['开发工程师'] }, skills: [{ name: 'Node.js' }], projects: [{ name: '知识库' }] },
      document: { originalFileName: 'synthetic.txt', format: 'text', contentHash: randomUUID(), text: '个人总结\n参与知识库开发\n技能：Node.js', diagnostics: {} },
      searchPlan: { name: '测试方案', cities: ['广州'], directions: ['开发工程师'], keywords: [{ word: 'Node.js', priority: 'A' }] }
    });
    const adapter = new MockModelAdapter();
    const resume = createResumeOptimizationService({ db, adapter });
    const interview = createMockInterviewService({ db, adapter });
    const baseInput = { profileId: owner.profileId, planId: owner.planId };
    const draft = await resume.createDraft({ ...baseInput, mode: 'general', sourceResumeVersionId: owner.resumeVersionId });
    const logEvents = [];
    const logger = { info() {}, warn() {}, error(event, details) { logEvents.push({ event, details }); }, requestId() { return randomUUID(); }, listRecent() { return []; } };
    server = createDashboardServer({ db, root: path.resolve(__dirname, '..'), dataRoot, dbPath, forceMock: true, allowOfflineMock: true,
      resumeOptimizationService: resume, mockInterviewService: interview, logger,
      browserAuthority: { browserMode: 'portable', cdpPort: 9222, profilePath: path.join(dataRoot, 'isolated-edge') },
      browserFactory: async () => ({ async disconnect() {}, async listTabs() { return []; } }), spawnProcess() { throw new Error('external processes disabled'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const pageErrors = [];
    const a = await context.newPage(), b = await context.newPage();
    for (const page of [a, b]) { page.on('pageerror', error => pageErrors.push(error.message)); page.on('dialog', dialog => dialog.accept()); }
    const draftUrl = `${base}/resume-optimization?planId=${owner.planId}&draftId=${draft.id}`;
    await a.goto(draftUrl); await b.goto(draftUrl); await a.waitForLoadState('networkidle'); await b.waitForLoadState('networkidle');
    const firstText = draft.finalText + '\n甲页面：负责退款核对。';
    const secondText = draft.finalText + '\n乙页面：负责接口联调。';
    await a.locator('#resume-opt-final-text').fill(firstText);
    await a.locator('[data-resume-save-status]').filter({ hasText: '已自动保存' }).waitFor();
    await b.locator('#resume-opt-final-text').fill(secondText);
    await b.locator('[data-resume-conflict]:not([hidden])').waitFor();
    assert.equal(await b.locator('#resume-opt-final-text').inputValue(), secondText, 'conflict must preserve the current input');
    assert.equal(resume.getDraft({ ...baseInput, draftId: draft.id }).finalText, firstText, 'stale page must not overwrite earlier saved text');
    await b.getByRole('button', { name: '复制当前全文', exact: true }).click();
    assert.equal((await b.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), secondText);
    await b.getByRole('button', { name: '启用为新版本', exact: true }).click();
    assert.equal(resume.getDraft({ ...baseInput, draftId: draft.id }).status, 'draft', 'stale activation must not apply current page text');
    assert.equal(await b.locator('#resume-opt-final-text').inputValue(), secondText);
    const latestPromise = context.waitForEvent('page');
    await b.getByRole('link', { name: '在新页面查看最新版本' }).click();
    const latest = await latestPromise; await latest.waitForLoadState('networkidle');
    assert.equal(await latest.locator('#resume-opt-final-text').inputValue(), firstText); await latest.close();
    await b.screenshot({ path: path.join(dataRoot, 'resume-conflict.png'), fullPage: true });
    await b.getByRole('button', { name: '重新载入最新版本' }).click();
    await b.locator('[data-resume-recovery]:not([hidden])').waitFor();
    assert.equal(await b.locator('#resume-opt-final-text').inputValue(), firstText, 'reload opens latest version while preserving recoverable local changes');

    let starts = 0, release, entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const originalStep = adapter.generateMockInterviewStep.bind(adapter);
    adapter.generateMockInterviewStep = async input => { starts++; entered(); await gate; return originalStep(input); };
    const interviewUrl = `${base}/interview?planId=${owner.planId}`;
    await a.goto(interviewUrl); if (await a.locator('.interview-new-session > summary').count()) await a.locator('.interview-new-session > summary').click();
    await a.getByRole('button', { name: '开始模拟面试', exact: true }).click(); await enteredPromise;
    await a.goto(`${base}/resumes?profileId=${owner.profileId}`);
    await a.goto(interviewUrl); if (await a.locator('.interview-new-session > summary').count()) await a.locator('.interview-new-session > summary').click();
    await a.getByRole('button', { name: '开始模拟面试', exact: true }).click();
    release(); await a.locator('#interview-active-step').waitFor();
    assert.equal(starts, 1, 'navigation and repeated equivalent click must share pending generation');
    const storedOperation = interview.listSessions(baseInput)[0];
    assert(storedOperation.modelIdentity.operationId, 'HTTP must forward the page operation ID');

    adapter.generateMockInterviewStep = originalStep;
    const navigationCases = [];
    async function generationNavigation(kind, completeBeforeReturn, laterHistory = 0) {
      const method = kind === 'interview' ? 'generateMockInterviewStep' : 'generateResumeOptimization';
      const original = adapter[method].bind(adapter);
      const getResults = () => kind === 'interview' ? interview.listSessions({ ...baseInput, limit: 100 }) : resume.listDrafts({ ...baseInput, limit: 100 });
      const idsBefore = new Set(getResults().map(item => item.id));
      let calls = 0, notify, releaseGeneration;
      const modelEntered = new Promise(resolve => { notify = resolve; });
      const modelGate = new Promise(resolve => { releaseGeneration = resolve; });
      adapter[method] = async input => { calls++; notify(); await modelGate; return original(input); };
      const pageUrl = kind === 'interview' ? interviewUrl : draftUrl;
      const endpoint = kind === 'interview' ? '/api/interview/start' : '/api/resume-optimization';
      const open = async () => {
        await a.goto(pageUrl);
        const summary = a.locator(kind === 'interview' ? '.interview-new-session > summary' : '.resume-new-draft > summary');
        if (await summary.count()) await summary.click();
      };
      const button = () => a.getByRole('button', { name: kind === 'interview' ? '开始模拟面试' : '生成完整草稿', exact: true });
      await open(); await button().click(); await modelEntered;
      await a.goto(`${base}/resumes?profileId=${owner.profileId}`);
      let firstId = null;
      if (completeBeforeReturn) {
        releaseGeneration();
        for (let attempt = 0; !firstId && attempt < 200; attempt++) {
          firstId = getResults().find(item => !idsBefore.has(item.id))?.id || null;
          if (!firstId) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert(firstId, 'background generation must finish before reopening the page');
        for (let index = 0; index < laterHistory; index++) {
          if (kind === 'interview') await interview.startSession({ ...baseInput, sessionKind: 'resume_general', resumeVersionId: owner.resumeVersionId, settings: { plannedQuestions: 5 }, operationId: randomUUID() });
          else await resume.createDraft({ ...baseInput, mode: 'general', sourceResumeVersionId: owner.resumeVersionId, operationId: randomUUID() });
        }
        if (laterHistory) {
          const visibleHistory = kind === 'interview' ? interview.dashboard(baseInput).sessions : resume.dashboard(baseInput).drafts;
          assert(!visibleHistory.some(item => item.id === firstId), 'the old pending result must be outside the displayed 30-row history');
        }
      }
      await open();
      const callsBeforeReturn = calls;
      if (laterHistory) {
        const operationUrl = kind === 'interview' ? '/api/interview/operation' : '/api/resume-optimization/operation';
        const pendingSnapshot = await a.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('offergo:pending-generation:')));
        const formSelector = kind === 'interview' ? '.interview-start-form' : '.resume-opt-create-form';
        const fieldsBefore = await a.locator(formSelector).evaluate(form => Array.from(new FormData(form)).map(([key, value]) => [key, String(value)]));
        await a.route('**' + operationUrl + '?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic operation-status failure' }) }));
        await button().click();
        await a.locator(formSelector).getByText('暂时无法确认上次生成是否完成，请稍后重试。当前输入与操作编号仍保留。', { exact: true }).waitFor();
        assert.equal(calls, callsBeforeReturn, 'a failed status lookup must not issue another model request');
        assert.deepEqual(await a.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('offergo:pending-generation:'))), pendingSnapshot, 'failed status lookup preserves the operation ID');
        assert.deepEqual(await a.locator(formSelector).evaluate(form => Array.from(new FormData(form)).map(([key, value]) => [key, String(value)])), fieldsBefore, 'failed status lookup preserves all input fields');
        await a.unroute('**' + operationUrl + '?*');
      }
      const response = a.waitForResponse(value => value.url().endsWith(endpoint) && value.request().method() === 'POST');
      await button().click(); if (!completeBeforeReturn) releaseGeneration();
      await response; await a.waitForLoadState('networkidle');
      const newResults = getResults().filter(item => !idsBefore.has(item.id));
      const result = { kind, completeBeforeReturn, laterHistory, callsBeforeReturn, calls, firstId, resultIds: newResults.map(item => item.id) };
      navigationCases.push(result);
      await a.screenshot({ path: path.join(dataRoot, `${kind}-${completeBeforeReturn ? 'new-round' : 'pending-return'}.png`), fullPage: true });
      adapter[method] = original;
    }
    await generationNavigation('interview', true);
    await generationNavigation('resume', false);
    await generationNavigation('resume', true);
    await generationNavigation('interview', true, 31);
    await generationNavigation('resume', true, 31);
    fs.writeFileSync(path.join(dataRoot, 'generation-navigation-results.json'), JSON.stringify(navigationCases, null, 2));
    for (const result of navigationCases) {
      assert.equal(result.calls, result.completeBeforeReturn ? result.callsBeforeReturn + 1 : 1, `${result.kind}: a saved background result allows a new round; a pending result remains shared`);
      assert.equal(result.resultIds.length, result.completeBeforeReturn ? result.laterHistory + 2 : 1);
    }

    adapter.generateMockInterviewStep = async () => { throw Object.assign(new Error('synthetic timeout'), { code: 'MODEL_TIMEOUT' }); };
    await a.goto(interviewUrl); if (await a.locator('.interview-new-session > summary').count()) await a.locator('.interview-new-session > summary').click();
    const failureResponse = a.waitForResponse(response => response.url().endsWith('/api/interview/start') && response.status() >= 400);
    await a.getByRole('button', { name: '开始模拟面试', exact: true }).click();
    const failure = await (await failureResponse).json();
    await a.locator('.interview-start-form [data-interview-error]').filter({ hasText: '模型响应超时' }).waitFor();
    const visible = await a.locator('.interview-start-form [data-interview-error]').innerText();
    assert(visible.includes('模型响应超时')); assert(!visible.includes('MODEL_TIMEOUT')); assert(!visible.includes(failure.requestId));
    await a.locator('.interview-start-form [data-interview-error]').getByText('排错信息', { exact: true }).click();
    const technical = await a.locator('.interview-start-form [data-interview-error] details').innerText();
    assert(technical.includes('MODEL_TIMEOUT')); assert(technical.includes(failure.requestId));
    assert.equal(await a.locator('.interview-start-form [data-interview-error]').getByRole('link', { name: '查看运行诊断' }).getAttribute('href'), '/diagnostics?requestId=' + encodeURIComponent(failure.requestId));
    assert.equal(await a.locator('.interview-start-form select[name="resumeVersionId"]').inputValue(), String(owner.resumeVersionId));
    await a.screenshot({ path: path.join(dataRoot, 'interview-timeout.png'), fullPage: true });

    adapter.generateResumeOptimization = async () => { throw Object.assign(new Error('synthetic resume timeout'), { code: 'MODEL_TIMEOUT' }); };
    await a.goto(draftUrl);
    await a.locator('.resume-new-draft > summary').click();
    await a.locator('[data-resume-mode-picker]').selectOption('general');
    const resumeFailureResponse = a.waitForResponse(response => response.url().endsWith('/api/resume-optimization') && response.status() >= 400);
    await a.getByRole('button', { name: '生成完整草稿', exact: true }).click();
    const resumeFailure = await (await resumeFailureResponse).json();
    await a.locator('.resume-opt-create-form [data-resume-error]').filter({ hasText: '模型响应超时' }).waitFor();
    const resumeVisible = await a.locator('.resume-opt-create-form [data-resume-error]').innerText();
    assert(!resumeVisible.includes(resumeFailure.requestId)); assert(!resumeVisible.includes('MODEL_TIMEOUT'));
    await a.locator('.resume-opt-create-form [data-resume-error]').getByText('排错信息', { exact: true }).click();
    const resumeTechnical = await a.locator('.resume-opt-create-form [data-resume-error] details').innerText();
    assert(resumeTechnical.includes(resumeFailure.requestId)); assert(resumeTechnical.includes('MODEL_TIMEOUT'));
    assert.equal(await a.locator('.resume-opt-create-form [data-resume-error]').getByRole('link', { name: '查看运行诊断' }).getAttribute('href'), '/diagnostics?requestId=' + encodeURIComponent(resumeFailure.requestId));
    assert.equal(await a.locator('[data-resume-mode-picker]').inputValue(), 'general');
    await a.screenshot({ path: path.join(dataRoot, 'resume-timeout.png'), fullPage: true });
    adapter.generateResumeOptimization = async () => { throw Object.assign(new Error('synthetic truncated output'), { code: 'MODEL_OUTPUT_TRUNCATED' }); };
    const truncatedResponse = a.waitForResponse(response => response.url().endsWith('/api/resume-optimization') && response.status() >= 400);
    await a.getByRole('button', { name: '生成完整草稿', exact: true }).click();
    const truncatedFailure = await (await truncatedResponse).json();
    assert(truncatedFailure.error.includes('模型返回的内容不完整'));
    assert(truncatedFailure.error.includes('已有资料'));
    assert(!truncatedFailure.error.includes('服务处理失败'));
    await a.locator('.resume-opt-create-form [data-resume-error]').filter({ hasText: '模型返回的内容不完整' }).waitFor();
    assert.equal(await a.locator('[data-resume-mode-picker]').inputValue(), 'general');
    assert.deepEqual(pageErrors, []);
    console.log('dashboard_generation_audit_journey ok ' + dataRoot);
  } finally { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
