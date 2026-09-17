# OfferGo Unified Message Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current message discovery page into a durable unified action inbox that refreshes both platforms, covers the previous 72 hours on first use, continues past item-local failures, and tells the user what to do next without platform or task filters.

**Architecture:** Keep the existing modular monolith and browser-safety boundaries. Platform readers own safe refresh and timestamp extraction, the message-discovery core owns queueing and failure isolation, a focused inbox store owns durable projection and sync checkpoints, and the Dashboard controller/view only translate that state into the user-facing action inbox.

**Tech Stack:** Node.js 22, CommonJS, native SQLite, existing CDP/Edge Control browser adapters, server-rendered HTML/CSS, Node assertion smoke tests, Playwright journey tests.

## Global Constraints

- Preserve all existing Dashboard URLs, reply-draft behavior, and explicit authorization before any message send, résumé send, or application.
- Keep BOSS and Zhaopin browser work read-only, serial, background-only, and bound to the existing fixed communication tabs.
- Never use `Page.bringToFront` during message sync, detail reading, retry, recovery, or polling.
- First successful sync for each profile and platform must cover every loaded conversation active in the previous 72 hours, every unread conversation regardless of age, and every durable unresolved item.
- A sync may claim 72-hour coverage only after the reader proves it crossed the cutoff or reached the real end of the list; otherwise persist and display partial coverage.
- Keep item-local job-detail, identity, or analysis failures in the inbox and continue with later conversations; stop the platform only for login, risk control, tab/binding loss, browser transport failure, or uncertain cleanup.
- Preserve random pacing, cooldowns, site access budgets, checkpoints, and the one-background-transient-detail-tab rule.
- Do not add a framework, ORM, queue, service container, frontend framework, or runtime dependency.
- Do not change the existing SQLite data destructively; migration 32 must open old databases in place.
- Platform badges mean message channel. A BOSS conversation may never be joined to a Zhaopin job/card and vice versa.
- The normal acceptance path is the desktop shortcut and Dashboard UI. Scripts remain internal launch infrastructure.

---

## File Map

- `src/storage/schema.js`: define the durable inbox item and sync-state tables.
- `src/core/storage.js`: apply ordered schema migration 32 and expose compatibility exports.
- `src/storage/message_inbox_store.js`: validate, upsert, list, classify, and checkpoint inbox records.
- `src/adapters/browser/cdp.js`: expose background-safe page reload through CDP.
- `src/adapters/browser/edge_control.js`: expose the same reload contract through the Edge Control CDP bridge.
- `src/adapters/sites/boss_message_dom.js`: return BOSS conversation activity time and display identity.
- `src/adapters/sites/boss_message_reader.js`: reload the fixed tab, wait for a stable list, and prove initial coverage.
- `src/adapters/sites/zhaopin_message_reader.js`: reload the fixed tab, return `sendTime`, and prove initial coverage.
- `src/core/message_preview_state.js`: select unread, unresolved, first-use 72-hour, and changed conversations without replaying old resolved history.
- `src/core/message_discovery.js`: persist inbox projections, isolate item-local failures, and save sync checkpoints.
- `src/dashboard/message_discovery_controller.js`: load durable inbox/freshness state and pass it to the view.
- `src/dashboard/message_discovery_view.js`: replace platform/task filters with the four action groups and the approved detail hierarchy.
- `src/dashboard/assets/roleflow.css`: style the action inbox, freshness strip, groups, and detail panel.
- `tests/message_inbox_store_smoke.js`: verify storage invariants and projection behavior.
- Existing reader, discovery, Dashboard, migration, and journey smoke tests: cover compatibility and the new behavior.
- `tests/test_manifest.js`: add the new focused test to exactly one group.

### Task 1: Durable inbox storage and migration 32

**Files:**
- Modify: `src/storage/schema.js`
- Modify: `src/core/storage.js`
- Create: `src/storage/message_inbox_store.js`
- Create: `tests/message_inbox_store_smoke.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/test_manifest.js`

**Interfaces:**
- Produces: `upsertMessageInboxItem(db, input) -> InboxItem`
- Produces: `listMessageInboxItems(db, { profileId }) -> InboxItem[]`
- Produces: `getMessageInboxSyncState(db, { profileId, platform }) -> InboxSyncState | null`
- Produces: `saveMessageInboxSyncState(db, input) -> InboxSyncState`
- Produces: `markMessageInboxItemDone(db, key) -> boolean`

