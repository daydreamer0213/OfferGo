const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "src");

const offenders = [];
for (const layer of ["application", "dashboard"]) {
  for (const file of javascriptFiles(path.join(ROOT, layer))) {
    const source = fs.readFileSync(file, "utf8");
    if (/\bdb\.prepare\s*\(/.test(source)) offenders.push(path.relative(ROOT, file));
  }
}
assert.deepStrictEqual(offenders, [], `presentation/application SQL must live in stores: ${offenders.join(", ")}`);

const legacyApplicationImports = javascriptFiles(path.join(ROOT, "application"))
  .filter((file) => /core\/storage/.test(fs.readFileSync(file, "utf8")))
  .map((file) => path.relative(ROOT, file));
assert.deepStrictEqual(legacyApplicationImports, [], `application must use explicit stores: ${legacyApplicationImports.join(", ")}`);

const storageSource = fs.readFileSync(path.join(ROOT, "core", "storage.js"), "utf8");
assert.match(storageSource, /require\("\.\.\/storage\/database"\)/);
assert.match(storageSource, /require\("\.\.\/storage\/schema"\)/);
assert.match(storageSource, /require\("\.\.\/storage\/migrations"\)/);

console.log("storage_boundary_smoke: ok");

function javascriptFiles(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...javascriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".js")) result.push(fullPath);
  }
  return result;
}
