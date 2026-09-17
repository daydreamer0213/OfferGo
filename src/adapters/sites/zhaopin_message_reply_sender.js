const crypto = require("node:crypto");

const VERIFY_ATTEMPTS = 3;
const VERIFY_INTERVAL_MS = 250;
const EDITOR_SELECTOR = ".im-sender__input";
const SEND_SELECTOR = ".im-sender__send-btn";

function createZhaopinMessageReplySender({ browser, reader, sleepFn = sleep } = {}) {
  assertDependencies(browser, reader);
  const inspections = new WeakMap();
  const preparations = new WeakMap();

  return { inspectReplyTarget, fillReply, dispatchReply, verifyReplyResult, clearPreparedReply };

  async function inspectReplyTarget(rawItem, signal) {
    const item = normalizeFrozenItem(rawItem);
    throwIfAborted(signal);
    const scan = await reader.scanConversationRows();
    const matches = scan.rows.filter((row) => row.identityVerified === true
      && row.conversationKey === item.conversationKey
      && row.sourceJobId === item.sourceJobId);
    if (matches.length !== 1) throw targetMismatch();
    const selected = await reader.openQueuedConversation({ ...matches[0], tabId: scan.tabId }, signal);
    assertSelectedSnapshot(selected, item);
    const selectedJob = await reader.readSelectedJobTarget(selected, signal);
    if (`zhaopin:${selectedJob.jobId}` !== item.sourceJobId) throw targetMismatch();
    const token = Object.freeze({ kind: "zhaopin_message_reply_inspection" });
    inspections.set(token, { item, tabId: scan.tabId, selected, used: false });
    return token;
  }

  async function fillReply(inspection, replyText, signal) {
    const inspected = inspections.get(inspection);
    if (!inspected || inspected.used) throw senderError("ZHAOPIN_MESSAGE_REPLY_INSPECTION_INVALID", "reply inspection is invalid or already used");
    const exactText = normalizedReplyText(replyText);
    if (exactText !== inspected.item.replyText || replyDigest(exactText) !== inspected.item.replyDigest) {
      throw senderError("ZHAOPIN_MESSAGE_REPLY_TEXT_MISMATCH", "reply text differs from the confirmed batch snapshot");
    }
    await verifySelected(inspected, signal);
    const preflight = normalizeProbe(await browser.evalValue(inspected.tabId, editorExpression("preflight", inspected.item)));
    assertReadyProbe(preflight);
    if (preflight.editorCount !== 1 || foldWhitespace(preflight.editorText)) {
      throw senderError("ZHAOPIN_MESSAGE_REPLY_EDITOR_NOT_EMPTY", "reply editor is unavailable or already contains text");
    }
    let inserted = false;
    try {
      const focus = normalizeProbe(await browser.evalValue(inspected.tabId, editorExpression("focus", inspected.item)));
      assertReadyProbe(focus);
      if (!focus.focused) throw senderError("ZHAOPIN_MESSAGE_REPLY_EDITOR_INVALID", "reply editor could not be focused safely");
      throwIfAborted(signal);
      await browser.cdp(inspected.tabId, "Input.insertText", { text: exactText });
      inserted = true;
      const readback = normalizeProbe(await browser.evalValue(inspected.tabId, editorExpression("readback", inspected.item)));
      assertReadyProbe(readback);
      if (replyDigest(readback.editorText) !== inspected.item.replyDigest) {
        throw senderError("ZHAOPIN_MESSAGE_REPLY_READBACK_MISMATCH", "reply editor read-back did not match the confirmed text");
      }
    } catch (error) {
      if (inserted) await clearOwnedEditor(inspected.tabId, inspected.item).catch(() => {});
      throw error;
    }
    inspected.used = true;
    const token = Object.freeze({ kind: "zhaopin_message_reply_preparation" });
    preparations.set(token, { ...inspected, state: "filled", result: null });
    return token;
  }

  async function dispatchReply(preparation, signal) {
    const prepared = requirePreparation(preparation);
    if (prepared.state !== "filled") throw senderError("ZHAOPIN_MESSAGE_REPLY_ALREADY_DISPATCHED", "reply send click was already dispatched");
    await verifySelected(prepared, signal);
    const guard = normalizeProbe(await browser.evalValue(prepared.tabId, dispatchExpression(prepared.item)));
    assertReadyProbe(guard);
    if (!guard.point || !Number.isFinite(guard.point.x) || !Number.isFinite(guard.point.y)) {
      throw senderError("ZHAOPIN_MESSAGE_REPLY_SEND_BUTTON_INVALID", "reply send button is unavailable");
    }
    prepared.state = "dispatched";
    try { await browser.clickAt(prepared.tabId, guard.point); }
    catch (cause) { throw Object.assign(senderError("ZHAOPIN_MESSAGE_REPLY_CLICK_AMBIGUOUS", "reply send click outcome is ambiguous"), { cause }); }
    return preparation;
  }

  async function verifyReplyResult(preparation, signal) {
    const prepared = requirePreparation(preparation);
    if (prepared.result) return prepared.result;
    if (prepared.state !== "dispatched") throw senderError("ZHAOPIN_MESSAGE_REPLY_NOT_DISPATCHED", "reply send click was not dispatched");
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt) await sleepFn(VERIFY_INTERVAL_MS, signal);
      try {
        const selected = await verifySelected(prepared, signal);
        const exact = selected.messages.filter((message) => message.direction === "myself"
          && message.contentKind === "text"
          && message.messageId
          && !prepared.item.priorMessageIds.has(String(message.messageId))
          && replyDigest(message.text) === prepared.item.replyDigest);
        if (exact.length === 1) {
          prepared.result = Object.freeze({ state: "succeeded", evidence: Object.freeze({ verification: "new_outgoing_message", outgoingMessageId: String(exact[0].messageId), replyDigest: prepared.item.replyDigest }) });
          return prepared.result;
        }
      } catch (error) {
        if (["ZHAOPIN_MESSAGE_TARGET_MISMATCH", "ZHAOPIN_MESSAGE_TARGET_INVALID"].includes(error?.code)) {
          prepared.result = Object.freeze({ state: "target_mismatch", evidence: { verification: "target_mismatch" } });
          return prepared.result;
        }
        throw error;
      }
    }
    prepared.result = Object.freeze({ state: "ambiguous", evidence: { verification: "outgoing_message_unverified" } });
    return prepared.result;
  }

  async function clearPreparedReply(preparation) {
    const prepared = requirePreparation(preparation);
    if (prepared.state === "cleared") return { cleared: true };
    if (prepared.state !== "filled") return { cleared: false };
    const result = await clearOwnedEditor(prepared.tabId, prepared.item);
    if (result.state === "cleared") prepared.state = "cleared";
    return { cleared: prepared.state === "cleared" };
  }

  async function verifySelected(context, signal) {
    throwIfAborted(signal);
    await reader.assertActiveBindings(signal);
    const selected = await reader.readSelectedConversation(context.selected, signal);
    assertSelectedSnapshot(selected, context.item, { allowOutgoing: context.state === "dispatched" });
    return selected;
  }

  async function clearOwnedEditor(tabId, item) {
    return normalizeProbe(await browser.evalValue(tabId, editorExpression("clear", item)));
  }

  function requirePreparation(token) {
    const prepared = preparations.get(token);
    if (!prepared) throw senderError("ZHAOPIN_MESSAGE_REPLY_PREPARATION_INVALID", "reply preparation is invalid");
    return prepared;
  }
}

