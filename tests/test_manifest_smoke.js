const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const manifest = require("./test_manifest");

const direct = Object.values(manifest.groups).flat();
assert.strictEqual(new Set(direct).size, direct.length, "a test may belong to only one direct group");
assert.strictEqual(new Set(manifest.all).size, manifest.all.length, "the full gate may not contain duplicates");
assert.deepStrictEqual(
  [...direct].sort(),
  [...manifest.all].sort(),
  "test groups must partition the full gate without changing its established order"
);
assert(direct.includes("architecture_boundaries_smoke.js"));
assert(direct.includes("test_manifest_smoke.js"));

const discovered = fs.readdirSync(__dirname)
  .filter((file) => file.endsWith("_smoke.js"))
  .sort();
const accounted = new Set([...direct, ...Object.keys(manifest.indirect)]);
assert.deepStrictEqual(
  discovered.filter((file) => !accounted.has(file)),
  [],
  "every smoke check must be direct or explicitly indirect"
);
assert.deepStrictEqual(
  Object.keys(manifest.indirect).filter((file) => !discovered.includes(file)),
  [],
  "indirect entries must name existing smoke checks"
);
assert.strictEqual(
  manifest.indirect["four_tier_decision_smoke.js"],
  "self_check.js"
);

const listed = spawnSync(process.execPath, [path.join(__dirname, "run_group.js"), "fast", "--list"], {
  cwd: path.join(__dirname, ".."),
  encoding: "utf8"
});
assert.strictEqual(listed.status, 0, listed.stderr);
assert.deepStrictEqual(
  listed.stdout.trim().split(/\r?\n/),
  manifest.groups.fast
);

console.log("test_manifest_smoke ok");
