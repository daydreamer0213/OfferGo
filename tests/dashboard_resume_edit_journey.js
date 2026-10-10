const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const storage = require('../src/core/storage');
const { createResumeOptimization } = require('../src/storage/resume_optimization_store');
const { createDashboardServer } = require('../src/dashboard/server');

const logger = { info() {}, warn() {}, error() {}, requestId() { return 'resume-edit-journey'; }, listRecent() { return []; } };

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === '1') throw error;
    console.log('dashboard_resume_edit_journey SKIP: Playwright unavailable'); return;
  }
  const db = storage.openDb(':memory:');
  let browser, server;
  try {
    const original = '陈亦航\n求职方向：Node.js 后端开发\n工作经历：负责订单查询、退款接口与支付回调的实现和测试。\n项目：使用 PostgreSQL 事务和交易号唯一约束处理重复回调，联调覆盖重复请求与并发请求。\n技能：Node.js、TypeScript、PostgreSQL、Redis。';
    const owner = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '陈亦航', city: '杭州', targetTitles: ['后端开发'] }, skills: [{ name: 'Node.js' }] },
      document: { originalFileName: 'resume.txt', format: 'text', contentHash: 'edit-journey', text: original, diagnostics: {} },
      searchPlan: { name: '编辑体验', cities: ['杭州'], directions: ['后端开发'], keywords: [{ word: '后端开发', priority: 'A' }] }
    });
    const draft = createResumeOptimization(db, { profileId: owner.profileId, planId: owner.planId,
      sourceResumeVersionId: owner.resumeVersionId, mode: 'general', generatedText: original, headline: '订单项目经历', suggestions: [], evidenceCatalog: [] });
    server = createDashboardServer({ db, forceMock: true, allowOfflineMock: true, logger,
      browserAuthority: { browserMode: 'edge', cdpPort: null, profilePath: '' } });
    const base = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const url = `${base}/resume-optimization?planId=${owner.planId}&draftId=${draft.id}`;
    const editor = page.locator('#resume-opt-final-text');
    await page.goto(url);
    const latest = original + '\n求职意向：后端开发。';
    await editor.fill(latest);
    await page.getByRole('link', { name: '面试训练', exact: true }).click();
    await page.waitForURL('**/interview?**');
    await page.goto(url);
    assert.equal(await editor.inputValue(), latest, 'immediate sidebar navigation must preserve the latest edit');

    let release;
    const pendingWrite = new Promise(resolve => { release = resolve; });
    let delayFirst = true;
    await page.route('**/api/resume-optimization/save', async route => {
      if (delayFirst) { delayFirst = false; await pendingWrite; }
      await route.continue();
    });
    const saving = page.waitForRequest('**/api/resume-optimization/save');
    await editor.fill(latest + '\n第一处修改。');
    await saving;
    const duringSave = latest + '\n保存期间继续修改的文字。';
    await editor.fill(duringSave);
    const leave = page.getByRole('link', { name: '面试训练', exact: true }).click();
    release(); await leave;
    await page.waitForURL('**/interview?**');
    await page.goto(url);
    assert.equal(await editor.inputValue(), duringSave, 'an older save acknowledgement must not discard newer input');
    await page.unroute('**/api/resume-optimization/save');

    let blocked = true;
    await page.route('**/api/resume-optimization/save', route => blocked
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟保存失败' }) }) : route.continue());
    const unsaved = duringSave + '\n希望进一步了解订单系统相关工作。';
    await editor.fill(unsaved);
    await page.getByRole('link', { name: '面试训练', exact: true }).click();
    await page.locator('[data-resume-save-status]').filter({ hasText: '保存失败' }).waitFor();
    assert.equal(page.url(), url, 'failed save must keep the user in the editor');
    assert.equal(await editor.inputValue(), unsaved);
    // A local recovery copy must survive a reload even when the database write failed.
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    assert.equal(await editor.inputValue(), unsaved, 'reload must recover the pending full text');
    blocked = false;
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForLoadState('networkidle');
    await page.goto(url);
    assert.equal(await editor.inputValue(), unsaved);
    const recoveryKeys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('offergo:resume-draft:')));
    assert.equal(recoveryKeys.length, 0, 'successful save clears only acknowledged recovery copies');
    await page.evaluate(({ key, text }) => localStorage.setItem(key, JSON.stringify({ baseText: '过时的数据库正文', text })),
      { key: `offergo:resume-draft:${owner.planId}:${draft.id}`, text: unsaved + '\n另一份尚未保存的文字。' });
    await page.reload();
    assert.equal(await editor.inputValue(), unsaved, 'an outdated recovery base must not overwrite the current saved version');
    assert.equal(await page.locator('[data-resume-recovery]').isVisible(), true);
    await page.getByRole('button', { name: '恢复这份修改', exact: true }).click();
    assert((await editor.inputValue()).includes('另一份尚未保存的文字。'));
    // Return to the accepted text before activation; the pending recovery copy is cleared on save.
    await editor.fill(unsaved);
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: '启用为新版本', exact: true }).click();
    await page.getByText('这份草稿已经启用', { exact: true }).waitFor();
    await page.getByRole('button', { name: '以此版本继续编辑', exact: true }).click();
    await page.waitForURL(value => value.searchParams.get('draftId') !== String(draft.id));
    assert.equal(await editor.inputValue(), unsaved);
    assert.equal(await editor.getAttribute('readonly'), null);
    if (process.env.OFFERGO_UX_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.OFFERGO_UX_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OFFERGO_UX_ARTIFACT_DIR, 'resume-continue-editing.png'), fullPage: true });
    }
    await editor.fill(unsaved + '\n可以补充介绍项目细节。');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForLoadState('networkidle');
    const originalDraft = require('../src/storage/resume_optimization_store').getResumeOptimization(db, { profileId: owner.profileId, optimizationId: draft.id });
    assert.equal(originalDraft.status, 'activated');
    assert.equal(originalDraft.finalText, unsaved, 'continuing edits must not mutate the activated snapshot');
    await page.getByRole('link', { name: '简历工作室', exact: true }).click();
    await page.goto(`${base}/resumes?profileId=${owner.profileId}`);
    assert.equal(await page.locator('.primary-nav [aria-current="page"]').innerText(), '简历工作室');

    // Exercise the actual shared stylesheet, with both training and report states.
    const shell = await (await fetch(`${base}/interview?planId=${owner.planId}`)).text();
    await page.route('**/color-probe', route => route.fulfill({ contentType: 'text/html', body: shell.replace('</main>',
      '<section class="interview-session-head"><h2>本轮训练</h2></section><section class="interview-report-lead"><h2>本轮结论</h2></section></main>') }));
    await page.goto(`${base}/color-probe`);
    await page.getByRole('button', { name: '切换为深色模式', exact: true }).click();
    const contrasts = await page.locator('.interview-session-head h2,.interview-report-lead h2').evaluateAll(elements => {
      const luminance = value => {
        const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
          v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      return elements.map(el => {
        const ink = luminance(getComputedStyle(el).color);
        const bg = luminance(getComputedStyle(el.parentElement).backgroundColor);
        return (Math.max(ink, bg) + .05) / (Math.min(ink, bg) + .05);
      });
    });
    assert.equal(contrasts.length, 2);
    assert(contrasts.every(value => value >= 4.5), `dark interview text must remain readable: ${contrasts}`);
    await resumePrintPaginationCheck(page);
    assert.deepEqual(errors, []);
    if (process.env.OFFERGO_UX_ARTIFACT_DIR) fs.writeFileSync(path.join(process.env.OFFERGO_UX_ARTIFACT_DIR, 'browser-results.json'), JSON.stringify({
      immediateLeave: 'passed', editWhileSaving: 'passed', failedSaveStaysInEditor: 'passed', reloadRecovery: 'passed',
      staleRecoveryRequiresChoice: 'passed', continueEditing: 'passed', activatedSnapshotPreserved: 'passed', resumeNavigation: 'passed',
      darkContrastRatios: contrasts, pageErrors: errors
    }, null, 2));
    console.log('dashboard_resume_edit_journey ok');
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

async function resumePrintPaginationCheck(page) {
  const { renderResumePrintPage } = require('../src/dashboard/pages/resume_optimization');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const compact = value => value.replace(/\s/g, '');
  async function printedPages(text) {
    await page.setContent(renderResumePrintPage(text));
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const task = getDocument({ data: new Uint8Array(pdf), disableWorker: true, useSystemFonts: true });
    const document = await task.promise;
    try {
      const pages = [];
      for (let index = 1; index <= document.numPages; index++) {
        const content = await (await document.getPage(index)).getTextContent();
        pages.push(compact(content.items.map(item => item.str || '').join('')));
      }
      assert.equal(pages.join(''), compact(text), 'printing must preserve all text in its original order');
      return pages;
    } finally { await document.destroy(); }
  }
  const endings = [
    index => `保留原有续行 END${String(index + 1).padStart(2, '0')}`,
    index => `${['壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖', '拾', '十一', '十二'][index]}号条目续句结束`,
    index => `在2024-2025期间参与接口开发并处理异常 END${String(index + 1).padStart(2, '0')}`
  ];
  for (const ending of endings) {
    const items = Array.from({ length: 12 }, (_, index) =>
      `${index + 1}. START${String(index + 1).padStart(2, '0')} ${'参与订单接口实现、排查异常并核对结果。'.repeat(18)}\n${ending(index)}`);
    const text = `合成候选人\n项目经历\n订单平台 2024-2025\n内容:\n${items.join('\n')}\n\n教育经历\n示例大学 本科 2020-2024`;
    const pages = await printedPages(text);
    assert(pages.length > 1, 'the fixture must exercise real page boundaries');
    for (let index = 0; index < items.length; index++) {
      const id = String(index + 1).padStart(2, '0');
      assert.equal(pages.findIndex(text => text.includes(`START${id}`)), pages.findIndex(text => text.includes(compact(ending(index)))),
        `normal-length item ${id} and its continuation must not split across printed pages`);
    }
    const titlePage = pages.findIndex(text => text.includes('教育经历'));
    assert(pages[titlePage].includes('示例大学'), 'a section heading must stay with its following content');
  }
  const longPages = await printedPages(`项目经历\n• LONGSTART ${'长条目保留所有原文，允许正常跨页。'.repeat(300)} LONGEND\n\n说明:\n<script>bad()</script>`);
  assert(longPages.length > 1, 'an oversized item must remain printable across multiple pages');
  assert(!await page.locator('main script').count(), 'printing must escape source HTML');
}
