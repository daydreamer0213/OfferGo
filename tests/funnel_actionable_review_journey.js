const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const storage = require('../src/core/storage');
const { recordProgressEvent } = require('../src/core/candidate_progress');
const { upsertMessageEvents } = require('../src/storage/message_timeline_store');
const { createFunnelAnalysisService } = require('../src/application/funnel_analysis');
const { createDashboardServer } = require('../src/dashboard/server');
const { MockModelAdapter } = require('../src/adapters/models/mock');

const START = '2026-10-12T02:00:00.000Z';
const MESSAGE_TIME = '2026-10-13T02:00:00.000Z';
const NOW = '2026-10-16T02:00:00.000Z';
const digest = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const artifactRoot = process.env.OFFERGO_UX_ARTIFACT_DIR || 'D:/DevData/OfferGo-validation/2026-10-16/funnel-actionable-review/tests';

function sample(db, key, { category, quote = '', replyText = '', summary = '已分类的求职反馈', nativeRejection = false }) {
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES (?, '{}', ?, ?)")
    .run('合成体检用户 ' + key, START, START).lastInsertRowid);
  const planId = Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?, ?, ?, 1, ?, ?)")
    .run(profileId, '合成体检方案 ' + key, JSON.stringify({ directions: ['后端开发'] }), START, START).lastInsertRowid);
  const round = storage.ensureActiveFunnelStrategyRound(db, { profileId, planId, startedAt: START });
  const title = key + ' 后端开发';
  const jobId = Number(db.prepare("INSERT INTO jobs(source,source_id,title,company,description,first_seen_at,last_seen_at) VALUES ('boss',?,?,'合成订单公司',?,?,?)")
    .run(key, title, '维护订单接口，处理重复回调并核对交易状态。', START, START).lastInsertRowid);
  const conversationKey = digest(key + ':conversation'), messageKey = digest(key + ':hr');
  const cardId = Number(db.prepare("INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,thread_key,stage,next_action,last_event_at,created_at,updated_at) VALUES (?,?,?,'boss',?,'waiting_reply','',?,?,?)")
    .run(profileId, planId, jobId, conversationKey, START, START, START).lastInsertRowid);
  db.prepare("INSERT INTO candidate_funnel_entries(profile_id,job_id,card_id,plan_id,strategy_round_id,source_kind,started_at,mature_at,direction_key,created_at,updated_at) VALUES (?,?,?,?,?,'applied',?,?,'后端开发',?,?)")
    .run(profileId, jobId, cardId, planId, round.id, START, MESSAGE_TIME, START, START);
  recordProgressEvent(db, { cardId, idempotencyKey: 'progress:' + randomUUID(), type: nativeRejection ? 'recruiter_rejected' : 'incoming_message_classified', actor: 'system', summary,
    metadata: { platform: 'boss', threadKey: conversationKey, messageKey, messageIntent: nativeRejection ? 'rejection' : 'information_request', messageCategory: category }, occurredAt: MESSAGE_TIME });
  if (nativeRejection) db.prepare("UPDATE candidate_progress_cards SET stage = 'rejected' WHERE id = ?").run(cardId);
  if (quote) upsertMessageEvents(db, { profileId, platform: 'boss', conversationKey, observedAt: MESSAGE_TIME, events: [
    { messageKey, direction: 'friend', kind: 'text', text: quote, occurredAt: MESSAGE_TIME },
    ...(replyText ? [{ messageKey: digest(key + ':self'), direction: 'myself', kind: 'text', text: replyText, occurredAt: '2026-10-13T02:01:00.000Z' }] : [])
  ] });
  return { profileId, planId, jobId, cardId, title, conversationKey, messageKey, quote, replyText, summary };
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === '1') throw error;
    console.log('funnel_actionable_review_journey SKIP: Playwright unavailable'); return;
  }
  fs.mkdirSync(artifactRoot, { recursive: true });
  const db = storage.openDb(':memory:');
  const modelMethods = new Map();
  const modelCalls = [], externalRequests = [], posts = [], browserCalls = [], pageErrors = [];
  let server, browser;
  try {
    // A GET-only review has no reason to invoke even an offline model adapter.
    for (const name of Object.getOwnPropertyNames(MockModelAdapter.prototype).filter(name => name !== 'constructor')) {
      modelMethods.set(name, MockModelAdapter.prototype[name]);
      MockModelAdapter.prototype[name] = async () => { modelCalls.push(name); throw new Error('review must not call a model'); };
    }
    const project = sample(db, '项目职责', { category: 'project_fact', quote: '订单平台中你本人实现了哪些接口？重复回调是怎样处理的？',
      replyText: '我实现订单查询和支付回调接口，用交易号唯一约束处理重复回调。' });
    const missing = sample(db, '没有原文', { category: 'project_fact', summary: '系统进度摘要：已收到项目职责追问，不是招聘方原话。' });
    const salary = sample(db, '薪资问询', { category: 'salary', quote: '你的期望税前月薪是多少？' });
    const rejected = sample(db, '原生拒绝', { category: 'general', nativeRejection: true,
      quote: '感谢沟通，这次暂不继续，祝求职顺利。' });
    const service = createFunnelAnalysisService({ db, now: () => NOW });
    assert.equal(service.getDashboard(project).currentRound.started, 1);
    assert.equal(service.getDashboard(project).currentRound.strength, 'facts', 'the fixture must remain below the statistical sample threshold');
    const logger = { info() {}, warn() {}, error() {}, requestId() { return 'funnel-actionable-journey'; }, listRecent() { return []; } };
    server = createDashboardServer({ db, dataRoot: artifactRoot, forceMock: true, allowOfflineMock: true, logger,
      funnelAnalysisService: service, browserAuthority: { browserMode: 'edge', cdpPort: null, profilePath: '' },
      browserFactory: async () => { browserCalls.push('browser'); throw new Error('review must not open a platform'); },
      spawnProcess() { browserCalls.push('process'); throw new Error('review must not spawn an external process'); } });
    const base = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await context.route('**/*', route => {
      const request = route.request();
      if (new URL(request.url()).origin !== base) { externalRequests.push(request.url()); return route.abort(); }
      if (request.method() !== 'GET') { posts.push({ method: request.method(), url: request.url() }); return route.abort(); }
      return route.continue();
    });
    const open = async item => { await page.goto(`${base}/funnel?planId=${item.planId}`); await page.waitForLoadState('networkidle'); };
    const assertOriginalConversation = async item => {
      assert.equal(new URL(page.url()).pathname, '/messages');
      assert.equal(await page.getByRole('heading', { name: '没有找到这条联系', exact: true }).count(), 0,
        'a feedback link must resolve its actual saved contact, not an empty messages page');
      const selected = page.locator('[data-message-detail-panel]:visible');
      assert.equal(await selected.count(), 1, 'the corresponding conversation must be selected');
      const text = await selected.innerText();
      assert(text.includes(item.title), 'the selected conversation must show its actual job');
      assert(text.includes('合成订单公司'), 'the selected conversation must show its actual company');
      assert(text.includes(item.quote), 'the selected conversation must show the saved HR original text');
    };
    await open(project);
    const review = page.locator('[data-feedback-review]');
    assert.equal(await review.count(), 1, 'a classified project question must provide an actionable feedback review even with one sample');
    assert.equal(await review.isVisible(), true);
    const dashboard = service.getDashboard(project), primary = dashboard.feedbackReview.primary;
    const diagnosis = page.locator('.health-diagnosis');
    assert((await diagnosis.innerText()).includes(primary.title));
    assert((await diagnosis.innerText()).includes(primary.action));
    assert.doesNotMatch(await diagnosis.innerText(), /先积累到\s*30|少于\s*30.*不判断/,
      'a specific saved question can guide a check while statistics remain inconclusive');
    const topics = review.locator('article[data-feedback-topic]');
    assert((await topics.locator('h3').allTextContents()).some(title => /项目|经历|职责/.test(title)));
    const quote = review.locator('blockquote').filter({ hasText: project.quote });
    assert.equal(await quote.count(), 1);
    assert.equal(await quote.isVisible(), false, 'the original conversation should be expanded only when requested');
    const evidence = quote.locator('xpath=ancestor::details[1]');
    await evidence.locator('summary').first().click();
    assert.equal(await quote.isVisible(), true);
    assert((await evidence.innerText()).includes(project.title));
    assert((await evidence.innerText()).includes('合成订单公司'));
    await evidence.getByText('随后观察到的本人消息', { exact: true }).click();
    assert((await evidence.innerText()).includes(project.replyText), 'the actual saved candidate reply must be available beside the HR question');
    const conversationLink = evidence.locator('a[href^="/messages?"]').first();
    const destination = new URL(await conversationLink.getAttribute('href'), base);
    assert.equal(destination.origin, base);
    assert.equal(destination.searchParams.get('planId'), String(project.planId));
    assert.equal(destination.searchParams.get('source'), 'boss');
    const expectedContact = dashboard.incomingContacts.items.find(item => item.conversationKey === project.conversationKey)?.key;
    assert(expectedContact, 'the actual saved conversation must be available as a local contact');
    assert.equal(destination.searchParams.get('contact'), expectedContact,
      'viewing the original conversation must target its saved local identity');
    const layoutChecks = [];
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.locator('[data-theme-toggle]').click();
        await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
          `${width}px ${theme} review must not cause horizontal page overflow`);
        const ratios = await textContrasts(review);
        assert(ratios.length && ratios.every(value => value >= 4.5), `${width}px ${theme} review text must remain readable: ${ratios}`);
        await page.screenshot({ path: path.join(artifactRoot, `project-${width}-${theme}.png`), fullPage: true });
        layoutChecks.push({ width, theme, minContrast: Math.min(...ratios) });
      }
    }
    await open(rejected);
    const rejectionQuote = page.locator('[data-feedback-review] blockquote').filter({ hasText: rejected.quote });
    assert.equal(await rejectionQuote.count(), 1);
    const rejectionEvidence = rejectionQuote.locator('xpath=ancestor::details[1]');
    await rejectionEvidence.locator('summary').first().click();
    await rejectionEvidence.getByRole('link', { name: '查看原对话', exact: true }).click();
    await page.waitForLoadState('networkidle');
    await assertOriginalConversation(rejected);
    await open(project);
    await evidence.locator('summary').first().click();
    await conversationLink.click();
    await page.waitForLoadState('networkidle');
    await assertOriginalConversation(project);
    await open(missing);
    assert.equal(await page.locator('[data-feedback-review] blockquote').count(), 0,
      'a progress summary without saved message text must never become a quoted recruiter statement');
    const missingReview = page.locator('[data-feedback-review]');
    assert(!((await missingReview.count() ? await missingReview.innerText() : '').includes(missing.summary)));
    await open(salary);
    const salaryReview = page.locator('[data-feedback-review]');
    assert((await salaryReview.locator('h3').allTextContents()).some(title => /薪资|条件/.test(title)));
    const salaryAdvice = await page.locator('.health-diagnosis').innerText();
    assert.match(salaryAdvice, /核对|确认/);
    assert.doesNotMatch(salaryAdvice, /薪资(?:冲突|不匹配|过高)|因(?:为)?薪资.*拒绝/,
      'asking an expected salary does not establish a compensation conflict');
    assert.equal(await page.locator('.health-summary').isVisible(), true);
    assert.equal(await page.getByRole('heading', { name: '收到的联系', exact: true }).isVisible(), true);
    assert.equal(await page.locator('.feedback-adjustment').count(), 1);
    assert.deepEqual({ modelCalls, externalRequests, posts, browserCalls, pageErrors },
      { modelCalls: [], externalRequests: [], posts: [], browserCalls: [], pageErrors: [] });
    fs.writeFileSync(path.join(artifactRoot, 'browser-results.json'), JSON.stringify({
      smallSampleProjectReview: 'passed', originalQuoteAndReply: 'passed', noSummaryAsQuote: 'passed', salaryQuestionIsNotConflict: 'passed',
      localConversationGetOnly: 'passed', selectedConversationIdentity: 'passed', nativeRejectionConversation: 'passed',
      layoutChecks, modelCalls, externalRequests, posts, browserCalls, pageErrors
    }, null, 2));
    console.log('funnel_actionable_review_journey ok');
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [name, method] of modelMethods) MockModelAdapter.prototype[name] = method;
    db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

function textContrasts(surface) {
  return surface.locator('h3,p,blockquote,a').evaluateAll(elements => {
    const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
    const luminance = color => color.slice(0, 3).map(value => {
      value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
    return elements.filter(element => element.getClientRects().length && element.textContent.trim()).map(element => {
      let background = element;
      while (background.parentElement && (rgb(getComputedStyle(background).backgroundColor)[3] ?? 1) === 0) background = background.parentElement;
      const ink = luminance(rgb(getComputedStyle(element).color));
      const paper = luminance(rgb(getComputedStyle(background).backgroundColor));
      return (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05);
    });
  });
}