- [ ] **Step 1: Write the failing store and migration tests**

```js
const item = upsertMessageInboxItem(db, {
  profileId,
  platform: "boss",
  conversationKey: digest("conversation-1"),
  sourceJobId: "boss-job-1",
  lastMessageId: "message-1",
  lastActivityAt: "2026-09-17T02:00:00.000Z",
  lastDirection: "friend",
  unread: true,
  positionTitle: "产品经理",
  company: "示例公司",
  latestExcerpt: "方便聊聊吗？",
  actionGroup: "needs_action",
  actionCode: "reply",
  observedAt: "2026-09-17T02:01:00.000Z"
});
assert.equal(item.actionGroup, "needs_action");
assert.equal(listMessageInboxItems(db, { profileId }).length, 1);
assert.throws(() => upsertMessageInboxItem(db, { ...input, platform: "zhaopin", jobSource: "boss" }), /source/i);
```

The migration test must open a schema-31 fixture, migrate it to 32, confirm existing message rows remain readable, and confirm both new tables exist.

- [ ] **Step 2: Run the focused tests and confirm the missing schema/store failure**

Run: `node tests/message_inbox_store_smoke.js && node tests/storage_migration_smoke.js`

Expected: FAIL because `message_inbox_store.js` and migration 32 do not exist.

- [ ] **Step 3: Add the two focused tables and store implementation**

```sql
CREATE TABLE IF NOT EXISTS message_inbox_items (
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('boss','zhaopin')),
  conversation_key TEXT NOT NULL,
  source_job_id TEXT NOT NULL DEFAULT '',
  job_id INTEGER,
  card_id INTEGER,
  last_message_id TEXT NOT NULL DEFAULT '',
  last_activity_at TEXT NOT NULL,
  last_direction TEXT NOT NULL CHECK(last_direction IN ('friend','myself','platform','unknown')),
  unread INTEGER NOT NULL DEFAULT 0 CHECK(unread IN (0,1)),
  position_title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  latest_excerpt TEXT NOT NULL DEFAULT '',
  action_group TEXT NOT NULL CHECK(action_group IN ('needs_action','waiting','needs_review','done')),
  action_code TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL DEFAULT '',
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(profile_id, platform, conversation_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS message_inbox_sync_states (
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('boss','zhaopin')),
  last_attempted_at TEXT NOT NULL,
  last_successful_at TEXT,
  coverage_start_at TEXT,
  coverage_complete INTEGER NOT NULL DEFAULT 0 CHECK(coverage_complete IN (0,1)),
  watermark_at TEXT,
  stop_code TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(profile_id, platform),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id) ON DELETE CASCADE
);
```

The store must reject cross-platform `jobSource`, preserve `first_observed_at` on conflict, update mutable preview fields, clear `resolved_at` when an item becomes active again, and order rows by action group then newest activity.

- [ ] **Step 4: Run focused tests and manifest consistency**

Run: `node tests/message_inbox_store_smoke.js && node tests/storage_migration_smoke.js && node tests/test_manifest_smoke.js`

Expected: PASS; schema version is 32 and the new test belongs to `integration` only.

- [ ] **Step 5: Commit the storage slice**

```powershell
git add src/storage/schema.js src/core/storage.js src/storage/message_inbox_store.js tests/message_inbox_store_smoke.js tests/storage_migration_smoke.js tests/test_manifest.js
git commit -m "feat: add durable message inbox storage"
```

### Task 2: Refresh fixed message tabs and expose reliable activity time

**Files:**
- Modify: `src/adapters/browser/cdp.js`
- Modify: `src/adapters/browser/edge_control.js`
- Modify: `src/adapters/sites/boss_message_dom.js`
- Modify: `src/adapters/sites/boss_message_reader.js`
- Modify: `src/adapters/sites/zhaopin_message_reader.js`
- Modify: `tests/browser_transport_smoke.js`
- Modify: `tests/boss_message_reader_smoke.js`
- Modify: `tests/zhaopin_message_reader_smoke.js`

