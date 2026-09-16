const assert = require("node:assert/strict");
const { openDb, saveProfileAnalysis, createWorkflowRun, createScanRun } = require("../src/core/storage");
const { listWorkflowStateInvariantViolations } = require("../src/storage/workflow_store");

const db = openDb(":memory:");
try {
  const saved = saveProfileAnalysis(db, {
    profile: { candidate: { name: "Invariant Candidate" }, education: [], experiences: [], skills: [], projects: [], credentials: [], strengths: [] },
    document: { originalFileName: "resume.txt", format: "text", contentHash: "invariant-resume", text: "resume", diagnostics: {} },
    searchPlan: { name: "Invariant Plan", platform: { site: "boss" }, keywords: [] }
  });
  const completedChild = createWorkflowRun(db, {
    id: "workflow-completed-child", profileId: saved.profileId, planId: saved.planId,
    localDay: "2030-01-01", sequence: 1, status: "created"
  });
  createScanRun(db, { runId: "scan-completed-child", site: "boss", planId: saved.planId });
  db.prepare("UPDATE scan_runs SET status = 'completed', finished_at = ? WHERE id = ?")
    .run("2030-01-01T00:01:00.000Z", "scan-completed-child");
  db.prepare("UPDATE workflow_runs SET status = 'scanning', scan_run_id = ? WHERE id = ?")
    .run("scan-completed-child", completedChild.id);

  const runningChild = createWorkflowRun(db, {
    id: "workflow-running-child", profileId: saved.profileId, planId: saved.planId,
    localDay: "2030-01-01", sequence: 2, status: "created"
  });
  createScanRun(db, { runId: "scan-running-child", site: "boss", planId: saved.planId });
  db.prepare("UPDATE scan_runs SET status = 'running', heartbeat_at = ? WHERE id = ?")
    .run("2030-01-01T00:02:00.000Z", "scan-running-child");
  db.prepare("UPDATE workflow_runs SET status = 'completed', scan_run_id = ?, finished_at = ? WHERE id = ?")
    .run("scan-running-child", "2030-01-01T00:02:00.000Z", runningChild.id);

  const violations = listWorkflowStateInvariantViolations(db, [completedChild.id, runningChild.id]);
  assert.deepEqual(violations.map((item) => item.reason), [
    "scan_parent_child_status_mismatch",
    "scan_parent_child_status_mismatch"
  ]);
  assert.deepEqual(listWorkflowStateInvariantViolations(db, []), []);
  console.log("workflow_state_invariants_smoke: ok");
} finally {
  db.close();
}
