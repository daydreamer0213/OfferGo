# OfferGo Message Discovery Complete Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make message discovery show only complete, useful user actions by hiding BOSS competition promotions, terminally resolving recruiter rejections, and completing job analysis before publishing an inbox item.

**Architecture:** Keep the existing modular monolith and serial browser workflow. Add one small pure routing-policy module, reuse the existing single-job analysis application service, and make the existing discovery transaction own the final card/draft/inbox result. Keep unresolved work as an internal checkpoint instead of projecting it into the user inbox.

**Tech Stack:** Node.js 22, CommonJS, native SQLite, existing Dashboard HTML renderer, `node:assert`, existing smoke-test runner.

## Global Constraints

- Do not add runtime dependencies, services, queues, ORM layers, or database tables.
- Do not change Dashboard routes, CLI behavior, Agent stdio, data directories, or the SQLite schema.
- Preserve serial BOSS and Zhaopin reads, current pacing, access budgets, checkpointing, and stop-on-risk behavior.
- Do not send messages, resumes, applications, or any other external write during implementation or acceptance.
- Images, voice messages, and attachments remain outside this change.
- Promotion compatibility matching must be narrow enough to preserve useful platform notices.
- A job is decision-ready only when its JD meets the platform minimum and `analysis.semanticStatus === "complete"`.

---

## File Map

- Create `src/core/message_routing_policy.js`: pure, deterministic rules for promotion filtering and explicit recruiter rejection.
- Modify `src/adapters/sites/boss_message_dom.js`: attach `noticeKind: "competition_promotion"` to recognized BOSS competition cards.
- Modify `src/core/message_reply_contract.js`: accept the semantic `rejection` intent and force an empty, terminal result.
- Modify `src/adapters/models/structured.js`: teach the model protocol when to return `rejection`.
- Modify `src/core/message_discovery.js`: run early terminal routing, require complete analysis, delay inbox publication, and commit rejection outcomes idempotently.
- Modify `src/application/message_discovery/job_context.js`: analyze a newly read BOSS job before returning it as message context.
- Modify `src/application/message_discovery/zhaopin_job_context.js`: analyze a newly read Zhaopin job before returning it as message context.
- Modify `src/dashboard/message_discovery_controller.js`: inject the existing single-job analysis service into both resolvers.
- Modify `src/dashboard/message_discovery_view.js`: filter promotions and remove internal-repair groups/copy from the user page.
- Modify the named smoke tests below; do not create a parallel test framework.

---

### Task 1: Identify and hide BOSS competition promotions

**Files:**
- Create: `src/core/message_routing_policy.js`
- Modify: `src/adapters/sites/boss_message_dom.js:126-158, 333-350`
- Modify: `src/dashboard/message_discovery_view.js:337-351`
- Test: `tests/boss_message_dom_smoke.js`
- Test: `tests/dashboard_message_discovery_smoke.js`

**Interfaces:**
- Produces: `isCompetitionPromotion(message): boolean` from `src/core/message_routing_policy.js`.
- Produces: BOSS timeline events with `metadata.noticeKind === "competition_promotion"`.
- Consumes: existing `renderConversationTimeline(events, helpers)` call sites without changing their signature.

- [ ] **Step 1: Add failing adapter and renderer regressions**

Add an assertion to the BOSS DOM fixture that the recognized competition card keeps `contentKind: "platform_notice"` and gains the narrow subtype:

```js
assert.deepEqual(snapshot.selected.messages.find((item) => item.contentKind === "platform_notice").metadata, {
  noticeKind: "competition_promotion"
});
```

Add Dashboard fixtures for both a typed promotion and a historical untyped promotion, plus a normal platform notice. Assert that only the normal notice remains in rendered HTML:

```js
assert.doesNotMatch(html, /你与该职位竞争者PK情况/);
assert.doesNotMatch(html, /查看详细分析/);
assert.match(html, /对方已同意继续沟通/);
```

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

Run:

```powershell
node tests/boss_message_dom_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: the first test lacks `noticeKind`; the second still renders both promotion events.

- [ ] **Step 3: Add the minimal routing policy and adapter metadata**

Create the policy with metadata-first handling and a narrow historical text fallback:

```js
function isCompetitionPromotion(message = {}) {
  if (message?.metadata?.noticeKind === "competition_promotion") return true;
  if (String(message?.kind || message?.contentKind || "") !== "platform_notice") return false;
  const text = String(message?.text || "").replace(/\s+/g, "");
  return /竞争者PK情况/.test(text) && /查看详细分析/.test(text);
}