**Interfaces:**
- Produces: `browser.reload(tabId) -> Promise<void>` using `Page.reload` without foreground activation.
- Produces: `reader.scanConversationRows(signal, { cutoffAt }) -> { tabId, rows, coverage }`.
- `coverage`: `{ complete: boolean, oldestActivityAt: string | null, cutoffAt: string | null }`.
- Each row adds: `lastActivityAt`, `positionTitle`, and `company` while keeping all existing fields.

- [ ] **Step 1: Add failing adapter and reader tests**

```js
await browser.reload(12);
assert.deepEqual(sentCommands.at(-1), ["Page.reload", { ignoreCache: false }]);

const scan = await reader.scanConversationRows(undefined, {
  cutoffAt: "2026-09-14T02:00:00.000Z"
});
assert.equal(scan.rows[0].lastActivityAt, "2026-09-17T01:59:00.000Z");
assert.equal(scan.coverage.complete, true);
assert.equal(focusChanges, 0);
```

BOSS fixtures must derive the timestamp from `lastTS` with `updateTime` fallback. Zhaopin fixtures must derive it from `sendTime`. Invalid or absent timestamps remain `null` and may never prove the 72-hour boundary.

- [ ] **Step 2: Run reader tests and verify they fail on missing reload/coverage**

Run: `node tests/browser_transport_smoke.js && node tests/boss_message_reader_smoke.js && node tests/zhaopin_message_reader_smoke.js`

Expected: FAIL on the new `reload`, `lastActivityAt`, or `coverage` assertions.

- [ ] **Step 3: Implement background-safe refresh and stable-list waiting**

```js
async reload(tabId) {
  return this.cdp(tabId, "Page.reload", { ignoreCache: false });
}
```

For each reader: resolve and capture the fixed-tab binding, call `setPageLifecycleActive`, call `reload`, wait for the platform-specific ready list, re-check the same typed tab binding, then take the snapshot. Do not call `bringToFront`, create a new tab, or click a conversation during refresh.

- [ ] **Step 4: Implement coverage proof without reducing quality**

Readers must inspect the loaded rows from newest to oldest. If the oldest reliable timestamp is newer than `cutoffAt` and the list can load more, scroll the platform list container once, wait for either an increased row count or an end marker, re-check the fixed-tab binding, and repeat serially. Stop with `coverage.complete=true` only when the oldest reliable activity is at or before the cutoff or the platform proves there are no older rows. Abort/risk/login/tab-loss behavior remains terminal and existing pacing remains active.

- [ ] **Step 5: Run reader tests**

Run: `node tests/browser_transport_smoke.js && node tests/boss_message_reader_smoke.js && node tests/zhaopin_message_reader_smoke.js`

Expected: PASS, including no foreground change and partial coverage when timestamps or list completion cannot be proved.

- [ ] **Step 6: Commit the reader slice**

```powershell
git add src/adapters/browser/cdp.js src/adapters/browser/edge_control.js src/adapters/sites/boss_message_dom.js src/adapters/sites/boss_message_reader.js src/adapters/sites/zhaopin_message_reader.js tests/browser_transport_smoke.js tests/boss_message_reader_smoke.js tests/zhaopin_message_reader_smoke.js
git commit -m "feat: refresh message tabs before discovery"
```

### Task 3: First-use 72-hour queueing and durable sync checkpoints

**Files:**
- Modify: `src/core/message_preview_state.js`
- Modify: `src/core/message_discovery.js`
- Modify: `tests/message_preview_state_smoke.js`
- Modify: `tests/message_discovery_smoke.js`
- Modify: `tests/zhaopin_message_discovery_smoke.js`

**Interfaces:**
- Consumes: Task 1 inbox store and Task 2 reader coverage.
- Modifies: `planMessageDiscoveryQueue({ rows, baselines, unresolved, firstSync, cutoffAt })`.
- Produces: discovery result fields `coverage`, `syncState`, `continuedFailures`, while preserving existing result fields.

- [ ] **Step 1: Add failing queue-policy tests**

```js
const plan = planMessageDiscoveryQueue({
  firstSync: true,
  cutoffAt: "2026-09-14T02:00:00.000Z",
  rows: [recentIncoming, recentOutgoing, oldUnread, oldReadIncoming],
  baselines: new Map(),
  unresolved: new Map()
});
assert.deepEqual(plan.queue.map(item => item.conversationKey), [
  recentIncoming.conversationKey,
  recentOutgoing.conversationKey,
  oldUnread.conversationKey
]);
assert.equal(plan.queue.some(item => item.conversationKey === oldReadIncoming.conversationKey), false);
```

