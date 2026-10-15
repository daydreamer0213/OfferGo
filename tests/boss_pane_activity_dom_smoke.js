const assert = require("node:assert/strict");
const { PAGE_HELPERS } = require("../src/adapters/sites/boss");

async function main() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === "1") throw error;
    console.log("boss_pane_activity_dom_smoke skipped: playwright unavailable");
    return;
  }
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    const cases = [
      { name: "selected pane exact online label", inside: '<span class="boss-online-tag"> \n 在线 \t </span>', expected: "今日活跃" },
      { name: "online label outside selected pane", outside: '<span class="boss-online-tag">在线</span>', expected: "" },
      { name: "online customer service in description", description: "负责在线客服系统集成", expected: "" },
      { name: "non-exact online label", inside: '<span class="boss-online-tag">在线客服</span>', expected: "" },
      { name: "no activity label", expected: "" },
      { name: "explicit week activity precedes online label", inside: '<span>本周活跃</span><span class="boss-online-tag">在线</span>', expected: "本周活跃" },
      { name: "existing online icon", inside: '<i class="boss-online-icon"></i>', expected: "今日活跃" }
    ];
    for (const fixture of cases) {
      await page.setContent(`
        ${fixture.outside || ""}
        <div class="job-card-wrap active"><div class="job-card-box"><a href="https://www.zhipin.com/job_detail/selected-job.html">AI工程师</a></div></div>
        <div class="job-detail-container">
          <div class="job-primary"><h1>AI工程师</h1></div>
          <a href="https://www.zhipin.com/job_detail/selected-job.html">岗位</a>
          ${fixture.inside || ""}
          <div class="job-sec-text">${fixture.description || "负责AI应用开发"}</div>
        </div>`);
      await page.evaluate(() => {
        document.querySelector(".job-card-wrap").__vue__ = {
          $options: { name: "PageJobs" },
          currentJob: { encryptJobId: "selected-job" },
          jobDetailLoading: false
        };
        window.__bossPaneState = () => ({ bossActiveText: "previous helper" });
      });
      await page.evaluate(PAGE_HELPERS);
      const state = await page.evaluate(() => window.__bossPaneState());
      assert.equal(state.activeJobId, "selected-job", fixture.name);
      assert.equal(state.componentCurrentJobId, "selected-job", fixture.name);
      assert.equal(state.paneJobId, "selected-job", fixture.name);
      assert.equal(state.description, fixture.description || "负责AI应用开发", fixture.name);
      assert.equal(state.bossActiveText, fixture.expected, fixture.name);
      console.log(`PASS ${fixture.name}`);
    }
    console.log("boss_pane_activity_dom_smoke ok");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
