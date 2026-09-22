const { createHash } = require("node:crypto");
const { isInPlatformResumeRequest } = require("../../core/message_requested_actions");

const VERIFY_ATTEMPTS = 5;
const VERIFY_INTERVAL_MS = 400;

function createBossMessageActionSender({ browser, reader, sleepFn = sleep } = {}) {
  assertDependencies(browser, reader);
  const inspections = new WeakMap();
  const preparations = new WeakMap();
  return { inspectTarget, prepareAction, dispatchAction, verifyActionResult, clearPreparedAction };

  async function inspectTarget(rawItem, signal) {
    const item = normalizeItem(rawItem);
    throwIfAborted(signal);
    const scan = await reader.scanConversationRows(signal, { requiredConversationKeys: [item.conversationKey] });
    const matches = scan.rows.filter((row) => row.identityVerified === true && row.conversationKey === item.conversationKey);
    if (matches.length !== 1) throw targetMismatch();
    const selected = await reader.openQueuedConversation({
      ...matches[0],
      tabId: scan.tabId,
      operation: "authorized_reply"
    }, signal);
    assertSelected(selected, item);
    const token = Object.freeze({ kind: "boss_message_action_inspection" });
    inspections.set(token, { item, tabId: scan.tabId, selected, used: false });
    return token;
  }

  async function prepareAction(inspection, signal) {
    const inspected = inspections.get(inspection);
    if (!inspected || inspected.used) throw senderError("BOSS_MESSAGE_ACTION_INSPECTION_INVALID", "message action inspection is invalid or already used");
    const before = await verifySelected(inspected, signal);
    const toolbar = normalizeProbe(await browser.evalValue(inspected.tabId, toolbarExpression(inspected.item)));
    if (toolbar.state !== "ready" || toolbar.sourceMessageId !== inspected.item.evidence.sourceMessageId) throw probeError(toolbar.state);
    await browser.clickAt(inspected.tabId, toolbar.point);
    try {
      await sleepFn(300, signal);
      await verifySelected(inspected, signal);
    } catch (error) {
      await closeChooser(inspected.tabId);
      throw error;
    }
    const choice = normalizeProbe(await browser.evalValue(inspected.tabId, choiceExpression()));
    if (choice.state !== "ready" || choice.resumeKind !== "latest_attachment") {
      await closeChooser(inspected.tabId);
      throw probeError(choice.state);
    }
    const resume = normalizeResumeChoice(choice);
    inspected.used = true;
    const token = Object.freeze({ kind: "boss_message_action_preparation" });
    preparations.set(token, {
      ...inspected,
      resumeKind: choice.resumeKind,
      resumeFingerprint: resume.fingerprint,
      resumeUpdatedAt: resume.updatedAt,
      beforeMessageIds: new Set((before.messages || []).map((message) => String(message.messageId || ""))),
      state: "verified",
      result: null
    });
    return token;
  }

  async function dispatchAction(preparation, signal) {
    const prepared = requirePreparation(preparation);
    if (prepared.state !== "verified") throw senderError("BOSS_MESSAGE_ACTION_ALREADY_DISPATCHED", "message action was already dispatched");
    await verifySelected(prepared, signal);
    const choice = normalizeProbe(await browser.evalValue(prepared.tabId, choiceExpression()));
    if (choice.state !== "ready" || choice.resumeKind !== prepared.resumeKind) {
      await closeChooser(prepared.tabId);
      throw probeError(choice.state);
    }
    const currentResume = normalizeResumeChoice(choice);
    if (currentResume.fingerprint !== prepared.resumeFingerprint
      || currentResume.updatedAt !== prepared.resumeUpdatedAt) {
      await closeChooser(prepared.tabId);
      throw senderError("BOSS_MESSAGE_ACTION_RESUME_CHANGED", "the selected BOSS resume changed before dispatch");
    }
    prepared.state = "dispatched";
    try {
      await browser.clickAt(prepared.tabId, choice.point);
    } catch (cause) {
      throw Object.assign(senderError("BOSS_MESSAGE_ACTION_CLICK_AMBIGUOUS", "resume action outcome is ambiguous"), { cause });
    }
    return preparation;
  }

  async function verifyActionResult(preparation, signal) {
    const prepared = requirePreparation(preparation);
    if (prepared.result) return prepared.result;
    if (prepared.state !== "dispatched") throw senderError("BOSS_MESSAGE_ACTION_NOT_DISPATCHED", "message action was not dispatched");
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt) await sleepFn(VERIFY_INTERVAL_MS, signal);
      try {
        await reader.assertActiveBindings(signal);
        const selected = await reader.readSelectedConversation(prepared.selected, signal);
        if (selectedConversationKey(selected) !== prepared.item.conversationKey) {
          return freezeResult(prepared, "target_mismatch", { verification: "target_mismatch" });
        }
        const sent = (selected.messages || []).find((message) =>
          message.direction === "myself"
          && !prepared.beforeMessageIds.has(String(message.messageId || ""))
          && isSentResumeMessage(message));
        if (sent && /^\d{15}$/.test(String(sent.messageId || ""))) {
          prepared.result = Object.freeze({
            state: "succeeded",
            evidence: Object.freeze({
              verification: "new_self_resume_message",
              sourceMessageId: prepared.item.evidence.sourceMessageId,
              sentMessageId: String(sent.messageId),
              resumeKind: prepared.resumeKind,
              resumeFingerprint: prepared.resumeFingerprint,
              resumeUpdatedAt: prepared.resumeUpdatedAt
            })
          });
          return prepared.result;
        }
      } catch (error) {
        if (["BOSS_MESSAGE_TARGET_MISMATCH", "BOSS_MESSAGE_TARGET_INVALID"].includes(error?.code)) {
          return freezeResult(prepared, "target_mismatch", { verification: "target_mismatch" });
        }
        throw error;
      }
    }
    return freezeResult(prepared, "ambiguous", { verification: "resume_send_outcome_unverified" });
  }

  async function clearPreparedAction(preparation) {
    const prepared = requirePreparation(preparation);
    if (prepared.state !== "verified") return { cleared: false };
    await closeChooser(prepared.tabId);
    prepared.state = "cleared";
    return { cleared: true };
  }

  async function closeChooser(tabId) {
    const close = normalizeProbe(await browser.evalValue(tabId, closeExpression()));
    if (close.state === "ready") await browser.clickAt(tabId, close.point);
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
    if (!prepared) throw senderError("BOSS_MESSAGE_ACTION_PREPARATION_INVALID", "message action preparation is invalid");
    return prepared;
  }
}