Add a second test showing a subsequent sync queues only unread, durable unresolved, or changed previews and does not replay unchanged 72-hour history.

- [ ] **Step 2: Run queue and discovery tests and confirm policy failures**

Run: `node tests/message_preview_state_smoke.js && node tests/message_discovery_smoke.js && node tests/zhaopin_message_discovery_smoke.js`

Expected: FAIL because first-sync and cutoff semantics are absent.

- [ ] **Step 3: Implement first-sync selection and inbox projection**

Queue priority must be: unread, durable unresolved, recent first-sync activity, changed preview. Recent first-sync activity includes both `friend` and `myself`; outgoing rows become `waiting` instead of generating a reply draft. Persist every in-scope row into `message_inbox_items`, including rows that need no detail read. Existing preview baselines remain the change detector and are not removed.

- [ ] **Step 4: Save honest per-platform checkpoints**

At run start, read the platform sync state and compute `firstSync = !lastSuccessfulAt`. Use `cutoffAt = runStartedAt - 72 hours` only for first sync. After the scan:

```js
saveMessageInboxSyncState(db, {
  profileId,
  platform,
  lastAttemptedAt: runStartedAt,
  lastSuccessfulAt: coverage.complete ? completedAt : previous?.lastSuccessfulAt,
  coverageStartAt: firstSync ? cutoffAt : previous?.coverageStartAt,
  coverageComplete: coverage.complete,
  watermarkAt: newestReliableActivityAt,
  stopCode: coverage.complete ? "" : "MESSAGE_COVERAGE_PARTIAL"
});
```

A partial run may persist item checkpoints but must not become the first successful sync.

- [ ] **Step 5: Run queue, discovery, and storage tests**

Run: `node tests/message_preview_state_smoke.js && node tests/message_discovery_smoke.js && node tests/zhaopin_message_discovery_smoke.js && node tests/message_inbox_store_smoke.js`

Expected: PASS; old read history is not replayed, recent outgoing appears as waiting, and partial coverage remains partial.

- [ ] **Step 6: Commit the sync slice**

```powershell
git add src/core/message_preview_state.js src/core/message_discovery.js tests/message_preview_state_smoke.js tests/message_discovery_smoke.js tests/zhaopin_message_discovery_smoke.js
git commit -m "feat: sync recent conversations into inbox"
```

### Task 4: Continue after item-local context failures

**Files:**
- Modify: `src/core/message_discovery.js`
- Modify: `src/application/message_discovery/job_context.js`
- Modify: `src/application/message_discovery/zhaopin_job_context.js`
- Modify: `tests/message_discovery_smoke.js`
- Modify: `tests/zhaopin_message_discovery_smoke.js`
- Modify: `tests/zhaopin_message_job_context_smoke.js`

**Interfaces:**
- Consumes: Task 1 inbox store.
- Produces: `isPlatformTerminalFailure(error) -> boolean` limited to account/session/browser safety failures.
- Produces: item-local failures as durable `needs_review` inbox items while later queue entries continue.

- [ ] **Step 1: Replace the old terminal-failure assertions with failing isolation tests**

```js
const result = await runMessageDiscovery({
  rows: [mismatchedDetailRow, validLaterRow],
  resolveJobContext: async target => {
    if (target.conversationKey === mismatchedDetailRow.conversationKey) {
      throw coded("ZHAOPIN_MESSAGE_DETAIL_TARGET_MISMATCH");
    }
    return validContext;
  }
});
assert.equal(result.stopped, false);
assert.equal(result.continuedFailures.length, 1);
assert.equal(result.items.some(item => item.conversationKey === validLaterRow.conversationKey), true);
```

Retain separate tests proving login, risk control, fixed-tab loss, browser disconnect, and uncertain transient-tab cleanup still stop immediately.

- [ ] **Step 2: Run focused discovery tests and verify the current whole-platform stop**

Run: `node tests/message_discovery_smoke.js && node tests/zhaopin_message_discovery_smoke.js && node tests/zhaopin_message_job_context_smoke.js`

Expected: FAIL because detail mismatch currently stops the platform.

- [ ] **Step 3: Narrow terminal codes and persist local failures**

