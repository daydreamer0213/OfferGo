const assert = require("node:assert");
const crypto = require("node:crypto");
const { createZhaopinMessageReplySender } = require("../src/adapters/sites/zhaopin_message_reply_sender");

const conversationKey = `sha256:${"a".repeat(64)}`;
const replyText = "您好，我明天下午方便沟通。";
const replyDigest = `sha256:${crypto.createHash("sha256").update(replyText).digest("hex")}`;
const item = { conversationKey, sourceJobId: "zhaopin:CCL123", expectedLastMessageId: "201", replyText, replyDigest };
const row = { tabId: 17, identityVerified: true, conversationKey, sourceJobId: item.sourceJobId };
const selected = { conversationKey, sourceJobId: item.sourceJobId, lastMessageId: "201", messages: [{ direction: "friend", contentKind: "text", messageId: "201", text: "方便沟通吗" }] };

function setup({ editorText = "", readbackText = replyText, mismatch = false, noButton = false, outgoing = true } = {}) {
  let inserted = "";
  let clicked = 0;
  let dispatched = false;
  const reader = {
    async scanConversationRows() { return { tabId: 17, rows: [row] }; },
    async openQueuedConversation() { return selected; },
    async readSelectedJobTarget() { return { jobId: "CCL123" }; },
    async assertActiveBindings() {},
    async readSelectedConversation() {
      if (mismatch) return { ...selected, conversationKey: `sha256:${"b".repeat(64)}` };
      return dispatched && outgoing
        ? { ...selected, lastMessageId: "202", messages: [...selected.messages, { direction: "myself", contentKind: "text", messageId: "202", text: replyText }] }
        : selected;
    }
  };
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("zhaopin_reply_preflight")) return { state: "ready", editorCount: 1, editorText };
      if (expression.includes("zhaopin_reply_focus")) return { state: "ready", focused: true };
      if (expression.includes("zhaopin_reply_readback")) return { state: "ready", editorText: readbackText === null ? inserted : readbackText };
      if (expression.includes("im-sender__send-btn")) return noButton ? { state: "send_button_invalid" } : { state: "ready", point: { x: 12, y: 34 } };
      if (expression.includes("zhaopin_reply_clear")) return { state: "cleared" };
      throw new Error("unexpected expression");
    },
    async cdp(_tabId, method, params) { if (method === "Input.insertText") inserted = params.text; },
    async clickAt() { clicked += 1; dispatched = true; }
  };
  return { sender: createZhaopinMessageReplySender({ browser, reader, sleepFn: async () => {} }), get clicked() { return clicked; } };
}

(async () => {
  const success = setup();
  const inspection = await success.sender.inspectReplyTarget(item);
  const preparation = await success.sender.fillReply(inspection, replyText);
  await success.sender.dispatchReply(preparation);
  assert.equal(success.clicked, 1);
  assert.deepEqual(await success.sender.verifyReplyResult(preparation), {
    state: "succeeded",
    evidence: { verification: "new_outgoing_message", outgoingMessageId: "202", replyDigest }
  });

  await assert.rejects(async () => {
    const fixture = setup({ editorText: "已有内容" });
    const token = await fixture.sender.inspectReplyTarget(item);
    await fixture.sender.fillReply(token, replyText);
  }, (error) => error.code === "ZHAOPIN_MESSAGE_REPLY_EDITOR_NOT_EMPTY");

  await assert.rejects(async () => {
    const fixture = setup({ readbackText: "被改写" });
    const token = await fixture.sender.inspectReplyTarget(item);
    await fixture.sender.fillReply(token, replyText);
  }, (error) => error.code === "ZHAOPIN_MESSAGE_REPLY_READBACK_MISMATCH");

  await assert.rejects(async () => {
    const fixture = setup({ noButton: true });
    const token = await fixture.sender.inspectReplyTarget(item);
    const prepared = await fixture.sender.fillReply(token, replyText);
    await fixture.sender.dispatchReply(prepared);
  }, (error) => error.code === "ZHAOPIN_MESSAGE_REPLY_SEND_BUTTON_INVALID");

  await assert.rejects(() => setup().sender.inspectReplyTarget({ ...item, conversationKey: `sha256:${"c".repeat(64)}` }), (error) => error.code === "ZHAOPIN_MESSAGE_REPLY_TARGET_MISMATCH");

  const ambiguous = setup({ outgoing: false });
  const ambiguousInspection = await ambiguous.sender.inspectReplyTarget(item);
  const ambiguousPreparation = await ambiguous.sender.fillReply(ambiguousInspection, replyText);
  await ambiguous.sender.dispatchReply(ambiguousPreparation);
  assert.deepEqual(await ambiguous.sender.verifyReplyResult(ambiguousPreparation), { state: "ambiguous", evidence: { verification: "outgoing_message_unverified" } });

  const cleanup = setup();
  const cleanupInspection = await cleanup.sender.inspectReplyTarget(item);
  const cleanupPreparation = await cleanup.sender.fillReply(cleanupInspection, replyText);
  assert.deepEqual(await cleanup.sender.clearPreparedReply(cleanupPreparation), { cleared: true });
  assert.equal(cleanup.clicked, 0);

  console.log("zhaopin_message_reply_sender_smoke ok");
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