function normalizeFrozenItem(value) {
  const replyText = normalizedReplyText(value?.replyText);
  const item = { conversationKey: String(value?.conversationKey || ""), sourceJobId: String(value?.sourceJobId || ""), expectedLastMessageId: String(value?.expectedLastMessageId || ""), replyText, replyDigest: String(value?.replyDigest || "") };
  if (!/^sha256:[a-f0-9]{64}$/.test(item.conversationKey) || !/^zhaopin:[A-Za-z0-9]{1,160}$/.test(item.sourceJobId)
    || !/^\d{1,32}$/.test(item.expectedLastMessageId) || !/^sha256:[a-f0-9]{64}$/.test(item.replyDigest)
    || replyDigest(replyText) !== item.replyDigest) throw targetMismatch();
  return item;
}

function assertSelectedSnapshot(snapshot, item, { allowOutgoing = false } = {}) {
  const friend = snapshot?.messages?.filter((message) => message.direction === "friend") || [];
  if (!snapshot || snapshot.conversationKey !== item.conversationKey || snapshot.sourceJobId !== item.sourceJobId
    || friend.at(-1)?.messageId !== item.expectedLastMessageId || (!allowOutgoing && snapshot.lastMessageId !== item.expectedLastMessageId)) throw targetMismatch();
  item.priorMessageIds ||= new Set(snapshot.messages.map((message) => String(message.messageId || "")).filter(Boolean));
}

function pageGuard(item) {
  return `const expected=${JSON.stringify({ jobNumber: item.sourceJobId.slice("zhaopin:".length), lastMessageId: item.expectedLastMessageId, replyText: item.replyText })};const main=document.querySelector(".im-main-panel");const vm=main?.__vue__;if(vm?.$options?.name!=="MainPanelThreeColumns"||String(vm.activeSession?.jobNumber||"")!==expected.jobNumber)return {state:"target_mismatch"};const incoming=(Array.isArray(vm.activeTimeline)?vm.activeTimeline:[]).filter(m=>m?.flow==="in"&&m?.fromMe===false);if(String(incoming.at(-1)?.idServer||"")!==expected.lastMessageId)return {state:"target_mismatch"};`;
}

