const { randomUUID } = require("node:crypto");
const { createPlatformMessageReader, createPlatformMessageActionSender } = require("../composition/message_action_factories");
const { createMessageActionService } = require("../application/message_actions");
const { acquireSiteScanLease, getSiteScanLease, renewSiteScanLease, releaseSiteScanLease } = require("../core/storage");

function createMessageActionController({
  db,
  browserFactory,
  logger = null,
  now = () => new Date(),
  cleanupBrowser = defaultCleanupBrowser,
  createReader = createPlatformMessageReader,
  createSender = createPlatformMessageActionSender,
  acquireLease = acquireSiteScanLease,
  getLease = getSiteScanLease,
  renewLease = renewSiteScanLease,
  releaseLease = releaseSiteScanLease,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  leaseHeartbeatMs = 30_000
} = {}) {
  if (!db) throw new TypeError("message action controller requires db");
  if (typeof browserFactory !== "function") throw new TypeError("message action controller requires browserFactory");
  const service = createMessageActionService({ db, now });
  const activeRuns = new Map();
  const scheduled = new Set();
  let closing = false;
  reconcileHistorical();
  return { confirm, status, list, stop, close };

  function confirm(input = {}) {
    if (closing) throw controllerError("MESSAGE_ACTION_CONTROLLER_CLOSING", "消息操作服务正在关闭。");
    const profileId = positiveInteger(input.profileId, "profileId");
    const repeated = service.list({ profileId }).find((item) => item.idempotencyKey === String(input.idempotencyKey || "").trim().toLowerCase());
    if (repeated) return service.confirm({ ...input, profileId });
    if (activeRuns.has(profileId) || service.active({ profileId }).length) {
      throw controllerError("MESSAGE_ACTION_PROFILE_BUSY", "当前已有一项消息操作正在执行。");
    }
    const platform = String(input.platform || "");
    if (getLease(db, platform)) throw controllerError("MESSAGE_ACTION_LEASE_BUSY", "招聘平台正在执行其他任务，请稍后再试。");
    const action = service.confirm({ ...input, profileId });
    if (action.status === "confirmed" && !scheduled.has(action.id)) {
      scheduled.add(action.id);
      Promise.resolve().then(() => execute(action.id, profileId)).catch((error) => {
        logger?.warn("message_action_execution_failed", { actionId: action.id, errorCode: safeCode(error) });
      });
    }
    return action;
  }

  function status(input = {}) { return service.status({ profileId: positiveInteger(input.profileId, "profileId"), actionId: positiveInteger(input.actionId, "actionId") }); }
  function list(input = {}) { return service.list({ profileId: positiveInteger(input.profileId, "profileId") }); }

  function stop(input = {}) {
    const current = status(input);
    if (["succeeded", "target_mismatch", "platform_rejected", "ambiguous", "stopped"].includes(current.status)) return current;
    const run = activeRuns.get(current.profileId);
    if (run?.actionId === current.id && !run.abortController.signal.aborted) run.abortController.abort(controllerError("MESSAGE_ACTION_STOPPED", "用户已停止消息操作。"));
    if (current.status === "click_dispatched") return service.transition({ profileId: current.profileId, actionId: current.id, expectedStatus: current.status, status: "ambiguous", clickCount: 1, errorCode: "MESSAGE_ACTION_STOPPED_AFTER_CLICK" });
    return service.transition({ profileId: current.profileId, actionId: current.id, expectedStatus: current.status, status: "stopped", clickCount: 0, errorCode: "MESSAGE_ACTION_STOPPED" });
  }

  function close() {
    closing = true;
    for (const run of activeRuns.values()) if (!run.abortController.signal.aborted) run.abortController.abort(controllerError("MESSAGE_ACTION_SERVER_CLOSING", "消息操作服务正在关闭。"));
    return Promise.allSettled([...activeRuns.values()].map((run) => run.completion)).then(() => undefined);
  }

  function reconcileHistorical() {
    for (const action of service.active()) {
      if (action.status === "click_dispatched") {
        service.transition({ profileId: action.profileId, actionId: action.id, expectedStatus: action.status, status: "ambiguous", clickCount: 1, errorCode: "MESSAGE_ACTION_STALE_CLICK" });
      } else {
        service.transition({ profileId: action.profileId, actionId: action.id, expectedStatus: action.status, status: "stopped", clickCount: 0, errorCode: "MESSAGE_ACTION_STALE_RUN" });
      }
    }
  }

  async function execute(actionId, profileId) {
    scheduled.delete(actionId);
    const initial = service.status({ profileId, actionId });
    if (initial.status !== "confirmed") return initial;
    const abortController = new AbortController();
    const owner = randomUUID();
    const run = { actionId, profileId, abortController, completion: null };
    activeRuns.set(profileId, run);
    let browser = null;
    let heartbeat = null;
    let leaseAcquired = false;
    let current = initial;
    run.completion = Promise.resolve().then(async () => {
      acquireLease(db, { site: current.platform, owner, command: "message-action", planId: null });
      leaseAcquired = true;
      heartbeat = setIntervalFn(() => {
        try { renewLease(db, { site: current.platform, owner }); }
        catch { abortController.abort(controllerError("MESSAGE_ACTION_LEASE_LOST", "消息操作控制权已丢失。")); }
      }, Math.max(1000, Number(leaseHeartbeatMs) || 30_000));
      current = service.transition({ profileId, actionId, expectedStatus: "confirmed", status: "selecting", clickCount: 0 });
      browser = await browserFactory();
      const reader = createReader({ browser, platform: current.platform, action: current });
      const sender = createSender({ browser, reader, platform: current.platform, action: current });
      const inspection = await sender.inspectTarget(current, abortController.signal);
      const prepared = await sender.prepareAction(inspection, abortController.signal);
      current = service.transition({ profileId, actionId, expectedStatus: "selecting", status: "verified", clickCount: 0 });
      current = service.transition({ profileId, actionId, expectedStatus: "verified", status: "click_dispatched", clickCount: 1 });
      await sender.dispatchAction(prepared, abortController.signal);
      const result = await sender.verifyActionResult(prepared, abortController.signal);
      if (result.state === "succeeded") return service.completeVerified({ profileId, actionId, evidence: result.evidence });
      if (["target_mismatch", "platform_rejected", "ambiguous"].includes(result.state)) {
        return service.transition({ profileId, actionId, expectedStatus: "click_dispatched", status: result.state, clickCount: 1, evidence: result.evidence, errorCode: `MESSAGE_ACTION_${result.state.toUpperCase()}` });
      }
      return service.transition({ profileId, actionId, expectedStatus: "click_dispatched", status: "ambiguous", clickCount: 1, errorCode: "MESSAGE_ACTION_RESULT_UNKNOWN" });
    }).catch((error) => {
      try {
        current = service.status({ profileId, actionId });
        if (current.status === "click_dispatched") return service.transition({ profileId, actionId, expectedStatus: current.status, status: "ambiguous", clickCount: 1, errorCode: safeCode(error) });
        if (["confirmed", "selecting", "verified"].includes(current.status)) {
          const mismatch = /TARGET_MISMATCH/.test(String(error?.code || ""));
          return service.transition({ profileId, actionId, expectedStatus: current.status, status: mismatch ? "target_mismatch" : "stopped", clickCount: 0, errorCode: safeCode(error) });
        }
      } catch {}
      throw error;
    }).finally(async () => {
      if (heartbeat !== null) clearIntervalFn(heartbeat);
      try { await cleanupBrowser(browser); } catch {}
      if (leaseAcquired) { try { releaseLease(db, { site: current.platform, owner }); } catch {} }
      if (activeRuns.get(profileId) === run) activeRuns.delete(profileId);
    });
    return run.completion;
  }
}

async function defaultCleanupBrowser(browser) { if (browser && typeof browser.disconnect === "function") await browser.disconnect(); else if (browser && typeof browser.cleanup === "function") await browser.cleanup(); }
function positiveInteger(value, name) { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw controllerError("MESSAGE_ACTION_INPUT_INVALID", `${name} must be a positive integer`); return n; }
function safeCode(error) { const code = String(error?.code || "MESSAGE_ACTION_FAILED"); return /^[A-Z0-9_]{1,100}$/.test(code) ? code : "MESSAGE_ACTION_FAILED"; }
function controllerError(code, message) { return Object.assign(new Error(message), { code }); }

module.exports = { createMessageActionController };
