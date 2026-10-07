const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Exercise the files actually staged for users, rather than the build allowlist.
function assertPackageDocumentClosure(packageRoot, entry = "README.md") {
  const root = path.resolve(packageRoot);
  const visited = new Set();
  const pending = [entry];
  const failures = [];
  let localLinks = 0;
  while (pending.length) {
    const relative = pending.shift();
    if (visited.has(relative)) continue;
    visited.add(relative);
    const filename = path.resolve(root, relative);
    assert(fs.existsSync(filename), `packaged guide missing: ${relative}`);
    const document = fs.readFileSync(filename, "utf8").replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
    for (const match of document.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1].replace(/^<|>$/g, "");
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue;
      localLinks++;
      const [filePart, fragment = ""] = link.split("#");
      const target = path.resolve(path.dirname(filename), decodeURIComponent(filePart || path.basename(filename)));
      const targetRelative = path.relative(root, target);
      if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) {
        failures.push(`${relative}: ${link} leaves the package`);
        continue;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        failures.push(`${relative}: missing ${link}`);
        continue;
      }
      if (fragment && target.endsWith(".md")) {
        const headings = [...fs.readFileSync(target, "utf8").matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)]
          .map((heading) => heading[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-"));
        if (!headings.includes(decodeURIComponent(fragment))) failures.push(`${relative}: missing anchor ${link}`);
      }
      if (target.endsWith(".md")) pending.push(targetRelative);
    }
  }
  assert.deepStrictEqual(failures, [], `packaged documentation has broken links:\n${failures.join("\n")}`);
  return { documents: visited.size, localLinks };
}

module.exports = { assertPackageDocumentClosure };

if (require.main === module) {
  assert(process.argv[2], "pass the actual package directory");
  console.log(JSON.stringify(assertPackageDocumentClosure(process.argv[2])));
}
