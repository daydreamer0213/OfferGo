const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const storage = require('../src/core/storage');
const { MockModelAdapter } = require('../src/adapters/models/mock');
const { createMockInterviewService } = require('../src/application/mock_interview');
const { createResumeOptimizationService } = require('../src/application/resume_optimization');
const { createMessageReplyAnalyzer } = require('../src/core/message_reply_analyzer');
const { ensureProgressCard } = require('../src/core/candidate_progress');
const { runBossMessageDiscovery } = require('../src/application/message_discovery/run');
const { safeDigest } = require('../src/adapters/sites/boss_message_dom');
const { createDashboardServer } = require('../src/dashboard/server');

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === '1') throw error;
    console.log('three_module_user_experience_journey SKIP: Playwright unavailable');
    return;
  }
  const evidenceRoot = process.env.OFFERGO_UX_EVIDENCE_DIR;
  const root = evidenceRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'offergo-three-module-'));
  fs.mkdirSync(root, { recursive: true });
  const db = storage.openDb(path.join(root, `virtual-user-${Date.now()}.sqlite`));
  const result = { checks: [], pageErrors: [], externalRequests: [], model: 'controlled fixtures; checks UI/state, not model writing quality' };
  let server, browser;
  try {
    const owner = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '林晓（虚拟用户）', city: '广州', targetTitles: ['初级产品经理'] } },
      document: { contentHash: 'virtual-ux', format: 'text', originalFileName: 'virtual.txt',
        text: '林晓（虚拟用户）\n信息管理本科\n产品实习：参与客服工单改版，整理用户反馈、流程原型、分配规则文档，协助研发验收。\n技能：Axure、Figma、Excel、简单SQL。\n英语：能阅读英文文档，协助过英文需求会议。' },
      searchPlan: { name: '初级产品经理', directions: ['初级产品经理'], cities: ['广州'], keywords: [{ word: '产品经理', priority: 'A' }] }
    });
    const batch = storage.createBatch(db, 'boss', '产品经理', 'virtual UX', { profileId: owner.profileId, searchPlanId: owner.planId });
    const jobId = storage.upsertJob(db, { source: 'boss', sourceId: 'virtual-ux-job', title: '初级产品经理', company: '示例云服', salary: '8-12K', location: '广州',
      description: '负责客服工单需求梳理、业务规则与原型设计、研发协作和验收。要求有产品实习经历，能够讲清个人贡献。'.repeat(4),
      analysis: { semanticStatus: 'complete', recommendation: 'apply', roleSummary: '梳理客服工单需求并协助交付。' } }, batch);
    const card = ensureProgressCard(db, { profileId: owner.profileId, planId: owner.planId, jobId, source: 'boss', stage: 'contact_started' });
    const conversationKey = safeDigest(['virtual', 'ux']);
    const messages = [];
    const reader = {
      async scanConversationRows() { const last = messages.at(-1); return { tabId: 'fake', path: '/web/geek/chat', rows: [{ rowIndex: 0, unread: true,
        selected: false, recruiterLabel: '示例HR', previewText: last.text, recruiterKey: safeDigest(['hr']), conversationKey,
        previewDigest: safeDigest([last.text]), previewKind: 'possible_hr_reply', transientSignature: safeDigest(['row']),
        sourceJobId: 'boss:virtual-ux-job', lastMessageId: last.messageId, lastMessageDirection: 'friend', identityVerified: true }] }; },
      async openQueuedConversation() { return { skipped: false, path: '/web/geek/chat', headerText: '示例HR', positionName: '初级产品经理',
        salary: '8-12K', city: '广州', companyName: '示例云服', sourceJobId: 'boss:virtual-ux-job', identityVerified: true,
        risk: false, login: false, rows: [{ rowIndex: 0, unread: true, selected: true, recruiterLabel: '示例HR' }], messages: messages.map(m => ({ ...m })) }; }
    };
    async function discover(text, classification) {
      messages.push({ direction: 'friend', messageId: String(123456789033330 + messages.length), text, contentKind: 'text' });
      return runBossMessageDiscovery({ db, profileId: owner.profileId, reader, sleepFn: async () => {},
        classifyMessageGroup: async () => ({ kind: 'hr_reply', messageIntent: 'information_request', progressUpdate: { stage: 'needs_user_action' }, ...classification }) });
    }
    await discover('实习中主要负责什么？', { messageCategory: 'project_fact', messageSummary: '询问实习工作', messages: ['我参与工单改版，整理反馈和分配规则。'] });
    const oldDraft = storage.listOpenMessageReplyDrafts(db, { profileId: owner.profileId })[0];
    await discover('期望薪资多少？最快什么时候到岗？', { messageCategory: 'salary', messageSummary: '确认薪资和到岗',
      missingFact: { key: 'expected_salary', question: '你的期望薪资是多少？' }, messages: [] });
    const adapter = new MockModelAdapter();
    const reviewInterview = adapter.reviewMockInterview.bind(adapter);
    adapter.reviewMockInterview = async input => {
      const report = await reviewInterview(input);
      return { ...report, answerStructures: report.answerStructures.map(item =>
        ({ ...item, outline: item.outline.join(" → ") })) };
    };
    const optimizeResume = adapter.generateResumeOptimization.bind(adapter);
    adapter.generateResumeOptimization = async input => {
      const draft = await optimizeResume(input);
      return { ...draft, suggestions: draft.suggestions.map(item =>
        ({ ...item, id: "workorder-detail" })) };
    };
    const interview = createMockInterviewService({ db, adapter });
    const optimizer = createResumeOptimizationService({ db, adapter });
    const analyzer = createMessageReplyAnalyzer({ adapter: { async draftMessageGroup(input) {
      const hasDate = input.facts.some(f => f.key === 'availability_date');
      return { messageIntent: 'information_request', messageCategory: 'salary', messageSummary: '确认薪资和到岗',
        requiredFactKeys: hasDate ? ['expected_salary', 'availability_date'] : ['availability_date'],
        usedFactKeys: hasDate ? ['expected_salary', 'availability_date'] : [], responseItems: [], coverage: [],
        missingFact: hasDate ? null : { key: 'availability_date', question: '你最快什么时候可以到岗？' },
        messages: hasDate ? ['期望税前月薪10K，下周可以到岗。'] : [] };
    } } });
    server = createDashboardServer({ db, root, dataRoot: root, forceMock: true, allowOfflineMock: true,
      mockInterviewService: interview, resumeOptimizationService: optimizer,
      messageDiscoveryDependencies: { createAnalyzer: () => analyzer },
      browserAuthority: { browserMode: 'portable', cdpPort: 9222, profilePath: path.join(root, 'isolated-edge') },
      browserFactory() { throw Error('No real platform access allowed'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) { result.externalRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => result.pageErrors.push(error.message));
    const shot = async name => { if (evidenceRoot) await page.screenshot({ path: path.join(root, `${name}.png`), fullPage: true }); };
    await page.goto(`${base}/messages?profileId=${owner.profileId}`);
    assert.equal(await page.locator('input[name=factKey]').inputValue(), 'expected_salary');
    assert.equal(await page.locator('[data-draft-text]').count(), 0);
    await page.locator('textarea[name=factValue]').fill('期望税前月薪10K。');
    await page.getByRole('button', { name: '生成回复草稿', exact: true }).click();
    await page.locator('input[name=factKey][value=availability_date]').waitFor({ state: 'attached' });
    assert(!/响应失败|本地服务响应失败/.test(await page.locator('#main-content').innerText()));
    await shot('01-next-fact');
    await page.locator('textarea[name=factValue]').fill('下周可以到岗。');
    await page.getByRole('button', { name: '生成回复草稿', exact: true }).click();
    await page.locator('[data-draft-text]').first().waitFor();
    assert((await page.locator('[data-draft-text]').first().inputValue()).includes('10K'));
    assert(storage.listOpenMessageReplyDrafts(db, { profileId: owner.profileId }).some(d => d.id === oldDraft.id));
    await page.reload();
    assert(!(await page.locator('[data-draft-text]').allTextContents()).some(text => text.includes('分配规则')));
    result.checks.push('new HR question replaces old suggestion; two missing facts continue without manual refresh; history retained');
    await shot('02-current-reply');

    await page.goto(`${base}/interview?planId=${owner.planId}`);
    await page.locator('select[name=plannedQuestions]').selectOption('3');
    await page.getByRole('button', { name: '开始模拟面试', exact: true }).click();
    for (let turn = 1; turn <= 3; turn++) {
      await page.locator(`form[action='/api/interview/answer'] input[name=turnNumber][value='${turn}']`).waitFor({ state: 'attached' });
      await page.locator("form[action='/api/interview/answer'] textarea").fill(`我参与工单改版，主要负责第${turn}部分反馈整理，画原型并核对分配规则，由产品经理决策，协助研发验收。`);
      await page.getByRole('button', { name: '提交回答并继续', exact: true }).click();
      await page.locator('.interview-latest-feedback').filter({ hasText: `第 ${turn} 题答后反馈` }).waitFor();
      assert(await page.locator('.interview-latest-feedback').isVisible());
    }
    await shot('03-visible-feedback');
    await page.getByRole('button', { name: '结束并生成复盘', exact: true }).click();
    await page.locator('#interview-report-title').waitFor();
    result.checks.push('paragraph outline produces a saved interview report without retrying the user action');
    assert.equal(await page.locator('.interview-turn-detail[open]').count(), 0);
    await page.getByRole('link', { name: '重练这题', exact: true }).first().click();
    const retry = page.locator('.interview-turn-detail[open] textarea[name=answerText]');
    await retry.waitFor();
    assert(await retry.evaluate(field => document.activeElement === field));
    await retry.fill('我把工单反馈按查询和分配分类，画了流程原型，并按确认后的规则协助验收。方案由产品经理决定。');
    await page.locator('.interview-turn-detail[open]').getByRole('button', { name: '保存重答并比较', exact: true }).click();
    await page.getByText('重答对比', { exact: true }).waitFor();
    result.checks.push('feedback visible after each answer; retry link opens and focuses form; retry saved');
    await shot('04-interview-report');

    await page.goto(`${base}/resume-optimization?planId=${owner.planId}`);
    await page.getByRole('button', { name: '生成完整草稿', exact: true }).click();
    await page.locator('textarea[name=finalText]').waitFor();
    assert.deepEqual(await page.locator('.resume-opt-index').allTextContents(),
      await page.locator('.resume-opt-index').evaluateAll(items => items.map((_, index) => String(index + 1))));
    const technical = page.locator('details.resume-opt-technical');
    assert.equal(await technical.getAttribute('open'), null);
    assert(!(await page.locator('#main-content').innerText()).includes('生成模型：'));
    await technical.locator('summary').click();
    assert(await technical.locator('p').isVisible());
    await technical.locator('summary').click();
    result.checks.push('descriptive suggestion IDs generate a draft; technical details stay collapsed until requested');
    for (const theme of ['dark', 'light']) {
      await page.locator('[data-theme-toggle]').click();
      await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
      const contrasts = await page.locator('.resume-opt-conclusion').evaluate(node => {
        const luminance = color => {
          const channels = color.match(/\d+/g).slice(0, 3).map(Number).map(value => value / 255)
            .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const background = luminance(getComputedStyle(node).backgroundColor);
        return [...node.querySelectorAll('h2,p')].map(child => {
          const text = luminance(getComputedStyle(child).color);
          return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
        });
      });
      assert(contrasts.length > 0 && contrasts.every(ratio => ratio >= 4.5),
        `${theme} resume conclusion must remain readable: ${contrasts}`);
      await shot(`resume-conclusion-${theme}`);
    }
    result.checks.push('resume conclusion stays readable in both dark and light themes');
    const editor = page.locator('textarea[name=finalText]');
    const latest = (await editor.inputValue()) + '\n补充：协助整理会议纪要。';
    await editor.fill(latest);
    const downloadWait = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载文字版', exact: true }).click();
    const download = await downloadWait;
    const file = path.join(root, 'exported-resume.txt'); await download.saveAs(file);
    assert.equal(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), latest);
    const popupWait = page.waitForEvent('popup');
    await page.getByRole('button', { name: '打印 / 保存 PDF', exact: true }).click();
    const printPage = await popupWait; await printPage.waitForLoadState();
    assert.equal(await printPage.locator('.resume-text').innerText(), latest);
    assert.equal(await printPage.locator('.primary-nav,.resume-opt-ledger').count(), 0);
    await printPage.pdf({ path: path.join(root, 'exported-resume.pdf'), format: 'A4', preferCSSPageSize: true });
    assert(fs.statSync(path.join(root, 'exported-resume.pdf')).size > 1000);
    if (evidenceRoot) await printPage.screenshot({ path: path.join(root, '05-print-preview.png'), fullPage: true });
    await printPage.close();
    await page.getByRole('button', { name: '启用为新版本', exact: true }).click();
    await page.getByText('已启用新版本', { exact: true }).waitFor();
    await page.goto(`${base}/interview?planId=${owner.planId}`);
    const choices = await page.locator('select[name=resumeVersionId] option').allTextContents();
    assert(choices.length >= 2);
    assert.equal(choices.filter(text => text.includes('默认参考')).length, 1);
    assert(choices[0].includes('通用整理版'));
    assert(!choices.some(text => text.includes('当前使用')));
    result.checks.push('immediate export includes unsaved edit; print page/PDF exclude analysis; activated version has one clear default');
    await shot('06-resume-selection');
    assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.externalRequests, []);
    result.completed = true;
    console.log('three_module_user_experience_journey ok');
  } finally {
    if (evidenceRoot) fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2));
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); db.close();
    if (!evidenceRoot) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