module.exports = { isCompetitionPromotion };
```

Return `{ noticeKind: "competition_promotion" }` from both the Node and injected-page `messageMetadata` paths when `isCompetitionNoticeCard(card)` is true. In `renderConversationTimeline`, filter with `isCompetitionPromotion` before mapping events. Do not filter other `platform_notice` events.

- [ ] **Step 4: Run focused tests and the architecture boundary check**

Run:

```powershell
node tests/boss_message_dom_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/architecture_boundaries_smoke.js
```

Expected: all pass; Dashboard may import the pure core policy without creating a cycle.

- [ ] **Step 5: Commit the independently reviewable promotion fix**

```powershell
git add src/core/message_routing_policy.js src/adapters/sites/boss_message_dom.js src/dashboard/message_discovery_view.js tests/boss_message_dom_smoke.js tests/dashboard_message_discovery_smoke.js
git commit -m "fix(messages): hide competition promotions"
```

---

### Task 2: Make recruiter rejection a terminal message intent

**Files:**
- Modify: `src/core/message_routing_policy.js`
- Modify: `src/core/message_reply_contract.js:12-90, 227-260`
- Modify: `src/adapters/models/structured.js:510-548`
- Modify: `src/core/candidate_progress.js:418-550`
- Test: `tests/message_reply_contract_smoke.js`
- Test: `tests/structured_model_adapter_smoke.js`
- Test: `tests/message_discovery_smoke.js`

**Interfaces:**
- Produces: `isExplicitRecruiterRejection(messages): boolean` for recruiter-direction text only.
- Produces: validated classification `{ messageIntent: "rejection", messages: [], progressUpdate: { stage: "rejected", nextAction: "" } }`.
- Preserves: existing message category set and model JSON shape.

- [ ] **Step 1: Add failing policy and contract tests**

Cover direct rejection and deliberately ambiguous phrases:

```js
assert.equal(isExplicitRecruiterRejection([{ direction: "friend", text: "不好意思，不太合适哦" }]), true);
assert.equal(isExplicitRecruiterRejection([{ direction: "friend", text: "目前暂不考虑了，祝你求职顺利" }]), true);
assert.equal(isExplicitRecruiterRejection([{ direction: "friend", text: "这个时间不太合适，可以换明天吗" }]), false);
assert.equal(isExplicitRecruiterRejection([{ direction: "myself", text: "我觉得岗位不太合适" }]), false);
```

Pass a complete model-shaped `rejection` object into `validateMessageReply` and assert that any supplied model draft is removed and the stage is terminal:

```js
assert.deepEqual(validateMessageReply(rejectionOutput, context), {
  ...expectedNormalizedFields,
  messageIntent: "rejection",
  messageSummary: "招聘方已明确结束本次机会。",
  messages: [],
  progressUpdate: { stage: "rejected", nextAction: "" }
});
```

- [ ] **Step 2: Run the focused tests and confirm invalid-intent failures**

Run:

```powershell
node tests/message_reply_contract_smoke.js
node tests/structured_model_adapter_smoke.js
```

Expected: `MESSAGE_REPLY_INTENT_INVALID` until the contract and prompt are updated.

- [ ] **Step 3: Implement rejection rules and contract enforcement**

In `message_routing_policy.js`, normalize punctuation and whitespace, inspect only `direction === "friend"`, and accept high-confidence complete phrases such as:

```js
const EXPLICIT_REJECTION_PATTERNS = [
  /(?:抱歉|不好意思).{0,8}(?:不太合适|不合适|不匹配)/,
  /(?:岗位|职位).{0,8}(?:不太匹配|不匹配|不太合适|不合适)/,
  /(?:暂不考虑|不再考虑|无法推进|不予推进|结束本次)(?:.{0,12}(?:候选|面试|流程|机会))?/,
  /祝.{0,6}(?:求职顺利|早日找到)/
];
```

Add `rejection` to `MESSAGE_INTENTS`. Force it through the same no-draft guard as manual-only results, return the fixed summary, map it to `rejected`, and return an empty next action. Add `rejection` to the structured-model instruction with wording that distinguishes a rejected application from scheduling conflicts or negotiation.

Ensure `recordDiscoveredMessageGroupClassification` accepts the new intent through the shared exported `MESSAGE_INTENTS` and its existing legal `rejected` stage transition.

- [ ] **Step 4: Add semantic rejection regression coverage**

In the structured adapter test, return a valid `rejection` JSON object from the fake transport and assert that the adapter accepts it while removing its draft. In the discovery test, use a classifier that returns `rejection` and assert the result has no draft and the card stage is `rejected`.

- [ ] **Step 5: Run the focused tests**

Run:

```powershell
node tests/message_reply_contract_smoke.js
node tests/structured_model_adapter_smoke.js
node tests/message_discovery_smoke.js
```

Expected: all pass.

- [ ] **Step 6: Commit the terminal intent contract**

```powershell
git add src/core/message_routing_policy.js src/core/message_reply_contract.js src/adapters/models/structured.js src/core/candidate_progress.js tests/message_reply_contract_smoke.js tests/structured_model_adapter_smoke.js tests/message_discovery_smoke.js
git commit -m "feat(messages): classify recruiter rejections"
```

---

### Task 3: Complete JD analysis before returning message context

**Files:**
- Modify: `src/core/message_discovery.js:804-823`
- Modify: `src/application/message_discovery/job_context.js:13-145`
- Modify: `src/application/message_discovery/zhaopin_job_context.js:8-158`
- Modify: `src/dashboard/message_discovery_controller.js:70-104, 268-284`
- Test: `tests/message_discovery_job_context_smoke.js`
- Test: `tests/zhaopin_message_job_context_smoke.js`
- Test: `tests/dashboard_message_discovery_smoke.js`

**Interfaces:**
- Consumes: existing `retryOneJobAnalysis({ db, input: { planId, jobId }, deps })`.
- Produces: resolver option `analyzeJobContext({ planId, jobId, signal }): Promise<object>`.
- Guarantees: a resolver returns only a context whose description meets the platform minimum and whose `analysis.semanticStatus` is `complete`, except the existing verified offline/unavailable terminal record which cannot be analyzed.

- [ ] **Step 1: Add failing completeness tests**

Change existing assertions that accepted `message-discovery-detail + pending`. Assert that such a context is rejected with `MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE` unless the injected analyzer changes the persisted observation to complete:

```js
let analyses = 0;
const resolve = createMessageDiscoveryJobContextResolver({
  db, profileId, messageReader, detailReader,
  analyzeJobContext: async ({ planId, jobId }) => {
    analyses += 1;
    completeStoredAnalysis(db, { planId, jobId });
  }
});
const resolved = await resolve(target, { signal: null });
assert.equal(analyses, 1);
assert.equal(resolved.job.analysis.semanticStatus, "complete");
```

Add a second call asserting `analyses` stays at `1`, and a failure case asserting the resolver throws `MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE` without returning a partial context. Repeat for Zhaopin.

- [ ] **Step 2: Run focused context tests and confirm pending analysis is currently accepted**

Run:

```powershell
node tests/message_discovery_job_context_smoke.js
node tests/zhaopin_message_job_context_smoke.js
```

Expected: new strict assertions fail because the current resolvers return `pending`.

- [ ] **Step 3: Tighten the core completeness predicate**

Replace the trusted-pending exception with this decision:

```js
return unavailableMessageDetail || (
  String(job?.description || "").trim().length >= minimumLength
  && analysis.semanticStatus === "complete"
);
```

Keep the existing offline/unavailable exception because a removed source page cannot truthfully produce a full JD. Do not let that exception produce an ordinary recommendation draft.

- [ ] **Step 4: Analyze freshly persisted detail in both resolvers**

Accept and validate an optional `analyzeJobContext` function. After `upsertJob` stores the detail, reload the context, and only call the analyzer when it is not already complete:

```js
let context = findContext(plan.id, sourceId);
if (context?.job?.analysis?.semanticStatus !== "complete") {
  if (typeof analyzeJobContext !== "function") {
    throw contextError("MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE", "message job analysis is incomplete");
  }
  await analyzeJobContext({ planId: plan.id, jobId: context.jobId, signal });
  context = findContext(plan.id, sourceId);
}
if (!context?.contextComplete || context.job.analysis?.semanticStatus !== "complete") {
  throw contextError("MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE", "message job analysis is incomplete");
}
return context;
```

The resolver must re-read from SQLite after analysis; do not trust the callback return value as the source of truth.

- [ ] **Step 5: Inject the existing analysis use case from the controller**

Import `retryOneJobAnalysis` in the controller and add an overridable dependency `analyzeMessageJob`. Pass this resolver callback:

```js
resolverOptions.analyzeJobContext = ({ planId, jobId, signal }) => analyzeMessageJob({
  db,
  input: { planId, jobId },
  deps: {
    root,
    modelConfig,
    modelReady: true,
    logger,
    signal,
    messageContextAnalysis: true,
    createJobAnalysisRunner: deps.analysisRetryRunnerFactory || undefined
  }
});
```

Use the batch-screening model configuration, not the bounded reply-draft model configuration.

- [ ] **Step 6: Run context, analysis, and controller tests**

Run:

```powershell
node tests/message_discovery_job_context_smoke.js
node tests/zhaopin_message_job_context_smoke.js
node tests/analysis_application_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: all pass; completed jobs are not analyzed again and failed analysis stays internal.

