const fs = require("node:fs");

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || "success";

if (args.includes("--version") || args[0] === "--version") {
  process.stdout.write("codex-cli 9.9.9\n");
  process.exit(0);
}

if (args.includes("--help")) {
  const flags = [
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "--output-schema",
    "--output-last-message",
    "--cd"
  ];
  if (mode === "help_missing") flags.splice(flags.indexOf("--ignore-rules"), 1);
  process.stdout.write(`Usage: codex exec\n${flags.join("\n")}\n`);
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", async () => {
  const auditPath = process.env.FAKE_CODEX_AUDIT || "";
  if (auditPath) {
    fs.appendFileSync(auditPath, `${JSON.stringify({
      args,
      cwd: process.cwd(),
      receivedPrompt: Boolean(stdin.trim())
    })}\n`);
  }
  if (mode === "auth") {
    process.stderr.write("Login required. Run codex login.\n");
    process.exit(1);
  }
  if (mode === "quota") {
    process.stderr.write("Usage limit reached.\n");
    process.exit(1);
  }
  if (mode === "failure") {
    process.stderr.write("unexpected provider failure\n");
    process.exit(1);
  }
  if (mode === "delay") await new Promise((resolve) => setTimeout(resolve, 300));
  const outputIndex = args.indexOf("--output-last-message");
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";
  if (!outputPath) process.exit(2);
  const value = mode === "invalid_json" ? "not-json" : JSON.stringify({ ok: true });
  fs.writeFileSync(outputPath, value);
  process.stdout.write("completed\n");
});