function normalizeItem(value) {
  const item = {
    platform: String(value?.platform || ""),
    conversationKey: String(value?.conversationKey || ""),
    messageKey: String(value?.messageKey || ""),
    actionKind: String(value?.actionKind || ""),
    evidence: value?.evidence && typeof value.evidence === "object" ? value.evidence : {}
  };
  if (item.platform !== "boss"
    || !/^sha256:[a-f0-9]{64}$/.test(item.conversationKey)
    || !/^sha256:[a-f0-9]{64}$/.test(item.messageKey)
    || item.actionKind !== "resume_request_accept"
    || !/^\d{15}$/.test(String(item.evidence.sourceMessageId || ""))) throw targetMismatch();
  return item;
}

function assertSelected(snapshot, item) {
  const exact = snapshot?.messages?.filter((message) =>
    message.messageKey === item.messageKey
    && String(message.messageId || "") === String(item.evidence.sourceMessageId)
    && message.direction === "friend"
    && (message.contentKind === "resume_request" || isInPlatformResumeRequest(message.text))) || [];
  if (selectedConversationKey(snapshot) !== item.conversationKey || exact.length !== 1) throw targetMismatch();
}

function selectedConversationKey(snapshot) {
  if (/^sha256:[a-f0-9]{64}$/.test(String(snapshot?.conversationKey || ""))) return snapshot.conversationKey;
  const selected = Array.isArray(snapshot?.rows) ? snapshot.rows.filter((row) => row.selected) : [];
  return selected.length === 1 ? String(selected[0].conversationKey || "") : "";
}

function toolbarExpression(item) {
  const sourceMessageId = JSON.stringify(String(item.evidence.sourceMessageId));
  return `(()=>{const operation="boss_resume_action_toolbar";const sourceMessageId=${sourceMessageId};if(location.pathname!=="/web/geek/chat")return {state:"target_mismatch",sourceMessageId};const snap=typeof window.__bossMessageSnapshot==="function"?window.__bossMessageSnapshot():null;if(!snap||snap.risk||snap.login)return {state:"target_mismatch",sourceMessageId};const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"&&s.pointerEvents!=="none"};const buttons=[...document.querySelectorAll(".chat-controls .toolbar-btn")].filter(el=>String(el.textContent||"").replace(/\\s+/g,"").trim()==="发简历"&&visible(el));if(buttons.length!==1)return {state:"action_unavailable",sourceMessageId};const r=buttons[0].getBoundingClientRect();return {state:"ready",sourceMessageId,point:{x:r.left+r.width/2,y:r.top+r.height/2}};})()`;
}