- [ ] **Step 7: Commit strict message job readiness**

```powershell
git add src/core/message_discovery.js src/application/message_discovery/job_context.js src/application/message_discovery/zhaopin_job_context.js src/dashboard/message_discovery_controller.js tests/message_discovery_job_context_smoke.js tests/zhaopin_message_job_context_smoke.js tests/dashboard_message_discovery_smoke.js
git commit -m "fix(messages): require complete job analysis"
```

---

### Task 4: Route explicit rejection before detail reads and publish inbox results atomically

**Files:**
- Modify: `src/core/message_discovery.js:105-650, 1470-1538`
- Modify: `src/storage/message_learning_store.js:316-333` only if the existing close function needs a transaction-compatible internal variant
- Modify: `src/application/message_inbox/index.js`
- Test: `tests/message_discovery_smoke.js`
- Test: `tests/zhaopin_message_discovery_smoke.js`
- Test: `tests/message_inbox_store_smoke.js`

**Interfaces:**
- Consumes: `isExplicitRecruiterRejection(messages)` and existing `closeMessageReplyDrafts`, `markMessageInboxItemDone`, timeline, progress, and unresolved ports.
- Produces: final inbox groups only: `waiting`, `needs_action`, or `done`; internal failures do not create `needs_review` rows.
- Guarantees: direct rejection never invokes the detail reader or draft model.

