const assert = require("node:assert/strict");
const { buildHealthView } = require("../src/application/funnel_analysis/health_view");

const stage = (numerator, denominator, unknown = 0, waiting = 0) => ({ numerator, denominator, unknown, waiting });
const view = buildHealthView({
  platforms: [{
    site: "boss",
    currentRound: {
      started: 10,
      waiting: 2,
      unknown: 1,
      staleCount: 3,
      immediatePositive: {
        replied: 5,
        effectiveConversation: 4,
        resumeRequested: 3,
        interviewInvited: 2,
        interviewConfirmed: 2,
        interviewCompleted: 1,
        offerReceived: 1
      },
      funnel: {
        read: stage(7, 9, 1, 0),
        replied: stage(5, 7, 0, 2),
        effectiveConversation: stage(4, 5),
        resumeRequested: stage(3, 4),
        interviewInvited: stage(2, 4),
        interviewConfirmed: stage(2, 2),
        interviewCompleted: stage(1, 2),
        offerReceived: stage(1, 1)
      }
    }
  }, {
    site: "zhaopin",
    currentRound: {
      started: 8,
      waiting: 1,
      unknown: 4,
      staleCount: 2,
      immediatePositive: { replied: 2, effectiveConversation: 2, interviewInvited: 1 },
      funnel: {
        read: stage(0, 0, 8, 0),
        replied: stage(2, 2, 4, 1),
        effectiveConversation: stage(2, 2),
        resumeRequested: stage(0, 2),
        interviewInvited: stage(1, 2),
        interviewConfirmed: stage(0, 1, 1),
        interviewCompleted: stage(0, 0, 1),
        offerReceived: stage(0, 0)
      }
    }
  }],
  advice: { site: "boss", stage: "replied", title: "先检查招呼语和岗位匹配", numerator: 5, denominator: 7 },
  headline: "当前主要卡在已读到回复。",
  priorityCheck: "先检查岗位匹配。"
});

assert.deepStrictEqual(view.platformFunnels[0].stages.map((item) => item.key), [
  "started", "read", "replied", "effectiveConversation", "resumeRequested",
  "interviewInvited", "interviewConfirmed", "interviewCompleted", "offerReceived"
]);
assert.deepStrictEqual(view.platformFunnels[1].stages.map((item) => item.key), [
  "started", "replied", "effectiveConversation", "resumeRequested",
  "interviewInvited", "interviewConfirmed", "interviewCompleted", "offerReceived"
], "智联没有可靠已读状态时不展示一个假的已读环节");
assert.deepStrictEqual(view.platformFunnels[0].stages.find((item) => item.key === "replied"), {
  key: "replied",
  label: "收到回复",
  reached: 5,
  eligible: 7,
  unknown: 0,
  waiting: 2
});
assert.deepStrictEqual(view.overview, {
  contacted: 18,
  replied: 7,
  effectiveConversation: 6,
  interviewInvited: 3,
  interviewCompleted: 1,
  offerReceived: 1,
  waiting: 3,
  unknown: 5
});
assert.deepStrictEqual(view.stale, {
  total: 5,
  byPlatform: [{ site: "boss", count: 3 }, { site: "zhaopin", count: 2 }]
});
assert.equal(view.diagnosis.title, "先检查招呼语和岗位匹配");
assert.match(view.diagnosis.detail, /7.*5/);

console.log("funnel_health_view_smoke ok");
