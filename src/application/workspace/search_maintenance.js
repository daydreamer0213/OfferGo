const crypto = require("node:crypto");
const { listWorkflowRuns } = require("../../storage/workflow_store");
const { acquireSiteScanLease, renewSiteScanLease, releaseSiteScanLease } = require("../../storage/scan_store");
const { withSiteScanLease } = require("../../core/scan_execution");

async function withBossSearchMaintenance(db, operation) {
  const hasBoundWorkflow = () => listWorkflowRuns(db, { site: "boss", limit: 1,
    statuses: ["created", "scanning", "analyzing", "communicating", "paused", "interrupted"] }).length > 0;
  if (hasBoundWorkflow()) return null;
  try {
    return await withSiteScanLease({
      acquire: input => acquireSiteScanLease(db, input),
      renew: input => renewSiteScanLease(db, input),
      release: input => releaseSiteScanLease(db, input)
    }, { site: "boss", owner: crypto.randomUUID(), command: "workspace_search" }, signal => {
      if (hasBoundWorkflow()) return null;
      return operation(signal);
    });
  } catch (error) {
    if (error.code === "SCAN_ALREADY_RUNNING") return null;
    throw error;
  }
}

module.exports = { withBossSearchMaintenance };
