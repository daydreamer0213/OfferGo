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
    const skillText = 'Node.js、TypeScript、PostgreSQL、Redis。';
    const original = [
      '陈亦航', '求职方向：Node.js 后端开发', '',
      '个人优势', '围绕订单接口实现与测试积累开发实践。', '',
      '专业技能', skillText, '',
      '工作经历', '示例科技 后端开发 2023-2025', '负责订单查询、退款接口与支付回调的实现和测试。', '',
      '项目经历', '订单平台 2024-2025', '内容:',
      '使用 PostgreSQL 事务和交易号唯一约束处理重复回调。', '联调覆盖重复请求与并发请求。', '',
      '退款工具 2023-2024', '内容:', '使用 Node.js 和 Redis 实现退款结果查询。',
      '保留失败记录并支持按交易号核对结果。', '',
      '教育经历', '示例大学 本科 2019-2023', '计算机科学与技术', '',
      '资格证书', '英语六级', '', '## 开源贡献', '维护订单接口示例与使用说明。'
    ].join('\n');
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
    if (process.env.OFFERGO_UX_ARTIFACT_DIR) fs.mkdirSync(process.env.OFFERGO_UX_ARTIFACT_DIR, { recursive: true });
    browser = await chromium.launch({ channel: 'msedge', headless: true,
      ...(process.env.OFFERGO_UX_ARTIFACT_DIR ? { downloadsPath: process.env.OFFERGO_UX_ARTIFACT_DIR } : {}) });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const url = `${base}/resume-optimization?planId=${owner.planId}&draftId=${draft.id}`;
    const editor = page.locator('#resume-opt-final-text');
    const skills = page.locator('[data-resume-section-field][aria-label="专业技能"]');
    await page.goto(url);
    assert.equal(await skills.count(), 1, 'a structured resume must expose its original skill section as an editable field');
    assert.equal(await skills.isVisible(), true);
    const expectedHeadings = ['个人优势', '专业技能', '工作经历', '项目经历', '教育经历', '资格证书', '开源贡献'];
    const headings = (await page.locator('[data-resume-section] h3').allTextContents()).map(value => value.trim());
    assert.deepEqual(headings.filter(title => expectedHeadings.includes(title)), expectedHeadings,
      'original section titles, including an unknown explicit heading, must keep their source order');
    const projects = page.locator('[data-resume-section]').filter({ has: page.getByRole('heading', { name: '项目经历', exact: true, level: 3 }) });
    assert.deepEqual((await projects.locator('h4').allTextContents()).map(value => value.trim()),
      ['订单平台 2024-2025', '退款工具 2023-2024'], 'two explicitly titled projects must remain independently editable');
    assert.equal(await page.locator('[data-resume-section-field][aria-label="订单平台 2024-2025"]').count(), 1);
    assert.equal(await page.locator('[data-resume-section-field][aria-label="退款工具 2023-2024"]').count(), 1);
    assert.equal(await editor.inputValue(), original, 'opening the section editor must preserve every source character');
    assert.equal(await editor.isVisible(), false, 'the full text editor belongs in a collapsed optional entry');
    assert.equal(await editor.locator('xpath=ancestor::details').count(), 1);
    const initialSkillValue = await skills.inputValue();
    assert(initialSkillValue.includes(skillText));
    const fillSkills = async text => skills.fill(text);
    const latestSkills = 'TypeScript、Node.js、PostgreSQL、Redis。';
    const latest = original.replace(skillText, latestSkills);
    let releaseExportSave;
    const exportSaveGate = new Promise(resolve => { releaseExportSave = resolve; });
    await page.route('**/api/resume-optimization/save', async route => { await exportSaveGate; await route.continue(); });
    await fillSkills(latestSkills);
    assert.equal(await editor.inputValue(), latest,
      'replacing a whole section must preserve paragraph boundaries and every other source character');
    assert((await editor.inputValue()).includes('\n\n项目经历\n'));
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载文字版', exact: true }).click();
    const download = await downloading;
    assert.equal(fs.readFileSync(await download.path(), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), latest,
      'an immediate export must contain the latest section input before the autosave delay');
    assert.equal(require('../src/storage/resume_optimization_store').getResumeOptimization(db,
      { profileId: owner.profileId, optimizationId: draft.id }).finalText, original,
    'exporting an unsaved section must not depend on a completed database save');
    releaseExportSave();
    await page.unroute('**/api/resume-optimization/save');
    const fullTextEntry = page.locator('details[data-resume-full-text]');
    await fullTextEntry.locator('summary').click();
    await skills.waitFor({ state: 'hidden' });
    assert.equal(await skills.isVisible(), false, 'full text mode must not expose a stale second editable view');
    const fullTextSkills = 'PostgreSQL、Node.js、TypeScript、Redis。';
    await editor.fill(original.replace(skillText, fullTextSkills));
    await fullTextEntry.locator('summary').click();
    await skills.waitFor({ state: 'visible' });
    assert.equal(await skills.inputValue(), initialSkillValue.replace(skillText, fullTextSkills),
      'returning from full text editing must rebuild sections from the latest body');
    await fillSkills(latestSkills);
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
    await fillSkills('TypeScript、PostgreSQL、Node.js、Redis。');
    await saving;
    const duringSaveSkills = 'PostgreSQL、TypeScript、Node.js、Redis。';
    const duringSave = original.replace(skillText, duringSaveSkills);
    await fillSkills(duringSaveSkills);
    const leave = page.getByRole('link', { name: '面试训练', exact: true }).click();
    release(); await leave;
    await page.waitForURL('**/interview?**');
    await page.goto(url);
    assert.equal(await editor.inputValue(), duringSave, 'an older save acknowledgement must not discard newer input');
    await page.unroute('**/api/resume-optimization/save');

    let blocked = true;
    await page.route('**/api/resume-optimization/save', route => blocked
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟保存失败' }) }) : route.continue());
    const unsavedSkills = 'Redis、TypeScript、Node.js、PostgreSQL。';
    const unsaved = original.replace(skillText, unsavedSkills);
    await fillSkills(unsavedSkills);
    await page.getByRole('link', { name: '面试训练', exact: true }).click();
    await page.locator('[data-resume-save-status]').filter({ hasText: '保存失败' }).waitFor();
    assert.equal(page.url(), url, 'failed save must keep the user in the editor');
    assert.equal(await editor.inputValue(), unsaved);
    // A local recovery copy must survive a reload even when the database write failed.
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    assert.equal(await editor.inputValue(), unsaved, 'reload must recover the pending full text');
    assert.equal(await skills.inputValue(), initialSkillValue.replace(skillText, unsavedSkills),
      'recovered full text must also rehydrate the visible section');
    blocked = false;
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForLoadState('networkidle');
    await page.goto(url);
    assert.equal(await editor.inputValue(), unsaved);
    const recoveryKeys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('offergo:resume-draft:')));
    assert.equal(recoveryKeys.length, 0, 'successful save clears only acknowledged recovery copies');
    await page.evaluate(({ key, text }) => localStorage.setItem(key, JSON.stringify({ baseText: '过时的数据库正文', text })),
      { key: `offergo:resume-draft:${owner.planId}:${draft.id}`, text: original.replace(skillText, latestSkills) });
    await page.reload();
    assert.equal(await editor.inputValue(), unsaved, 'an outdated recovery base must not overwrite the current saved version');
    assert.equal(await skills.inputValue(), initialSkillValue.replace(skillText, unsavedSkills));
    assert.equal(await page.locator('[data-resume-recovery]').isVisible(), true);
    await page.getByRole('button', { name: '恢复这份修改', exact: true }).click();
    assert.equal(await editor.inputValue(), latest);
    assert.equal(await skills.inputValue(), initialSkillValue.replace(skillText, latestSkills),
      'explicitly restoring an older local copy must update both views');
    // Return to the accepted text before activation; the pending recovery copy is cleared on save.
    await fillSkills(unsavedSkills);
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForLoadState('networkidle');

    await page.route('**/api/resume-optimization/activate', route => route.fulfill({
      status: 409, contentType: 'application/json', body: JSON.stringify({
        error: '当前简历还不能启用，请先处理下面的问题。', errorCode: 'RESUME_ACTIVATION_INTEGRITY_FAILED',
        issues: [{ code: 'RESUME_PLACEHOLDER_PRESENT' }]
      })
    }));
    await page.getByRole('button', { name: '启用为新版本', exact: true }).click();
    await page.locator('[data-resume-save-status]').filter({ hasText: '当前简历还不能启用' }).waitFor();
    assert.equal(await editor.inputValue(), unsaved);
    assert.equal(await skills.evaluate(field => field.readOnly), false,
      'a rejected activation must unlock the visible section editor');
    assert.equal(await page.locator('[data-resume-section-field][readonly]').count(), 0);
    await page.unroute('**/api/resume-optimization/activate');
    await page.getByRole('button', { name: '启用为新版本', exact: true }).click();
    await page.getByText('这份草稿已经启用', { exact: true }).waitFor();
    assert.equal(await skills.evaluate(field => field.readOnly), true);
    assert.equal(await page.locator('[data-resume-section-field]:not([readonly])').count(), 0,
      'every visible section in an activated snapshot must be read-only');
    await page.getByRole('button', { name: '以此版本继续编辑', exact: true }).click();
    await page.waitForURL(value => value.searchParams.get('draftId') !== String(draft.id));
    assert.equal(await editor.inputValue(), unsaved);
    assert.equal(await editor.getAttribute('readonly'), null);
    assert.equal(await skills.getAttribute('readonly'), null);
    if (process.env.OFFERGO_UX_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.OFFERGO_UX_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OFFERGO_UX_ARTIFACT_DIR, 'resume-continue-editing.png'), fullPage: true });
    }
    await fillSkills(latestSkills);
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForLoadState('networkidle');
    const originalDraft = require('../src/storage/resume_optimization_store').getResumeOptimization(db, { profileId: owner.profileId, optimizationId: draft.id });
    assert.equal(originalDraft.status, 'activated');
    assert.equal(originalDraft.finalText, unsaved, 'continuing edits must not mutate the activated snapshot');
    const emptyEndingText = original.slice(0, original.indexOf('\n\n资格证书')) + '\n\n资格证书';
    const emptyOwner = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '陈亦航', city: '杭州', targetTitles: ['后端开发'] } },
      document: { originalFileName: 'empty-ending.txt', format: 'text', contentHash: 'empty-ending', text: emptyEndingText, diagnostics: {} },
      searchPlan: { name: '空章节编辑', cities: ['杭州'], directions: ['后端开发'], keywords: [{ word: '后端开发', priority: 'A' }] }
    });
    const emptyDraft = createResumeOptimization(db, { profileId: emptyOwner.profileId, planId: emptyOwner.planId,
      sourceResumeVersionId: emptyOwner.resumeVersionId, mode: 'general', generatedText: emptyEndingText,
      headline: '末尾空章节', suggestions: [], evidenceCatalog: [] });
    await page.goto(`${base}/resume-optimization?planId=${emptyOwner.planId}&draftId=${emptyDraft.id}`);
    const certificate = page.locator('[data-resume-section-field][aria-label="资格证书"]');
    assert.equal(await certificate.inputValue(), '');
    await certificate.fill('英语六级');
    assert.equal(await editor.inputValue(), emptyEndingText + '\n英语六级',
      'entering content in a final empty section must insert a line break after its title');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForLoadState('networkidle');
    assert.equal(await certificate.inputValue(), '英语六级');
    assert.equal(await editor.inputValue(), emptyEndingText + '\n英语六级');
    const unstructuredText = '陈亦航参与订单接口开发，使用 TypeScript 和 Node.js 实现查询，并以本机测试核对处理结果。';
    const plainOwner = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '陈亦航', city: '杭州', targetTitles: ['后端开发'] } },
      document: { originalFileName: 'plain.txt', format: 'text', contentHash: 'plain-editor', text: unstructuredText, diagnostics: {} },
      searchPlan: { name: '无章节编辑', cities: ['杭州'], directions: ['后端开发'], keywords: [{ word: '后端开发', priority: 'A' }] }
    });
    const plainDraft = createResumeOptimization(db, { profileId: plainOwner.profileId, planId: plainOwner.planId,
      sourceResumeVersionId: plainOwner.resumeVersionId, mode: 'general', generatedText: unstructuredText,
      headline: '无章节简历', suggestions: [], evidenceCatalog: [] });
    await page.goto(`${base}/resume-optimization?planId=${plainOwner.planId}&draftId=${plainDraft.id}`);
    assert.equal(await editor.isVisible(), true, 'an unstructured resume must fall back to full text editing');
    const introducedHeading = unstructuredText + '\n\n项目经历\n参与订单查询接口实现与本机测试。';
    await editor.fill(introducedHeading);
    await editor.press('End');
    assert.equal(await fullTextEntry.evaluate(details => details.open), true,
      'typing the first recognizable heading must not collapse the editor while the user is writing');
    assert.equal(await editor.isVisible(), true);
    await fullTextEntry.locator('summary').click();
    await page.locator('[data-resume-section-field][aria-label="项目经历"]').waitFor({ state: 'visible' });
    assert.equal(await editor.inputValue(), introducedHeading, 'manual mode changes must preserve the new section text');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.waitForLoadState('networkidle');
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
      originalSectionOrder: 'passed', independentProjects: 'passed', untouchedTextPreserved: 'passed', immediateExport: 'passed',
      fullTextRoundTrip: 'passed', rejectedActivationUnlocks: 'passed', activatedSectionsReadOnly: 'passed',
      wholeSectionReplacement: 'passed', emptyFinalSection: 'passed',
      firstHeadingKeepsFullEditorOpen: 'passed',
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
