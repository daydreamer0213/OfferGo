const fs = require("node:fs");
const path = require("node:path");

function createModelRuntimeCache({ resolve, signature = () => "runtime" } = {}) {
  if (typeof resolve !== "function") throw new TypeError("model runtime cache requires resolve");
  if (typeof signature !== "function") throw new TypeError("model runtime cache requires signature");
  const entries = new Map();
  let activeSignature = null;

  return Object.freeze({ get, invalidate });

  function get(taskProfile) {
    const profile = String(taskProfile || "").trim();
    if (!profile) throw new TypeError("taskProfile is required");
    const currentSignature = String(signature());
    if (currentSignature !== activeSignature) {
      entries.clear();
      activeSignature = currentSignature;
    }
    if (!entries.has(profile)) entries.set(profile, resolve(profile));
    return entries.get(profile);
  }

  function invalidate() {
    entries.clear();
    activeSignature = null;
  }
}

function modelRuntimeFileSignature(root) {
  const runtimeRoot = path.join(path.resolve(String(root || process.cwd())), ".runtime");
  const files = [path.join(runtimeRoot, "settings", "model.json")];
  const secretsDir = path.join(runtimeRoot, "secrets");
  try {
    for (const name of fs.readdirSync(secretsDir).sort()) files.push(path.join(secretsDir, name));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files.map(fileSignature).join("|");
}

function fileSignature(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${path.basename(file)}:${stat.size}:${stat.mtimeNs}`;
  } catch (error) {
    if (error?.code === "ENOENT") return `${path.basename(file)}:missing`;
    throw error;
  }
}

module.exports = { createModelRuntimeCache, modelRuntimeFileSignature };
