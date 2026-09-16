const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  analyzeArchitecture,
  assertArchitecture,
  loadArchitecturePolicy
} = require("../scripts/check-architecture-boundaries");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "offergo-architecture-"));

try {
  const sourceRoot = path.join(tempRoot, "src");
  write(sourceRoot, "core/rule.js", 'module.exports = require("./value");\n');
  write(sourceRoot, "core/value.js", "module.exports = 1;\n");
  write(sourceRoot, "storage/repository.js", "module.exports = {};\n");

  const policy = {
    version: 1,
    dependencyRules: [
      {
        id: "core-outward",
        from: ["core/**"],
        deny: ["storage/**", "application/**", "adapters/**", "dashboard/**"]
      }
    ],
    patternRules: [],
    exceptions: []
  };

  assert.deepStrictEqual(analyzeArchitecture({ sourceRoot, policy }), {
    edges: ["core/rule.js -> core/value.js"],
    cycles: [],
    violations: [],
    staleExceptions: []
  });

  write(sourceRoot, "core/rule.js", 'module.exports = require("../storage/repository");\n');
  const violation = analyzeArchitecture({ sourceRoot, policy });
  assert.deepStrictEqual(violation.violations, [
    {
      key: "dependency:core-outward:core/rule.js -> storage/repository.js",
      ruleId: "core-outward",
      kind: "dependency",
      file: "core/rule.js",
      target: "storage/repository.js"
    }
  ]);
  assert.throws(
    () => assertArchitecture({ sourceRoot, policy }),
    (error) => error.code === "ARCHITECTURE_BOUNDARY_FAILED"
      && error.message.includes("core/rule.js -> storage/repository.js")
  );

  const exceptedPolicy = {
    ...policy,
    exceptions: [violation.violations[0].key]
  };
  assert.deepStrictEqual(
    analyzeArchitecture({ sourceRoot, policy: exceptedPolicy }).violations,
    []
  );
  write(sourceRoot, "core/rule.js", "module.exports = 1;\n");
  assert.deepStrictEqual(
    analyzeArchitecture({ sourceRoot, policy: exceptedPolicy }).staleExceptions,
    [violation.violations[0].key]
  );

  write(sourceRoot, "core/rule.js", 'module.exports = require("./value");\n');
  write(sourceRoot, "core/value.js", 'module.exports = require("./rule");\n');
  assert.deepStrictEqual(
    analyzeArchitecture({ sourceRoot, policy }).cycles,
    [["core/rule.js", "core/value.js"]]
  );

  const projectRoot = path.join(__dirname, "..");
  const projectPolicy = loadArchitecturePolicy(path.join(projectRoot, "architecture-boundaries.json"));
  const projectResult = assertArchitecture({
    sourceRoot: path.join(projectRoot, "src"),
    policy: projectPolicy
  });
  assert.strictEqual(projectResult.cycles.length, 0);
  assert.strictEqual(projectResult.violations.length, 0);
  assert.strictEqual(projectResult.staleExceptions.length, 0);

  console.log("architecture_boundaries_smoke ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function write(sourceRoot, relativePath, contents) {
  const target = path.join(sourceRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}
