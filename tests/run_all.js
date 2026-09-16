const { all } = require("./test_manifest");
const { runTests } = require("./test_runner");

const status = runTests(all);
if (status === 0) console.log(`\nAll ${all.length} offline checks passed.`);
process.exitCode = status;
