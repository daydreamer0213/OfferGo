const fs = require("node:fs");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", async () => {
  const startedAt = Date.now();
  const request = JSON.parse(raw);
  const delayMs = Number(process.env.FAKE_AGENT_DELAY_MS || 0);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const mode = process.env.FAKE_AGENT_MODE || "success";
  const auditPath = process.env.FAKE_AGENT_AUDIT || "";
  if (auditPath) {
    fs.appendFileSync(auditPath, `${JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      taskKind: request.taskKind,
      startedAt,
      endedAt: Date.now()
    })}\n`);
  }
  if (mode === "invalid_json") return process.stdout.write("not-json");
  if (mode === "oversize") return process.stdout.write("x".repeat(Number(request.limits?.maxOutputBytes || 64) + 128));
  if (mode === "exit") return process.exit(17);
  if (mode === "mismatch") {
    return process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      requestId: "wrong-request-id",
      ok: true,
      result: { accepted: true }
    }));
  }
  if (mode === "auth") {
    return process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: false,
      error: { code: "MODEL_AGENT_AUTH_REQUIRED", message: "请登录 Agent。", retryable: false }
    }));
  }
  process.stdout.write(JSON.stringify({
    protocolVersion: 1,
    requestId: request.requestId,
    ok: true,
    result: { accepted: true, taskKind: request.taskKind },
    identity: { runner: "fixture", model: "fixture-model", runnerVersion: "1.0.0" }
  }));
});
