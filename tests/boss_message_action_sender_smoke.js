const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createBossMessageActionSender } = require("../src/adapters/sites/boss_message_action_sender");

const conversationKey = `sha256:${"a".repeat(64)}`;
const messageKey = `sha256:${"b".repeat(64)}`;
const item = {
  platform: "boss",
  conversationKey,
  messageKey,
  actionKind: "resume_request_accept",
  evidence: { sourceMessageId: "123456789015924", cardType: "" }
};
const newestResume = {
  resumeName: "郭铭福-AI应用开发工程师.pdf",
  resumeUpdatedAt: "2026-09-21T14:32:00+08:00",
  resumeSize: "248 KB"
};

(async () => {
  const success = fixture();
  const sender = createBossMessageActionSender({ browser: success.browser, reader: success.reader, sleepFn: async () => {} });
  const inspection = await sender.inspectTarget(item);
  const prepared = await sender.prepareAction(inspection);
  assert.deepStrictEqual(success.clicks, ["toolbar"], "preparation may open the reversible chooser but must not select an attachment");
  await sender.dispatchAction(prepared);
  assert.deepStrictEqual(success.clicks, ["toolbar", "latest_attachment"], "dispatch must select the uniquely newest attachment exactly once");
  assert.deepStrictEqual(await sender.verifyActionResult(prepared), {
    state: "succeeded",
    evidence: {
      verification: "new_self_resume_message",
      sourceMessageId: "123456789015924",
      sentMessageId: "123456789015925",
      resumeKind: "latest_attachment",
      resumeFingerprint: fingerprint(newestResume),
      resumeUpdatedAt: newestResume.resumeUpdatedAt
    }
  });
  await assert.rejects(() => sender.dispatchAction(prepared), (error) => error.code === "BOSS_MESSAGE_ACTION_ALREADY_DISPATCHED");

  const cleared = fixture();
  const clearSender = createBossMessageActionSender({ browser: cleared.browser, reader: cleared.reader, sleepFn: async () => {} });
  const clearInspection = await clearSender.inspectTarget(item);
  const clearPrepared = await clearSender.prepareAction(clearInspection);
  assert.deepStrictEqual(await clearSender.clearPreparedAction(clearPrepared), { cleared: true });
  assert.deepStrictEqual(cleared.clicks, ["toolbar", "close"], "a no-send preparation probe must close the chooser it opened");

  for (const choiceState of ["resume_ambiguous", "action_unavailable"]) {
    const unsafe = fixture({ choiceState });
    const unsafeSender = createBossMessageActionSender({ browser: unsafe.browser, reader: unsafe.reader, sleepFn: async () => {} });
    const unsafeInspection = await unsafeSender.inspectTarget(item);
    await assert.rejects(
      () => unsafeSender.prepareAction(unsafeInspection),
      (error) => error.code === (choiceState === "resume_ambiguous"
        ? "BOSS_MESSAGE_ACTION_RESUME_AMBIGUOUS"
        : "BOSS_MESSAGE_ACTION_UNAVAILABLE")
    );
    assert.deepStrictEqual(unsafe.clicks, ["toolbar", "close"], "unsafe attachment choices must close without selecting any resume");
  }

  const changed = fixture({ changeResumeBeforeDispatch: true });
  const changedSender = createBossMessageActionSender({ browser: changed.browser, reader: changed.reader, sleepFn: async () => {} });
  const changedInspection = await changedSender.inspectTarget(item);
  const changedPrepared = await changedSender.prepareAction(changedInspection);
  await assert.rejects(() => changedSender.dispatchAction(changedPrepared), (error) => error.code === "BOSS_MESSAGE_ACTION_RESUME_CHANGED");
  assert.deepStrictEqual(changed.clicks, ["toolbar", "close"], "a changed chooser must close without selecting either attachment");

  const mismatch = fixture({ matchingSource: false });
  const mismatchSender = createBossMessageActionSender({ browser: mismatch.browser, reader: mismatch.reader, sleepFn: async () => {} });
  await assert.rejects(() => mismatchSender.inspectTarget(item), (error) => error.code === "BOSS_MESSAGE_ACTION_TARGET_MISMATCH");
  assert.deepStrictEqual(mismatch.clicks, []);

  const ambiguous = fixture({ verifyState: "still_pending" });
  const ambiguousSender = createBossMessageActionSender({ browser: ambiguous.browser, reader: ambiguous.reader, sleepFn: async () => {} });
  const ambiguousInspection = await ambiguousSender.inspectTarget(item);
  const ambiguousPrepared = await ambiguousSender.prepareAction(ambiguousInspection);
  await ambiguousSender.dispatchAction(ambiguousPrepared);
  assert.deepStrictEqual(await ambiguousSender.verifyActionResult(ambiguousPrepared), {
    state: "ambiguous",
    evidence: { verification: "resume_send_outcome_unverified" }
  });
  assert.deepStrictEqual(ambiguous.clicks, ["toolbar", "latest_attachment"], "an ambiguous send must never be retried");

  console.log("boss_message_action_sender_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function fixture({ matchingSource = true, verifyState = "succeeded", choiceState = "ready", changeResumeBeforeDispatch = false } = {}) {
  const clicks = [];
  let choiceProbeCount = 0;
  const source = {
    conversationKey,
    messages: matchingSource ? [{
      messageId: "123456789015924",
      messageKey,
      direction: "friend",
      contentKind: "text",
      text: "方便请您分享最新简历吗？"
    }] : []
  };
  const reader = {
    async scanConversationRows() {
      return { tabId: 19, rows: [{ identityVerified: true, conversationKey, transientSignature: `sha256:${"c".repeat(64)}` }] };
    },
    async openQueuedConversation() { return source; },
    async readSelectedConversation() {
      return clicks.includes("latest_attachment") && verifyState === "succeeded"
        ? { ...source, messages: [...source.messages, {
          messageId: "123456789015925",
          messageKey: `sha256:${"d".repeat(64)}`,
          direction: "myself",
          contentKind: "unknown_card",
          text: newestResume.resumeName
        }] }
        : source;
    },
    async assertActiveBindings() {}
  };
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("boss_resume_action_toolbar")) {
        return { state: "ready", point: { x: 10, y: 20 }, sourceMessageId: "123456789015924" };
      }
      if (expression.includes("boss_resume_action_choice")) {
        choiceProbeCount += 1;
        if (choiceState !== "ready") return { state: choiceState };
        return {
          state: "ready",
          point: { x: 30, y: 40 },
          resumeKind: "latest_attachment",
          ...(changeResumeBeforeDispatch && choiceProbeCount > 1
            ? { ...newestResume, resumeName: "另一份简历.pdf" }
            : newestResume)
        };
      }
      if (expression.includes("boss_resume_action_close")) {
        return { state: "ready", point: { x: 50, y: 60 } };
      }
      throw new Error("unexpected expression");
    },
    async clickAt(_tabId, point) {
      clicks.push(point.x === 10 ? "toolbar" : point.x === 50 ? "close" : "latest_attachment");
    }
  };
  return { browser, reader, clicks };
}

function fingerprint(resume) {
  return `sha256:${createHash("sha256")
    .update(`${resume.resumeName}\0${resume.resumeUpdatedAt}\0${resume.resumeSize}`)
    .digest("hex")}`;
}
