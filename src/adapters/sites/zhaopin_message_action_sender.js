const VERIFY_ATTEMPTS = 3;
const VERIFY_INTERVAL_MS = 250;

function createZhaopinMessageActionSender({ browser, reader, sleepFn = sleep } = {}) {
  assertDependencies(browser, reader);
  const inspections = new WeakMap();
  const preparations = new WeakMap();
  return { inspectTarget, prepareAction, dispatchAction, verifyActionResult, clearPreparedAction };

  async function inspectTarget(rawItem, signal) {
    const item = normalizeItem(rawItem);
    throwIfAborted(signal);
    const scan = await reader.scanConversationRows(signal);
    const matches = scan.rows.filter((row) => row.identityVerified === true && row.conversationKey === item.conversationKey);
    if (matches.length !== 1) throw targetMismatch();
    const selected = await reader.openQueuedConversation({ ...matches[0], tabId: scan.tabId }, signal);
    assertSelected(selected, item);
    const token = Object.freeze({ kind: "zhaopin_message_action_inspection" });
    inspections.set(token, { item, tabId: scan.tabId, selected, used: false });
    return token;
  }

  async function prepareAction(inspection, signal) {
    const inspected = inspections.get(inspection);
    if (!inspected || inspected.used) throw senderError("ZHAOPIN_MESSAGE_ACTION_INSPECTION_INVALID", "message action inspection is invalid or already used");
    await verifySelected(inspected, signal);
    const probe = normalizeProbe(await browser.evalValue(inspected.tabId, actionExpression("prepare", inspected.item)));
    if (probe.state !== "ready" || probe.sourceMessageId !== inspected.item.evidence.sourceMessageId
      || !probe.point || !Number.isFinite(probe.point.x) || !Number.isFinite(probe.point.y)) throw probeError(probe.state);
    inspected.used = true;
    const token = Object.freeze({ kind: "zhaopin_message_action_preparation" });
    preparations.set(token, { ...inspected, point: probe.point, state: "verified", result: null });
    return token;
  }

  async function dispatchAction(preparation, signal) {
    const prepared = requirePreparation(preparation);
    if (prepared.state !== "verified") throw senderError("ZHAOPIN_MESSAGE_ACTION_ALREADY_DISPATCHED", "message action click was already dispatched");
    await verifySelected(prepared, signal);
    prepared.state = "dispatched";
    try { await browser.clickAt(prepared.tabId, prepared.point); }
    catch (cause) { throw Object.assign(senderError("ZHAOPIN_MESSAGE_ACTION_CLICK_AMBIGUOUS", "message action click outcome is ambiguous"), { cause }); }
    return preparation;
  }

  async function verifyActionResult(preparation, signal) {
    const prepared = requirePreparation(preparation);
    if (prepared.result) return prepared.result;
    if (prepared.state !== "dispatched") throw senderError("ZHAOPIN_MESSAGE_ACTION_NOT_DISPATCHED", "message action was not dispatched");
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt) await sleepFn(VERIFY_INTERVAL_MS, signal);
      try {
        await reader.assertActiveBindings(signal);
        const selected = await reader.readSelectedConversation(prepared.selected, signal);
        if (selected?.conversationKey !== prepared.item.conversationKey) return freezeResult(prepared, "target_mismatch", "target_mismatch");
        const probe = normalizeProbe(await browser.evalValue(prepared.tabId, actionExpression("verify", prepared.item)));
        if (probe.state === "succeeded" && probe.sourceMessageId === prepared.item.evidence.sourceMessageId) {
          prepared.result = Object.freeze({ state: "succeeded", evidence: Object.freeze({ verification: "action_card_resolved", sourceMessageId: probe.sourceMessageId }) });
          return prepared.result;
        }
        if (probe.state === "target_mismatch") return freezeResult(prepared, "target_mismatch", "target_mismatch");
        if (probe.state === "platform_rejected") return freezeResult(prepared, "platform_rejected", "platform_rejected");
      } catch (error) {
        if (["ZHAOPIN_MESSAGE_TARGET_MISMATCH", "ZHAOPIN_MESSAGE_TARGET_INVALID"].includes(error?.code)) return freezeResult(prepared, "target_mismatch", "target_mismatch");
        throw error;
      }
    }
    return freezeResult(prepared, "ambiguous", "action_card_outcome_unverified");
  }

  async function clearPreparedAction(preparation) {
    const prepared = requirePreparation(preparation);
    if (prepared.state !== "verified") return { cleared: false };
    prepared.state = "cleared";
    return { cleared: true };
  }

  async function verifySelected(context, signal) {
    throwIfAborted(signal);
    await reader.assertActiveBindings(signal);
    const selected = await reader.readSelectedConversation(context.selected, signal);
    assertSelected(selected, context.item);
    return selected;
  }

  function requirePreparation(token) {
    const prepared = preparations.get(token);
    if (!prepared) throw senderError("ZHAOPIN_MESSAGE_ACTION_PREPARATION_INVALID", "message action preparation is invalid");
    return prepared;
  }
}