Remove job-not-found, job-ambiguous, target-mismatch, detail-incomplete, analysis-incomplete, and draft-generation failures from the terminal set. For those failures: preserve the unresolved payload, upsert the inbox item with `actionGroup: "needs_review"`, record a user-facing reason, checkpoint it, apply normal pacing, and continue. Do not retry an ambiguous read or silently bind to a different job.

- [ ] **Step 4: Keep automatic context recovery inside the message flow**

Both platform context resolvers must continue to prefer a complete trusted cached JD. When no complete local JD exists, use the existing approved guarded detail-read path, analyze it, and resume draft generation. Do not redirect the user to Today Task. Enforce `job.source === platform` and `card.source === platform` before returning a context.

- [ ] **Step 5: Run focused discovery tests**

Run: `node tests/message_discovery_smoke.js && node tests/zhaopin_message_discovery_smoke.js && node tests/zhaopin_message_job_context_smoke.js`

Expected: PASS; item failures remain visible and later conversations are processed, while safety failures still stop.

- [ ] **Step 6: Commit the fault-isolation slice**

```powershell
git add src/core/message_discovery.js src/application/message_discovery/job_context.js src/application/message_discovery/zhaopin_job_context.js tests/message_discovery_smoke.js tests/zhaopin_message_discovery_smoke.js tests/zhaopin_message_job_context_smoke.js
git commit -m "fix: isolate message context failures"
```

### Task 5: Project the durable inbox into four user actions

**Files:**
- Modify: `src/storage/message_inbox_store.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `tests/message_inbox_store_smoke.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`

**Interfaces:**
- Produces: `buildMessageInboxPageState(db, { profileId, platformRuns, now })`.
- Returns: `{ groups, freshness, counts }` where groups are `needsAction`, `waiting`, `needsReview`, and `done`.

- [ ] **Step 1: Add failing projection tests**

```js
const state = buildMessageInboxPageState(db, { profileId, now: fixedNow });
assert.equal(state.groups.needsAction[0].primaryAction.label, "查看建议回复");
assert.equal(state.groups.waiting[0].statusText, "已回复，等待对方消息");
assert.equal(state.groups.needsReview[0].technicalReason, undefined);
assert.equal(state.freshness.boss.label, "刚刚同步");
assert.equal(state.counts.total, 4);
```

Test that existing inbound contexts, drafts, classified events, and unresolved items still appear even before every row has been backfilled into the new table.

- [ ] **Step 2: Run the store and controller tests and confirm the missing page-state failure**

Run: `node tests/message_inbox_store_smoke.js && node tests/dashboard_message_discovery_smoke.js`

Expected: FAIL because the action-group projection does not exist.

- [ ] **Step 3: Implement compatible projection and user-facing copy**

`buildMessageInboxPageState` must merge the new inbox table with existing linked inbound contexts, drafts, completed progress events, and unresolved records using `(profileId, platform, conversationKey)` as the durable key. Prefer the newest activity, never duplicate one conversation across groups, and map internal errors to concrete user text such as “岗位资料暂时无法确认，系统会在下次同步时重试。”

Freshness must distinguish: syncing, fully synced, partially synced, login required, risk control, and browser unavailable. It must not expose internal error codes.

- [ ] **Step 4: Run the store and controller tests**

Run: `node tests/message_inbox_store_smoke.js && node tests/dashboard_message_discovery_smoke.js`

Expected: PASS with no platform filter required to see either source.

- [ ] **Step 5: Commit the projection slice**

```powershell
git add src/storage/message_inbox_store.js src/dashboard/message_discovery_controller.js tests/message_inbox_store_smoke.js tests/dashboard_message_discovery_smoke.js
git commit -m "feat: project message action inbox"
```

### Task 6: Replace the message page with the approved action inbox

**Files:**
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/dashboard_unified_messages_journey.js`

**Interfaces:**
- Consumes: Task 5 page state.
- Preserves: existing draft-edit, batch-selection, explicit-confirmation, send-progress, and immutable-batch endpoints.

- [ ] **Step 1: Rewrite the journey assertions before the view**

