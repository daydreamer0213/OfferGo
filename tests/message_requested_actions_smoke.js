const assert = require("node:assert/strict");
const { deriveRequestedActions } = require("../src/core/message_requested_actions");

const resumeOnly = deriveRequestedActions({
  platform: "boss",
  messages: [{ messageKey: "m1", text: "您好，可以发下您的简历吗？" }],
  manualActions: []
});
assert.deepStrictEqual(resumeOnly.requestedActions, [{ kind: "resume_request" }]);
assert.deepStrictEqual(resumeOnly.replyMessages, [], "a resume-only request must be handled by the platform action without a useless reply draft");

const resumeAndSchedule = deriveRequestedActions({
  platform: "boss",
  messages: [{ messageKey: "m2", text: "方便发一下简历吗？另外明天下午方便沟通吗？" }],
  manualActions: []
});
assert.deepStrictEqual(resumeAndSchedule.requestedActions, [{ kind: "resume_request" }]);
assert.deepStrictEqual(resumeAndSchedule.replyMessages, [{ messageKey: "m2", text: "另外明天下午方便沟通吗？" }]);

for (const text of [
  "我看过你的简历，项目经历不错。",
  "简历里的知识库项目是你负责的吗？",
  "已经收到你的简历了。"
]) {
  const mentionOnly = deriveRequestedActions({
    platform: "boss",
    messages: [{ messageKey: "m3", text }],
    manualActions: []
  });
  assert.deepStrictEqual(mentionOnly.requestedActions, [], text);
  assert.deepStrictEqual(mentionOnly.replyMessages, [{ messageKey: "m3", text }], text);
}

const structured = deriveRequestedActions({
  platform: "zhaopin",
  messages: [{ messageKey: "m4", text: "明天下午方便沟通吗？" }],
  manualActions: [{ kind: "resume_request" }]
});
assert.deepStrictEqual(structured.requestedActions, [{ kind: "resume_request" }]);
assert.deepStrictEqual(structured.replyMessages, [{ messageKey: "m4", text: "明天下午方便沟通吗？" }]);

const externalChannel = deriveRequestedActions({
  platform: "boss",
  messages: [{ messageKey: "m5", text: "请把简历发到 hr@example.com" }],
  manualActions: []
});
assert.deepStrictEqual(externalChannel.requestedActions, [], "an explicit external channel must not become an in-platform send action");
assert.deepStrictEqual(externalChannel.replyMessages, [{ messageKey: "m5", text: "请把简历发到 hr@example.com" }]);

console.log("message_requested_actions_smoke ok");