function normalizeItem(value) {
  const item = {
    platform: String(value?.platform || ""), conversationKey: String(value?.conversationKey || ""),
    messageKey: String(value?.messageKey || ""), actionKind: String(value?.actionKind || ""),
    evidence: value?.evidence && typeof value.evidence === "object" ? value.evidence : {}
  };
  if (item.platform !== "zhaopin" || !/^sha256:[a-f0-9]{64}$/.test(item.conversationKey)
    || !/^sha256:[a-f0-9]{64}$/.test(item.messageKey)
    || !["resume_request_accept", "resume_request_decline"].includes(item.actionKind)
    || !/^\d{1,32}$/.test(String(item.evidence.sourceMessageId || "")) || String(item.evidence.cardType || "") !== "11") throw targetMismatch();
  return item;
}

function assertSelected(snapshot, item) {
  const exact = snapshot?.messages?.filter((message) => message.messageKey === item.messageKey
    && String(message.messageId || "") === String(item.evidence.sourceMessageId)
    && message.direction === "friend" && message.contentKind === "resume_request"
    && String(message.metadata?.cardType || "") === "11") || [];
  if (snapshot?.conversationKey !== item.conversationKey || exact.length !== 1) throw targetMismatch();
}

function actionExpression(phase, item) {
  const expected = JSON.stringify({ sourceMessageId: String(item.evidence.sourceMessageId), actionKind: item.actionKind });
  const mode = JSON.stringify(phase);
  return `(()=>{const operation="zhaopin_action_${phase}";const expected=${expected};const main=document.querySelector(".im-main-panel");const vm=main?.__vue__;if(vm?.$options?.name!=="MainPanelThreeColumns")return {state:"target_mismatch"};const source=(Array.isArray(vm.activeTimeline)?vm.activeTimeline:[]).filter(m=>String(m?.idServer||"")===expected.sourceMessageId&&String(m?.cardType||"")==="11");if(source.length!==1)return {state:${mode}==="verify"?"still_actionable":"target_mismatch",sourceMessageId:expected.sourceMessageId};const cards=[...document.querySelectorAll(".im-message.im-message--custom")].filter(el=>{const c=el.__vue__;const msg=c?.$props?.msg||c?.msg||c?.message||c?.$parent?.$props?.msg;return String(msg?.idServer||"")===expected.sourceMessageId;});if(cards.length!==1)return {state:${mode}==="verify"?"still_actionable":"target_mismatch",sourceMessageId:expected.sourceMessageId};const selector=expected.actionKind==="resume_request_accept"?".im-msg-11__btn--agree":".im-msg-11__btn--refuse";const buttons=[...cards[0].querySelectorAll(selector)].filter(el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"});const enabled=buttons.filter(el=>!el.disabled&&el.getAttribute("aria-disabled")!=="true");if(${mode}==="verify")return {state:buttons.length===1&&enabled.length===0?"succeeded":"still_actionable",sourceMessageId:expected.sourceMessageId};if(enabled.length!==1)return {state:"action_unavailable",sourceMessageId:expected.sourceMessageId};const r=enabled[0].getBoundingClientRect();return {state:"ready",sourceMessageId:expected.sourceMessageId,point:{x:r.left+r.width/2,y:r.top+r.height/2}};})()`;
}

function freezeResult(prepared, state, verification) { prepared.result = Object.freeze({ state, evidence: Object.freeze({ verification }) }); return prepared.result; }
function normalizeProbe(value) { if (!value || typeof value !== "object" || typeof value.state !== "string") throw senderError("ZHAOPIN_MESSAGE_ACTION_PROBE_INVALID", "message action page probe returned an invalid result"); return value; }
function probeError(state) { const code = state === "target_mismatch" ? "ZHAOPIN_MESSAGE_ACTION_TARGET_MISMATCH" : state === "action_unavailable" ? "ZHAOPIN_MESSAGE_ACTION_UNAVAILABLE" : "ZHAOPIN_MESSAGE_ACTION_PROBE_INVALID"; return senderError(code, "message action page verification stopped"); }
function targetMismatch() { return senderError("ZHAOPIN_MESSAGE_ACTION_TARGET_MISMATCH", "confirmed message action does not match the current Zhaopin conversation"); }
function assertDependencies(browser, reader) { for (const name of ["evalValue", "clickAt"]) if (typeof browser?.[name] !== "function") throw new TypeError(`browser.${name} is required`); for (const name of ["scanConversationRows", "openQueuedConversation", "readSelectedConversation", "assertActiveBindings"]) if (typeof reader?.[name] !== "function") throw new TypeError(`reader.${name} is required`); }
function senderError(code, message) { return Object.assign(new Error(message), { code }); }
function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason || senderError("MESSAGE_ACTION_STOPPED", "message action stopped"); }
function sleep(ms, signal) { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || senderError("MESSAGE_ACTION_STOPPED", "message action stopped")); }, { once: true }); }); }

module.exports = { createZhaopinMessageActionSender };