- [ ] **Step 1: Add failing end-to-end discovery regressions**

Create a selected conversation whose friend message is “不好意思，不太合适哦”. Instrument the dependencies and assert:

```js
assert.equal(detailReads, 0);
assert.equal(modelCalls, 0);
assert.equal(result.results.length, 0);
assert.equal(getProgressCardById(db, cardId).stage, "rejected");
assert.equal(listOpenMessageReplyDrafts(db, { profileId }).length, 0);
assert.equal(getMessageInboxItem(db, { profileId, platform, conversationKey }).actionGroup, "done");
```

Run the same discovery twice and assert one classification event, zero open drafts, and the same terminal inbox row. Add a no-card rejection case that archives the inbox item but does not update any unrelated card.

Add a context-analysis failure case and assert that the unresolved checkpoint exists while no inbox row with `needs_review` or `needs_action` exists for that conversation.

- [ ] **Step 2: Run discovery tests and confirm current behavior is wrong**

Run:

```powershell
node tests/message_discovery_smoke.js
node tests/zhaopin_message_discovery_smoke.js
node tests/message_inbox_store_smoke.js
```

Expected: direct rejection currently reaches detail/model work, and local failures currently create `needs_review` inbox rows.

- [ ] **Step 3: Stop projecting unclassified friend previews**

Change `projectScannedInboxRows` so it only publishes a row immediately when `lastMessageDirection === "myself"`:

```js
if (row.lastMessageDirection !== "myself") continue;
upsertMessageInboxItem(db, {
  ...identity,
  actionGroup: "waiting",
  actionCode: "wait",
  reasonCode: ""
});
```

Do not project unresolved items as `needs_review`. Change `recordLocalInboxFailure` to preserve the unresolved checkpoint without upserting a user-visible inbox item. If a stale `needs_review` row already exists for that exact conversation, mark it done or delete it through an explicit store operation rather than leaving it visible.

