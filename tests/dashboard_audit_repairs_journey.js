const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const storage = require('../src/core/storage');
const { createLogger } = require('../src/core/observability');
const { createDashboardServer } = require('../src/dashboard/server');

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === '1') throw error;
    console.log('dashboard_audit_repairs_journey SKIP: Playwright unavailable'); return;
  }
  const artifactDir = process.env.OFFERGO_UX_ARTIFACT_DIR;
  const tempBase = process.platform === 'win32' ? 'D:/DevData/OfferGo-validation' : os.tmpdir();
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'audit-repair-'));
  const db = storage.openDb(':memory:');
  let browser, server;
  try {
    const owner = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '测试用户', city: '广州', targetTitles: ['后端开发'] } },
      document: { contentHash: 'audit-ui', text: '参与订单接口开发和测试', originalFileName: 'resume.txt', format: 'text' },
      searchPlan: { name: '找岗方案', directions: ['后端开发'], keywords: [{ word: '后端开发', priority: 'A' }] }
    });
    for (const source of ['boss', 'zhaopin']) {
      const batch = storage.createBatch(db, source, 'audit', '测试找岗', { profileId: owner.profileId, searchPlanId: owner.planId });
      storage.upsertJob(db, { source, sourceId: 'audit-'+source, title: '后端开发工程师', company: '模拟公司', location: '广州',
        salary: '12-18K', description: '负责订单查询与退款接口开发，参与联调和测试。', keyword: '后端开发',
        analysis: { semanticStatus: 'complete', recommendation: 'apply', recommendationSchemaVersion: 2, fitLevel: 'fit', confidence: .9, hardBlockers: [], evidence: { jd: [], resume: [] } } }, batch);
    }
    const logger = createLogger({ root, component: 'audit-test' });
    logger.error('earlier_failure', { requestId: 'error-before-poll', errorCode: 'MODEL_TIMEOUT' });
    for (let i = 0; i < 130; i++) logger.info('normal_poll', { sequence: i });
    server = createDashboardServer({ db, root, dataRoot: root, logger, forceMock: true, allowOfflineMock: true,
      browserAuthority: { browserMode: 'edge', cdpPort: null, profilePath: '' } });
    const base = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:'+server.address().port)));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const failures = [];
    async function check(name, fn) { try { await fn(); } catch (error) { failures.push(name+': '+error.message); } }
    await check('version settings', async () => {
      await page.goto(base+'/resumes?profileId='+owner.profileId);
      const form = page.locator('form').filter({ has: page.locator('input[name="versionId"]') }).first();
      await form.locator('input[name="name"]').fill('我的投递版');
      await form.locator('input[name="isActive"]').uncheck();
      await Promise.all([page.waitForURL('**/resumes?**saved=1'), form.getByRole('button', { name: '保存版本设置' }).click()]);
      const saved = storage.listCandidateResumeVersions(db, owner.profileId).find(v => v.id === owner.resumeVersionId);
      assert.equal(saved.name, '我的投递版'); assert.equal(saved.isActive, false);
    });
    await check('diagnostics', async () => {
      await page.goto(base+'/diagnostics');
      assert((await page.locator('main').innerText()).includes('error-before-poll'));
    });
    await check('job order and themes', async () => {
      for (const site of ['boss', 'zhaopin']) {
        await page.goto(base+'/queue?planId='+owner.planId+'&site='+site);
        const jobs = page.locator('.job-ledger');
        assert.equal(await jobs.locator('article.job').count(), 1);
        if (site === 'boss') {
          const statistics = page.locator('details.job-statistics');
          assert.equal(await statistics.getAttribute('open'), null);
          assert(await jobs.evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector('details.job-statistics')) & Node.DOCUMENT_POSITION_FOLLOWING)));
          await statistics.locator('summary').click();
          assert.equal(await page.locator('.outcome-tier-table').isVisible(), true);
        }
        for (const theme of ['light','dark']) {
          await page.evaluate(theme => { localStorage.setItem('offergo:theme', theme); document.documentElement.dataset.theme = theme; }, theme);
          const colors = await page.evaluate(() => {
            const body = getComputedStyle(document.body);
            const status = document.querySelector('.runtime-status');
            const card = document.querySelector('article.job');
            return { canvas: body.backgroundColor, expected: getComputedStyle(document.documentElement).getPropertyValue('--rf-canvas').trim(),
              statusColor: getComputedStyle(status).color, statusBackground: getComputedStyle(status).backgroundColor,
              cardBackground: getComputedStyle(card).backgroundColor };
          });
          if (theme === 'dark') {
            assert.equal(colors.canvas, 'rgb(21, 28, 26)');
            assert.notEqual(colors.statusColor, 'rgb(31, 41, 51)');
            assert.notEqual(colors.cardBackground, 'rgb(255, 255, 255)');
            const contrasts = await page.locator('.job button:not(.apply)').evaluateAll(elements => {
              const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
                v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
              }).reduce((sum, v, i) => sum + v * [.2126,.7152,.0722][i], 0);
              return elements.filter(el => el.getClientRects().length).map(el => {
                const style = getComputedStyle(el), ink = luminance(style.color), bg = luminance(style.backgroundColor);
                return (Math.max(ink,bg)+.05)/(Math.min(ink,bg)+.05);
              });
            });
            assert(contrasts.every(ratio => ratio >= 4.5), 'job action text must remain readable in dark mode');
          }
          if (artifactDir) { fs.mkdirSync(artifactDir, { recursive: true }); await page.screenshot({ path: path.join(artifactDir, 'jobs-'+site+'-'+theme+'.png'), fullPage: true }); }
        }
        await page.setViewportSize({ width: 640, height: 900 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
    });
    await check('sidebar theme control does not overlap navigation', async () => {
      await page.goto(base+'/queue?planId='+owner.planId+'&site=boss');
      for (const viewport of [{ width:1528, height:750 }, { width:1440, height:600 }, { width:1440, height:480 }, { width:1440, height:1000 }, { width:640, height:600 }, { width:390, height:844 }]) {
        await page.setViewportSize(viewport);
        for (const theme of ['light','dark']) {
          const overlaps = await page.evaluate(theme => {
            document.documentElement.dataset.theme = theme;
            const button = document.querySelector('[data-theme-toggle]').getBoundingClientRect();
            return [...document.querySelectorAll('.app-sidebar .nav-item')].filter(node => {
              const item = node.getBoundingClientRect();
              return Math.min(button.right,item.right)-Math.max(button.left,item.left) > .5
                && Math.min(button.bottom,item.bottom)-Math.max(button.top,item.top) > .5;
            }).map(node => node.textContent.trim());
          }, theme);
          assert.deepEqual(overlaps, [], `${theme} ${viewport.width}x${viewport.height}: theme button overlaps navigation`);
          await page.locator('[data-theme-toggle]').click();
          assert.equal(await page.locator('html').getAttribute('data-theme'), theme === 'light' ? 'dark' : 'light');
        }
      }
      await page.getByRole('link', { name:'运行诊断', exact:true }).click();
      await page.waitForURL(url => url.pathname === '/diagnostics', { waitUntil:'domcontentloaded' });
    });
    assert.deepEqual(failures, []);
    console.log('dashboard_audit_repairs_journey ok');
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