```js
await expect(page.getByRole("heading", { name: "现在需要你处理" })).toBeVisible();
await expect(page.getByRole("heading", { name: "等待对方回复" })).toBeVisible();
await expect(page.getByRole("heading", { name: "系统暂时无法完成" })).toBeVisible();
await expect(page.getByLabel("消息来源")).toHaveCount(0);
await expect(page.getByLabel("处理类型")).toHaveCount(0);
await expect(page.getByText("BOSS", { exact: true })).toBeVisible();
await expect(page.getByText("智联", { exact: true })).toBeVisible();
```

Add detail-order assertions: job header, latest HR message, OfferGo judgment, editable draft, action button; full chat and full job analysis remain folded by default.

- [ ] **Step 2: Run Dashboard tests and verify the old filters/layout fail**

Run: `node tests/dashboard_message_discovery_smoke.js && node tests/dashboard_unified_messages_journey.js`

Expected: FAIL because the current page still requires source/task filtering and uses the old detail hierarchy.

- [ ] **Step 3: Render the four action groups**

Render `现在需要你处理`, `等待对方回复`, `系统暂时无法完成`, and collapsed `已经处理`. Each list row shows job/company, message-channel badge, last activity time, latest HR line or waiting text, and one clear next action. The selected row opens the matching detail panel without changing the active browser platform.

- [ ] **Step 4: Render the approved detail hierarchy and preserve send safety**

The visible order is: job/header, latest HR message, short OfferGo judgment, editable draft, action. Keep full chat, full job analysis, and alternate drafts inside folded `<details>` sections. Draft editing and batch selection keep their existing server contracts. No action is sent merely by opening, selecting, or editing an item.

- [ ] **Step 5: Add responsive styling and accessibility states**

Use existing design tokens. Add visible selected/focus states, count badges, platform badges, readable empty states, and a mobile single-column layout. Do not encode status by color alone; every badge also carries text.

- [ ] **Step 6: Run Dashboard tests**

Run: `node tests/dashboard_message_discovery_smoke.js && node tests/dashboard_unified_messages_journey.js`

Expected: PASS through the normal HTTP page flow, including reload, selection persistence, draft edits, and no accidental send.

- [ ] **Step 7: Commit the UI slice**

```powershell
git add src/dashboard/message_discovery_view.js src/dashboard/assets/roleflow.css tests/dashboard_message_discovery_smoke.js tests/dashboard_unified_messages_journey.js
git commit -m "feat: redesign messages as action inbox"
```

### Task 7: Full regression gate and desktop acceptance environment

**Files:**
- Modify only if failures reveal a real regression: affected production/test files.
- Update: acceptance runtime under `D:\Apps\OfferGo-Acceptance-<timestamp>` after the commit is frozen.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: an exact-SHA tested build and a desktop acceptance flow.

- [ ] **Step 1: Run the fast gate**

Run: `npm run test:fast`

Expected: all fast checks pass.

- [ ] **Step 2: Run the integration gate**

Run: `npm run test:integration`

Expected: all integration checks pass, including both platform message readers and the unified inbox journey.

- [ ] **Step 3: Run package checks**

Run: `npm run test:package`

Expected: packaging and runtime-path checks pass without placing large generated data on `C:`.

- [ ] **Step 4: Run the complete offline gate and freeze the commit**

Run: `npm test`

Expected: every manifest check passes once. Commit any justified fix, record `git rev-parse HEAD`, then rerun `npm test` against that exact unchanged SHA.

- [ ] **Step 5: Create a clean acceptance runtime on D: and open the software**

Build/copy the frozen commit to a new `D:\Apps\OfferGo-Acceptance-<timestamp>` directory, preserve the user's existing `%LOCALAPPDATA%\RoleFlow` compatible data, update the `OfferGo` desktop shortcut, and start the workspace normally. The user should see the Dashboard, not a batch file or terminal workflow.

- [ ] **Step 6: Perform read-only UI acceptance**

From the Dashboard, open the unified message inbox and start one sync. Verify both fixed message tabs refresh in the background, the UI shows both channel badges without a filter, recent/waiting/problem groups render, and an item-local mismatch does not block later items. Do not confirm or execute a real reply, résumé send, or application.

- [ ] **Step 7: Record acceptance evidence**

Record the frozen SHA, acceptance directory, desktop shortcut target, Dashboard URL, sync freshness shown for each platform, read-only result counts, and any remaining item-local entries. Do not save private message contents, cookies, résumé text, or model keys in Git or reports.

