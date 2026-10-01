const { all } = require("./test_manifest");
const { runTests } = require("./test_runner");

const browserRequired = process.argv.includes("--browser-required");
if (browserRequired) {
  process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT = "1";
  try { require.resolve("playwright"); }
  catch {
    console.error("Release browser checks require Playwright. Point NODE_PATH to its node_modules directory (prefer D:\\DevData), then rerun.");
    process.exit(1);
  }
}
const status = runTests(all);
if (status === 0) console.log(`\nAll ${all.length} offline checks passed${browserRequired ? " with browser checks required" : ""}.`);
process.exitCode = status;
