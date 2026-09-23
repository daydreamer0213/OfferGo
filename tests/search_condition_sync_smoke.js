const assert = require('node:assert/strict');
const { buildTodayViewModel } = require('../src/dashboard/view_models/today');
const { renderTodayPage } = require('../src/dashboard/pages/today');

async function waitUntil(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the held browser read');
}

function today(site, active = false) {
  const vm = buildTodayViewModel({
    site,
    enabledPlatforms: ['boss', 'zhaopin'],
    profile: { id: 1, profile: { candidate: { city: '广州' } } },
    planRecord: { id: 1, profileId: 1 },
    plan: { name: '合成方案', keywords: [{ word: '产品经理' }] },
    validation: { valid: true, errors: [], warnings: [] },
    platformContext: site === 'zhaopin' ? { filterSummary: ['城市：广州'] } : null
  });
  vm.primary = { type: 'link', href: '#', label: '继续' };
  if (active) vm.form.acquisition.activeSnapshot = { summary: '城市：广州' };
  return renderTodayPage(vm);
}

async function main() {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === '1') throw error;
    console.log('search_condition_sync_smoke skipped: provide Playwright using NODE_PATH');
    return;
  }
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const site of ['boss', 'zhaopin']) {
      const page = await browser.newPage();
      let current = '城市：广州';
      let reads = 0;
      let failRead = false;
      let holdNextBoss = false;
      let releaseBoss = null;
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/plan') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: today(site) });
        if (url.pathname === '/api/browser-readiness') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ready', ready: true }) });
        if (url.pathname === '/api/acquisition-preview' || url.pathname === '/api/platform-search/save') {
          reads++;
          if (url.pathname === '/api/acquisition-preview' && holdNextBoss) {
            holdNextBoss = false;
            await new Promise(resolve => { releaseBoss = resolve; });
          }
          if (failRead) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '搜索页暂时无法读取' }) });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ready', summary: current, message: '搜索条件已更新', changed: true }) });
        }
        return route.fulfill({ status: 204 });
      });
      await page.goto('http://offergo.test/plan');
      await page.locator('[data-discovery-scope]').getByText('城市：广州').waitFor();
      const firstReads = reads;
      assert(firstReads >= 1, `${site}: page entry should read current search conditions`);
      current = '城市：深圳';
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.locator('[data-discovery-scope]').getByText('城市：深圳').waitFor();
      assert.equal(reads, firstReads + 1, `${site}: returning to Dashboard should reread once`);
      current = '城市：佛山';
      await page.getByRole('button', { name: '重新读取搜索条件' }).click();
      await page.locator('[data-discovery-scope]').getByText('城市：佛山').waitFor();
      failRead = true;
      await page.getByRole('button', { name: '重新读取搜索条件' }).click();
      await page.locator('[data-condition-status]').getByText('搜索页暂时无法读取').waitFor();
      assert.equal(await page.locator('[data-discovery-scope]').innerText(), '城市：佛山', `${site}: a failed reread must keep the last trusted conditions`);
      failRead = false;
      if (site === 'boss') {
        holdNextBoss = true;
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await waitUntil(() => releaseBoss);
        await page.getByLabel('本次找岗平台').selectOption('both');
        releaseBoss();
        await page.locator('[data-discovery-scope]').getByText(/BOSS：城市：佛山；智联：城市：佛山/).waitFor({ timeout: 3000 });
      }
      await page.close();
    }
    const activePage = await browser.newPage();
    let activeReads = 0;
    await activePage.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/plan') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: today('zhaopin', true) });
      if (pathname === '/api/acquisition-preview' || pathname === '/api/platform-search/save') activeReads++;
      return route.fulfill({ status: 204 });
    });
    await activePage.goto('http://offergo.test/plan');
    await activePage.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(activeReads, 0, 'active workflow must not auto-save new conditions');
    await activePage.close();
    console.log('search_condition_sync_smoke ok');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
