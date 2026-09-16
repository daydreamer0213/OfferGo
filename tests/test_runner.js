const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { timeoutByTest } = require("./test_manifest");

function runTests(tests, { root = path.join(__dirname, "..") } = {}) {
  for (const file of tests) {
    console.log(`\n> ${file}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
      cwd: root,
      stdio: "inherit",
      timeout: timeoutByTest[file] || 120_000
    });
    if (result.error) {
      console.error(`${file}: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) return result.status || 1;
  }
  return 0;
}

module.exports = { runTests };