- [ ] **Step 4: Add an early terminal rejection branch**

After the selected timeline has been verified and persisted, but before resolving JD context, classify high-confidence direct rejection. Resolve a card only when the existing identity logic can do so safely. In one `immediateTransaction`:

```js
const classification = {
  messageIntent: "rejection",
  messageCategory: "other",
  messageSummary: "招聘方已明确结束本次机会。",
  missingFact: null,
  messages: [],
  progressUpdate: { stage: "rejected", nextAction: "" }
};
```

When a card is reliable, record the idempotent message-group classification and close all open drafts for that card. Always commit the preview baseline, clear the unresolved row, and upsert the conversation inbox as `done` with empty action/reason codes. If the card is not reliable, archive only the inbox conversation.

Use one timestamp and one outer transaction. If the existing draft-close helper starts its own transaction, add a transaction-compatible private operation in `message_learning_store` and keep the public API behavior unchanged.

- [ ] **Step 5: Route semantic rejection through the same terminal commit**

After model classification, branch on `classification.messageIntent === "rejection"`. Reuse the same commit helper as the deterministic branch so model and local results cannot diverge. Do not call `recordMessageReplyDrafts` for rejection.

For other successful classifications, upsert `needs_action` only after the card, draft, inbound context, baseline, and unresolved-clear operations succeed. Information updates with no user action should become `waiting` or `done` according to the validated classification instead of forcing `reply`.

- [ ] **Step 6: Run focused and idempotency tests**

Run:

```powershell
node tests/message_discovery_smoke.js
node tests/zhaopin_message_discovery_smoke.js
node tests/message_inbox_store_smoke.js
node tests/batch_state_consistency_smoke.js
```

Expected: all pass; repeated sync creates no duplicate draft, event, or external action.

- [ ] **Step 7: Commit final message routing ownership**

```powershell
git add src/core/message_discovery.js src/storage/message_learning_store.js src/application/message_inbox/index.js tests/message_discovery_smoke.js tests/zhaopin_message_discovery_smoke.js tests/message_inbox_store_smoke.js
git commit -m "fix(messages): publish only complete actions"
```

---

### Task 5: Reconcile historical rows and simplify the user page

**Files:**
- Modify: `src/core/message_discovery.js`
- Modify: `src/dashboard/message_discovery_view.js:225-245, 300-337, 553-571`
- Modify: `src/dashboard/message_discovery_controller.js:620-710`
- Test: `tests/dashboard_message_discovery_smoke.js`
- Test: `tests/dashboard_unified_messages_journey.js`
- Test: `tests/message_discovery_smoke.js`

**Interfaces:**
- Produces: idempotent `reconcileMessageDiscoveryHistory({ db, profileId, platform, now, analyzeJobContext })` called once per platform sync before browser queue processing.
- Preserves: timeline/history data while removing obsolete drafts and user-visible internal repair items.

- [ ] **Step 1: Add historical-repair fixtures and failing UI assertions**

Seed:

1. An old competition promotion without `noticeKind`.
2. A `needs_action` rejection with an open draft and a nonterminal card.
3. A `needs_review` row backed by an unresolved context-analysis checkpoint.
4. A normal waiting conversation.

Assert after reconciliation that the rejection is `done`, its card is `rejected`, the draft is closed, and a second reconciliation changes no row counts. Assert the HTML contains “现在需要你处理”, “等待对方回复”, and “已结束记录”, but not “系统正在补充资料” or “岗位资料正在后台补充”.

- [ ] **Step 2: Run Dashboard journey tests and confirm the obsolete group is present**

Run:

```powershell
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_unified_messages_journey.js
```

Expected: assertions fail on the current `needs_review` section and copy.

- [ ] **Step 3: Implement idempotent local history reconciliation**

At the start of each platform discovery run:

- Read existing unresolved/inbox/timeline state for that profile and platform.
- Apply the same deterministic rejection terminal helper to recruiter messages whose latest meaningful inbound text is an explicit rejection.
- Close stale drafts and terminally update the linked card only after verified ownership.
- Remove obsolete `needs_review` presentation state while retaining unresolved checkpoints.
- Let the normal resolver path analyze pending job contexts when their conversation is processed; do not bulk-read browser details or bypass pacing during reconciliation.