function editorExpression(phase, item) {
  return `(()=>{${pageGuard(item)}const operation="zhaopin_reply_${phase}";const editors=[...document.querySelectorAll("${EDITOR_SELECTOR}")];if(editors.length!==1)return {state:"editor_invalid",editorCount:editors.length};const editor=editors[0];const read=()=>String("value" in editor?editor.value:(editor.innerText||editor.textContent||""));if(${JSON.stringify(phase)}==="preflight")return {state:"ready",editorCount:1,editorText:read()};if(${JSON.stringify(phase)}==="focus"){if(read().trim())return {state:"editor_not_empty"};editor.focus({preventScroll:true});return {state:"ready",focused:document.activeElement===editor};}if(${JSON.stringify(phase)}==="readback")return {state:"ready",editorText:read()};if(read().replace(/\\s+/g," ").trim()!==expected.replyText.replace(/\\s+/g," ").trim())return {state:"not_owned"};if("value" in editor)editor.value="";else editor.textContent="";editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"deleteContentBackward",data:null}));editor.dispatchEvent(new Event("change",{bubbles:true}));return {state:read().trim()?"not_owned":"cleared"};})()`;
}

function dispatchExpression(item) {
  return `(()=>{${pageGuard(item)}const editor=document.querySelector("${EDITOR_SELECTOR}");const read=String(editor&&("value" in editor?editor.value:(editor.innerText||editor.textContent||"")));if(read.replace(/\\s+/g," ").trim()!==expected.replyText.replace(/\\s+/g," ").trim())return {state:"text_mismatch"};const buttons=[...document.querySelectorAll("${SEND_SELECTOR}")].filter(el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"});if(buttons.length!==1||buttons[0].disabled||buttons[0].getAttribute("aria-disabled")==="true")return {state:"send_button_invalid"};const r=buttons[0].getBoundingClientRect();return {state:"ready",point:{x:r.left+r.width/2,y:r.top+r.height/2}};})()`;
}

function normalizeProbe(value) { if (!value || typeof value !== "object" || typeof value.state !== "string") throw senderError("ZHAOPIN_MESSAGE_REPLY_PROBE_INVALID", "reply page probe returned an invalid result"); return value; }
function assertReadyProbe(probe) { if (probe.state === "ready") return; const code = ({ target_mismatch: "ZHAOPIN_MESSAGE_REPLY_TARGET_MISMATCH", editor_invalid: "ZHAOPIN_MESSAGE_REPLY_EDITOR_INVALID", editor_not_empty: "ZHAOPIN_MESSAGE_REPLY_EDITOR_NOT_EMPTY", text_mismatch: "ZHAOPIN_MESSAGE_REPLY_READBACK_MISMATCH", send_button_invalid: "ZHAOPIN_MESSAGE_REPLY_SEND_BUTTON_INVALID" })[probe.state] || "ZHAOPIN_MESSAGE_REPLY_PROBE_INVALID"; throw senderError(code, "reply page verification stopped"); }
function assertDependencies(browser, reader) { for (const name of ["evalValue", "cdp", "clickAt"]) if (typeof browser?.[name] !== "function") throw new TypeError(`browser.${name} is required`); for (const name of ["scanConversationRows", "openQueuedConversation", "readSelectedJobTarget", "readSelectedConversation", "assertActiveBindings"]) if (typeof reader?.[name] !== "function") throw new TypeError(`reader.${name} is required`); }
function normalizedReplyText(value) { const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim(); if (!text || text.length > 4000) throw senderError("ZHAOPIN_MESSAGE_REPLY_TEXT_INVALID", "reply text is invalid"); return text; }
function foldWhitespace(value) { return String(value == null ? "" : value).replace(/\s+/g, " ").trim(); }
function replyDigest(value) { return `sha256:${crypto.createHash("sha256").update(foldWhitespace(value)).digest("hex")}`; }
function targetMismatch() { return senderError("ZHAOPIN_MESSAGE_REPLY_TARGET_MISMATCH", "confirmed reply target does not match the current Zhaopin conversation"); }
function senderError(code, message) { return Object.assign(new Error(message), { code }); }
function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason || senderError("MESSAGE_REPLY_SEND_STOPPED", "message reply send stopped"); }
function sleep(ms, signal) { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || senderError("MESSAGE_REPLY_SEND_STOPPED", "message reply send stopped")); }, { once: true }); }); }

module.exports = { createZhaopinMessageReplySender };
