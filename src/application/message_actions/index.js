const {
  confirmMessageAction,
  getMessageAction,
  listActiveMessageActions,
  listMessageActions,
  transitionMessageAction
} = require("../../storage/message_action_store");
const { markMessageInboxItemDone } = require("../../storage/message_inbox_store");

function createMessageActionService({ db, now = () => new Date() } = {}) {
  if (!db) throw new TypeError("message action service requires db");
  return { confirm, status, active, list, transition, completeVerified };

  function confirm(input = {}) {
    const platform = String(input.platform || "");
    if (!["boss", "zhaopin"].includes(platform)) {
      throw actionError("MESSAGE_ACTION_PLATFORM_UNSUPPORTED", "当前页面还不能安全执行这个平台操作。");
    }
    if (platform === "boss" && String(input.actionKind || "") !== "resume_request_accept") {
      throw actionError("MESSAGE_ACTION_KIND_UNSUPPORTED", "BOSS 当前只支持确认发送在线简历。");
    }
    return confirmMessageAction(db, { ...input, confirmedAt: nowIso(now()) });
  }

  function status(input = {}) {
    const action = getMessageAction(db, input);
    if (!action) throw actionError("MESSAGE_ACTION_NOT_FOUND", "消息操作不存在。");
    return action;
  }

  function active(input = {}) { return listActiveMessageActions(db, input); }
  function list(input = {}) { return listMessageActions(db, input); }
  function transition(input = {}) { return transitionMessageAction(db, { ...input, updatedAt: nowIso(now()) }); }

  function completeVerified(input = {}) {
    const current = status(input);
    if (current.status === "succeeded") return current;
    if (current.status !== "click_dispatched" || current.clickCount !== 1) {
      throw actionError("MESSAGE_ACTION_NOT_VERIFIED", "消息操作尚未完成平台核验。");
    }
    const action = transition({
      profileId: current.profileId,
      actionId: current.id,
      expectedStatus: "click_dispatched",
      status: "succeeded",
      clickCount: 1,
      evidence: input.evidence || {}
    });
    markMessageInboxItemDone(db, {
      profileId: action.profileId,
      platform: action.platform,
      conversationKey: action.conversationKey,
      resolvedAt: action.updatedAt
    });
    return action;
  }
}

function nowIso(value) { const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw new TypeError("now must return a valid timestamp"); return date.toISOString(); }
function actionError(code, message) { return Object.assign(new Error(message), { code }); }

module.exports = { createMessageActionService };
