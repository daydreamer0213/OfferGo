#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function loadArchitecturePolicy(policyPath) {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  if (policy?.version !== 1) throw architectureError("ARCHITECTURE_POLICY_INVALID", "Architecture policy version must be 1");
  return policy;
}

function analyzeArchitecture({ sourceRoot, policy }) {
  const root = path.resolve(sourceRoot);
  const files = listJavaScriptFiles(root);
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [file, []]));
  const edges = [];
  const findings = [];

  for (const file of files) {
    const contents = fs.readFileSync(file, "utf8");
    const from = relative(root, file);
    for (const target of literalRelativeRequires(file, contents, fileSet)) {
      graph.get(file).push(target);
      const to = relative(root, target);
      const edge = `${from} -> ${to}`;
      edges.push(edge);
      for (const rule of policy.dependencyRules || []) {
        if (!matchesAny(from, rule.from) || !matchesAny(to, rule.deny)) continue;
        findings.push({
          key: `dependency:${rule.id}:${edge}`,
          ruleId: rule.id,
          kind: "dependency",
          file: from,
          target: to
        });
      }
    }
    for (const rule of policy.patternRules || []) {
      if (!matchesAny(from, rule.files)) continue;
      const expression = new RegExp(rule.pattern, rule.flags?.includes("g") ? rule.flags : `${rule.flags || ""}g`);
      let match;
      let ordinal = 0;
      while ((match = expression.exec(contents))) {
        ordinal += 1;
        const line = lineNumberAt(contents, match.index);
        const fingerprint = patternFingerprint(contents, line, ordinal);
        findings.push({
          key: `pattern:${rule.id}:${from}#${fingerprint}`,
          ruleId: rule.id,
          kind: "pattern",
          file: from,
          line
        });
        if (match[0] === "") expression.lastIndex += 1;
      }
    }
  }

  const exceptionSet = new Set(policy.exceptions || []);
  const findingKeys = new Set(findings.map((finding) => finding.key));
  return {
    edges: [...new Set(edges)].sort(),
    cycles: dependencyCycles(graph, root),
    violations: findings.filter((finding) => !exceptionSet.has(finding.key)).sort(compareFinding),
    staleExceptions: [...exceptionSet].filter((key) => !findingKeys.has(key)).sort()
  };
}

function assertArchitecture(input) {
  const result = analyzeArchitecture(input);
  if (!result.cycles.length && !result.violations.length && !result.staleExceptions.length) return result;
  const lines = ["Architecture boundary check failed."];
  for (const cycle of result.cycles) lines.push(`cycle: ${cycle.join(" -> ")} -> ${cycle[0]}`);
  for (const finding of result.violations) lines.push(`violation: ${finding.key}`);
  for (const key of result.staleExceptions) lines.push(`stale exception: ${key}`);
  throw architectureError("ARCHITECTURE_BOUNDARY_FAILED", lines.join("\n"));
}

function listJavaScriptFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.normalize(target));
    }
  };
  visit(root);
  return files;
}

function literalRelativeRequires(file, contents, fileSet) {
  const targets = [];
  const expression = /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g;
  let match;
  while ((match = expression.exec(contents))) {
    const resolved = resolveLocalModule(path.dirname(file), match[2]);
    if (resolved && fileSet.has(resolved)) targets.push(resolved);
  }
  return targets;
}

function resolveLocalModule(directory, request) {
  const base = path.resolve(directory, request);
  for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.normalize(candidate);
  }
  return null;
}

function dependencyCycles(graph, root) {
  let nextIndex = 0;
  const stack = [];
  const stacked = new Set();
  const indices = new Map();
  const lows = new Map();
  const cycles = [];

  const visit = (node) => {
    indices.set(node, nextIndex);
    lows.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    stacked.add(node);
    for (const target of graph.get(node) || []) {
      if (!indices.has(target)) {
        visit(target);
        lows.set(node, Math.min(lows.get(node), lows.get(target)));
      } else if (stacked.has(target)) {
        lows.set(node, Math.min(lows.get(node), indices.get(target)));
      }
    }
    if (lows.get(node) !== indices.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      stacked.delete(current);
      component.push(relative(root, current));
    } while (current !== node);
    if (component.length > 1) cycles.push(component.sort());
  };

  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return cycles.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function matchesAny(value, patterns = []) {
  return patterns.some((pattern) => globExpression(pattern).test(value));
}

function globExpression(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function lineNumberAt(contents, index) {
  return contents.slice(0, index).split(/\r?\n/).length;
}

function patternFingerprint(contents, lineNumber, ordinal) {
  const lines = contents.split(/\r?\n/);
  const start = Math.max(0, lineNumber - 2);
  const context = lines.slice(start, Math.min(lines.length, lineNumber + 1))
    .map((line) => line.trim().replace(/\s+/g, " "))
    .join("\n");
  return `${crypto.createHash("sha256").update(context).digest("hex").slice(0, 12)}-${ordinal}`;
}

function relative(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function compareFinding(left, right) {
  return left.key.localeCompare(right.key);
}

function architectureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

if (require.main === module) {
  const projectRoot = path.resolve(__dirname, "..");
  const policy = loadArchitecturePolicy(path.join(projectRoot, "architecture-boundaries.json"));
  try {
    const result = assertArchitecture({ sourceRoot: path.join(projectRoot, "src"), policy });
    console.log(`Architecture boundaries ok: ${result.edges.length} internal dependencies, no cycles.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  analyzeArchitecture,
  assertArchitecture,
  loadArchitecturePolicy
};
