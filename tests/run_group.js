#!/usr/bin/env node
const { groups } = require("./test_manifest");
const { runTests } = require("./test_runner");

const group = String(process.argv[2] || "").trim();
if (!Object.hasOwn(groups, group)) {
  console.error(`Unknown test group: ${group || "(empty)"}. Choose fast, integration, or package.`);
  process.exitCode = 2;
} else if (process.argv.includes("--list")) {
  process.stdout.write(`${groups[group].join("\n")}\n`);
} else {
  const status = runTests(groups[group]);
  if (status === 0) console.log(`\nAll ${groups[group].length} ${group} checks passed.`);
  process.exitCode = status;
}