function choiceExpression() {
  return `(()=>{const operation="boss_resume_action_choice";const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"&&s.pointerEvents!=="none"};const dialogs=[...document.querySelectorAll(".dialog-wrap.active .choose-resume-dialog")].filter(visible);if(dialogs.length!==1)return {state:"action_unavailable"};const title=String(dialogs[0].querySelector(".boss-popup__title,.dialog-title")?.textContent||dialogs[0].textContent||"").replace(/\\s+/g,"");if(!title.includes("请选择要发送的简历"))return {state:"action_unavailable"};const parseUpdatedAt=text=>{const m=String(text||"").match(/更新于\\s*(\\d{4})[.\\/-](\\d{1,2})[.\\/-](\\d{1,2})\\s+(\\d{1,2}):(\\d{2})/);if(!m)return null;const pad=v=>String(v).padStart(2,"0");const rank=Number(m[1]+pad(m[2])+pad(m[3])+pad(m[4])+pad(m[5]));return {rank,iso:m[1]+"-"+pad(m[2])+"-"+pad(m[3])+"T"+pad(m[4])+":"+pad(m[5])+":00+08:00"}};const items=[...dialogs[0].querySelectorAll(".resume-list .list-item")].filter(visible).map(el=>{const name=String(el.querySelector(".resume-name")?.textContent||"").trim();const desc=String(el.querySelector(".item-desc")?.textContent||el.textContent||"").trim();const size=String(el.querySelector(".resume-size")?.textContent||"").trim();const updated=parseUpdatedAt(desc);const r=el.getBoundingClientRect();return {el,resumeName:name,resumeUpdatedAt:updated?.iso||"",rank:updated?.rank||0,resumeSize:size,point:{x:r.left+r.width/2,y:r.top+r.height/2}}}).filter(item=>/\\.(?:pdf|docx?)$/i.test(item.resumeName)&&item.rank>0);if(items.length===0)return {state:"action_unavailable"};items.sort((a,b)=>b.rank-a.rank);if(items.length>1&&items[0].rank===items[1].rank)return {state:"resume_ambiguous"};const selected=items[0];return {state:"ready",resumeKind:"latest_attachment",resumeName:selected.resumeName,resumeUpdatedAt:selected.resumeUpdatedAt,resumeSize:selected.resumeSize,point:selected.point};})()`;
}

function closeExpression() {
  return `(()=>{const operation="boss_resume_action_close";const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"&&s.pointerEvents!=="none"};const dialogs=[...document.querySelectorAll(".dialog-wrap.active .choose-resume-dialog")].filter(visible);if(dialogs.length===0)return {state:"already_closed"};if(dialogs.length!==1)return {state:"action_unavailable"};const closes=[...dialogs[0].querySelectorAll(".boss-popup__close")].filter(visible);if(closes.length!==1)return {state:"action_unavailable"};const r=closes[0].getBoundingClientRect();return {state:"ready",point:{x:r.left+r.width/2,y:r.top+r.height/2}};})()`;
}

function normalizeResumeChoice(choice) {
  const resumeName = String(choice.resumeName || "").trim();
  const updatedAt = String(choice.resumeUpdatedAt || "").trim();
  const size = String(choice.resumeSize || "").trim();
  if (!/\.(?:pdf|docx?)$/i.test(resumeName)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(updatedAt)) {
    throw senderError("BOSS_MESSAGE_ACTION_PROBE_INVALID", "BOSS resume chooser returned invalid attachment evidence");
  }
  return {
    updatedAt,
    fingerprint: `sha256:${createHash("sha256").update(`${resumeName}\0${updatedAt}\0${size}`).digest("hex")}`
  };
}

function isSentResumeMessage(message) {
  const text = String(message?.text || "").trim();
  return /简历|履历|resume/i.test(text)
    || (message?.contentKind === "unknown_card" && /\.(?:pdf|docx?)(?:\s|$)/i.test(text));
}

function freezeResult(prepared, state, evidence) {
  prepared.result = Object.freeze({ state, evidence: Object.freeze(evidence) });
  return prepared.result;
}

function normalizeProbe(value) {
  if (!value || typeof value !== "object" || typeof value.state !== "string") {
    throw senderError("BOSS_MESSAGE_ACTION_PROBE_INVALID", "message action page probe returned an invalid result");
  }
  if (value.point && (!Number.isFinite(value.point.x) || !Number.isFinite(value.point.y))) {
    throw senderError("BOSS_MESSAGE_ACTION_PROBE_INVALID", "message action point is invalid");
  }
  return value;
}

function probeError(state) {
  const code = state === "target_mismatch"
    ? "BOSS_MESSAGE_ACTION_TARGET_MISMATCH"
    : state === "resume_ambiguous"
      ? "BOSS_MESSAGE_ACTION_RESUME_AMBIGUOUS"
    : state === "action_unavailable"
      ? "BOSS_MESSAGE_ACTION_UNAVAILABLE"
      : "BOSS_MESSAGE_ACTION_PROBE_INVALID";
  return senderError(code, "message action page verification stopped");
}

function targetMismatch() { return senderError("BOSS_MESSAGE_ACTION_TARGET_MISMATCH", "confirmed message action does not match the current BOSS conversation"); }
function assertDependencies(browser, reader) { for (const name of ["evalValue", "clickAt"]) if (typeof browser?.[name] !== "function") throw new TypeError(`browser.${name} is required`); for (const name of ["scanConversationRows", "openQueuedConversation", "readSelectedConversation", "assertActiveBindings"]) if (typeof reader?.[name] !== "function") throw new TypeError(`reader.${name} is required`); }
function senderError(code, message) { return Object.assign(new Error(message), { code }); }
function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason || senderError("MESSAGE_ACTION_STOPPED", "message action stopped"); }
function sleep(ms, signal) { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || senderError("MESSAGE_ACTION_STOPPED", "message action stopped")); }, { once: true }); }); }

module.exports = { createBossMessageActionSender };