Every mutation must use existing unique keys and terminal-state checks so a repeated sync is a no-op.

- [ ] **Step 4: Remove internal repair groups from the page model**

Render only these public groups:

```js
const groups = [
  ["needs_action", "现在需要你处理", false],
  ["waiting", "等待对方回复", false],
  ["done", "已结束记录", true]
];
```

Do not merge unresolved items into the visible message list. Keep their count and reason in controller diagnostics/status for logging, but omit their message bodies and repair controls from the normal `/messages` page. Platform login, security verification, tab loss, and page loss remain visible run-level blockers.

- [ ] **Step 5: Run the full message module suite**

Run:

```powershell
node tests/boss_message_dom_smoke.js
node tests/message_reply_contract_smoke.js
node tests/message_discovery_job_context_smoke.js
node tests/zhaopin_message_job_context_smoke.js
node tests/message_discovery_smoke.js
node tests/zhaopin_message_discovery_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_unified_messages_journey.js
```

Expected: all pass with no real browser write.

- [ ] **Step 6: Commit reconciliation and page simplification**

```powershell
git add src/core/message_discovery.js src/dashboard/message_discovery_view.js src/dashboard/message_discovery_controller.js tests/message_discovery_smoke.js tests/dashboard_message_discovery_smoke.js tests/dashboard_unified_messages_journey.js
git commit -m "fix(messages): reconcile terminal conversations"
```

---

### Task 6: Run complete gates and real logged-in Edge acceptance

**Files:**
- Modify only if validation exposes a regression in files already named above.
- Evidence: store generated screenshots/logs under `D:\DevData\OfferGo-message-acceptance-20260918`.

**Interfaces:**
- Consumes: exact committed SHA after Tasks 1-5.
- Produces: offline gate evidence and read-only real-path acceptance evidence.

- [ ] **Step 1: Run fast and integration gates**

Run:

```powershell
npm run test:fast
npm run test:integration
```

Expected: all configured checks pass.

- [ ] **Step 2: Run the complete offline gate**

Run:

```powershell
npm test
```

Expected: every manifest check passes. Record the total and exact SHA.

- [ ] **Step 3: Start the current committed Dashboard acceptance build**

Use the normal installed-app/workspace startup path, not a `.bat` file. Confirm the Dashboard opens, the six fixed workspace tabs are present, and no second Edge window or duplicate BOSS session is created.

- [ ] **Step 4: Execute the real read-only message path in the user’s logged-in Edge**

From `/messages`, click “同步最新消息” once and wait for both platform runs to finish. Verify in DOM and local database:

- no BOSS competition-promotion text is visible;
- the two known explicit rejection conversations are in “已结束记录”;
- those rejections have no open reply drafts;
- no “系统正在补充资料” group or half-complete decision card is visible;
- messages shown in “现在需要你处理” have complete stored JD analysis;
- BOSS and Zhaopin were processed serially;
- there are still exactly the expected fixed tabs and no residual transient detail tab.

Do not click any send, resume, application, accept, or decline action.

- [ ] **Step 5: Capture visual evidence at desktop and narrow widths**

Capture the unified message page at approximately 1440 px and 390 px widths into `D:\DevData\OfferGo-message-acceptance-20260918`. Confirm headings, counts, recruiter text, action hierarchy, and card spacing are readable.

- [ ] **Step 6: If validation required a code fix, rerun the exact-SHA gate**

After any correction, commit it, rerun `npm test`, and repeat the read-only Edge path. Do not report success from an earlier SHA.

- [ ] **Step 7: Report the reviewable acceptance result**

Provide the exact SHA, gate total, installed acceptance path, screenshots, and any remaining user-facing design choice. State separately that no external write was performed.

---

## Self-Review Record

- Spec coverage: promotion filtering, deterministic and semantic rejection, complete JD analysis, delayed inbox publication, idempotent repair, three public page groups, offline tests, and read-only Edge acceptance each map to a task above.
- Placeholder scan: no unspecified implementation step or unnamed test remains.
- Interface consistency: both resolvers use the same `analyzeJobContext({ planId, jobId, signal })` interface; both rejection paths use the same validated `rejection` classification and terminal commit helper; the renderer consumes the shared promotion predicate.
- Scope: no schema, route, dependency, browser-safety, or external-action boundary changes are included.
