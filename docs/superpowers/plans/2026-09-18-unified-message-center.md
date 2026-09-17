# OfferGo Unified Message Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OfferGo the complete text-and-action message workspace for BOSS and Zhaopin, with a three-day initial sync, full local timelines, in-app replies, verified platform actions, and no message-level instruction to return to either platform.

**Architecture:** Keep the existing Node.js CommonJS modular monolith, Dashboard, CDP browser adapters, and SQLite stores. Add one durable message-event ledger behind the existing inbox index, normalize both platform readers into the same event contract, keep job enrichment asynchronous, and route confirmed writes to platform-specific senders through the existing serial/idempotent executor pattern.

**Tech Stack:** Node.js 22, CommonJS, built-in `node:assert`, native SQLite, server-rendered HTML, the existing CDP adapter, PowerShell, Inno Setup 6.

## Global Constraints

- Do not add a runtime dependency, ORM, frontend framework, queue, service container, or microservice.
- Preserve `/messages`, existing Dashboard navigation, existing user data, and `%LOCALAPPDATA%\RoleFlow` compatibility.
- Initial sync covers the most recent 72 hours or the platform's reachable end, then uses durable incremental watermarks.
- Process BOSS and Zhaopin serially. Process one conversation at a time with a nonzero randomized delay; never introduce parallel conversation reads.
- Keep the BOSS fixed-tab and background-operation safety rules. Never use `Page.bringToFront` during message discovery or sending.
- `_security_check` in a URL is diagnostic evidence only. Only a live page state can declare login or risk control.
- Store and show text and verified platform action cards. Record only a placeholder for voice, image, and attachment messages; do not download or analyze them.
- Persist a message before job enrichment. Missing job details may reduce analysis quality but must not hide the message or require the user to open a platform message page.
- Never send or click an external action without confirmation for the concrete immutable item or batch. Never retry an uncertain click.
- Real-platform probes must redact private message text, identifiers, cookies, and model secrets from logs and committed fixtures.
- Each task ends with its focused checks and a commit. Run the full offline gate only after the focused checks pass.

## File Structure

### New files

- `src/adapters/sites/boss_page_state.js`: one live BOSS page-state probe shared by scanning and message discovery.
- `src/storage/message_timeline_store.js`: durable message-event writes and timeline queries.
- `src/adapters/sites/zhaopin_message_reply_sender.js`: verified Zhaopin text-reply adapter.
- `src/storage/message_action_store.js`: durable non-text platform-action ownership and result records.
- `src/application/message_actions/index.js`: confirm, execute, stop, and query one platform-card action.
- `src/dashboard/message_action_controller.js`: Dashboard boundary for platform-card actions.
- `src/adapters/sites/boss_message_action_sender.js`: verified BOSS action-card adapter for observed controls.
- `src/adapters/sites/zhaopin_message_action_sender.js`: verified Zhaopin action-card adapter for observed controls.
- `tests/boss_page_state_smoke.js`: live-state classification without URL-only risk inference.
- `tests/message_timeline_store_smoke.js`: migration, deduplication, ordering, and ownership checks.
- `tests/zhaopin_message_reply_sender_smoke.js`: target, fill, one-click, verify, and ambiguity behavior.
- `tests/message_platform_action_smoke.js`: durable action idempotency and fake-browser sender checks.

### Existing files with focused changes

- `src/adapters/sites/boss.js`: replace its duplicated page-health expression with `boss_page_state.js`.
- `src/dashboard/message_discovery_controller.js`: inspect live BOSS state and expose timelines/action state.
- `src/adapters/sites/boss_message_dom.js`: normalize supported BOSS event kinds without allowing media to block text.
- `src/adapters/sites/boss_message_reader.js`: return the complete normalized selected timeline.
- `src/adapters/sites/zhaopin_message_reader.js`: support observed `303`, `346`, and action-card shapes.
- `src/core/message_discovery.js`: persist selected events before job enrichment and process actionable subsets.
- `src/application/message_discovery/run.js`: inject the timeline store.
- `src/application/message_inbox/index.js`: expose timeline reads used by the Dashboard.
- `src/storage/schema.js`, `src/core/storage.js`: ordered schema versions 33-35.
- `src/storage/message_reply_send_store.js`: freeze a platform with each reply item and allow BOSS or Zhaopin ownership.
- `src/core/message_reply_send_batches.js`, `src/core/message_reply_send_executor.js`: carry platform-neutral status/evidence.
- `src/dashboard/message_reply_send_controller.js`: acquire the correct site lease and construct the correct sender.
- `src/dashboard/message_discovery_view.js`: render complete timelines, a shared reply composer, and action buttons.
- `src/dashboard/server.js`: register the message-action endpoints and inject their controller.
- Existing message, migration, Dashboard, and integration tests listed in the tasks below.
- `tests/test_manifest.js`: add exactly four new smoke files to `all` and `integration`.

---

### Task 1: Replace URL-only BOSS risk detection with live page state

**Files:**
- Create: `src/adapters/sites/boss_page_state.js`
- Create: `tests/boss_page_state_smoke.js`
- Modify: `src/adapters/sites/boss.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `tests/dashboard_unified_messages_journey.js`
- Modify: `tests/test_manifest.js`

**Interfaces:**
- Produces: `inspectBossPageState(browser, tabId) -> Promise<{ state, url, isSearchPage, hasJobStructure }>`.
- Produces: `inspectBossSessionState(browser, tabs) -> Promise<{ riskControl, loginRequired, healthyTabIds }>`.
- Consumes later: message discovery uses this result before constructing a BOSS reader.

- [ ] **Step 1: Write the failing page-state and controller tests**

Add fixtures proving that the query parameter alone is harmless and live evidence remains terminal:

```js
assert.equal(normalizeBossPageState({
  url: "https://www.zhipin.com/web/geek/jobs?_security_check=stale",
  path: "/web/geek/jobs",
  isBoss: true,
  isLoginPage: false,
  isRiskPage: false,
  hasUserSurface: true,
  hasJobStructure: true
}).state, "ready");

assert.equal(normalizeBossPageState({
  url: "https://www.zhipin.com/web/passport/zp/verify",
  path: "/web/passport/zp/verify",
  isBoss: true,
  isLoginPage: false,
  isRiskPage: true,
  hasUserSurface: false,
  hasJobStructure: false
}).state, "risk_control");
```

Extend the unified journey so `boss + stale_security_query + zhaopin` calls both readers, while `boss + actual_risk_dom + zhaopin` skips only BOSS.

- [ ] **Step 2: Run the focused tests and confirm the regression fails**

Run:

```powershell
node tests/boss_page_state_smoke.js
node tests/dashboard_unified_messages_journey.js
```

Expected: the new smoke file cannot import `boss_page_state.js`, and the existing controller still returns `BOSS_RISK_CONTROL` for the healthy stale URL.

- [ ] **Step 3: Implement one shared live-state probe**

Export this surface from `boss_page_state.js`:

```js
const BOSS_PAGE_STATE_EXPRESSION = String.raw`(() => {
  const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 3000);
  const path = location.pathname;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const hasVisibleLoginForm = [...document.querySelectorAll(
    ".sign-form,.login-register,[class*='login-form']"
  )].some(visible);
  const isLoginPage = /\/web\/user\//i.test(path) || hasVisibleLoginForm
    || /没有更多职位.{0,20}登录查看全部职位|登录后可查看/.test(bodyText);
  const isRiskPage = /\/web\/passport\/zp\/(?:verify|403)/i.test(path)
    || new URLSearchParams(location.search).get("code") === "32"
    || /安全验证|访问异常|行为验证|访问受限/.test(document.title || "")
    || /账户存在异常行为|暂时无法访问此页面|请勿频繁提交刷新请求/.test(bodyText);
  const hasUserSurface = Boolean(document.querySelector(
    ".nav-figure,.user-nav,[ka='header-personal'],[ka='header-username'],[class*='user-nav']"
  ));
  const hasJobStructure = Boolean(document.querySelector(
    ".job-list-container,.rec-job-list,.job-card-box,.job-detail-container"
  ));
  return {
    url: location.href,
    path,
    isBoss: /(^|\.)zhipin\.com$/i.test(location.hostname),
    isLoginPage,
    isRiskPage,
    hasUserSurface,
    hasJobStructure
  };
})()`;

async function inspectBossPageState(browser, tabId) {
  return normalizeBossPageState(await browser.evalValue(tabId, BOSS_PAGE_STATE_EXPRESSION));
}
```

Delete the duplicated expression from `boss.js`; do not leave two versions. `normalizeBossPageState` must reject malformed probes as `BOSS_PAGE_STATE_INVALID`.

In the controller, await `inspectBossSessionState` after `listTabs()`. Remove `isBossRiskControlUrl`. A healthy message tab plus a healthy stale-query job tab is connected; any live `risk_control` tab in the same BOSS session remains terminal.

- [ ] **Step 4: Run focused and architecture checks**

Run:

```powershell
node tests/boss_page_state_smoke.js
node tests/dashboard_unified_messages_journey.js
node tests/browser_readiness_smoke.js
npm run test:fast
```

Expected: all pass; the new test is registered once and the test-manifest consistency check remains green.

- [ ] **Step 5: Commit the BOSS state fix**

```powershell
git add src/adapters/sites/boss_page_state.js src/adapters/sites/boss.js src/dashboard/message_discovery_controller.js tests/boss_page_state_smoke.js tests/dashboard_unified_messages_journey.js tests/test_manifest.js
git commit -m "fix(messages): verify live BOSS risk state"
```

---

### Task 2: Add the durable message timeline

**Files:**
- Create: `src/storage/message_timeline_store.js`
- Create: `tests/message_timeline_store_smoke.js`
- Modify: `src/storage/schema.js`
- Modify: `src/core/storage.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/message_inbox_store_smoke.js`
- Modify: `tests/test_manifest.js`

**Interfaces:**
- Produces: `upsertMessageEvents(db, input) -> MessageEvent[]`.
- Produces: `listMessageEvents(db, { profileId, platform, conversationKey, limit }) -> MessageEvent[]`.
- Produces: `latestMessageEvent(...) -> MessageEvent | null`.
- Event kind is one of `text`, `platform_notice`, `resume_request`, `interview_invitation`, `contact_exchange`, `media_ignored`, `unknown_card`.

- [ ] **Step 1: Write failing migration and store tests**

Test schema version 33 and exact idempotency:

```js
const inserted = upsertMessageEvents(db, {
  profileId,
  platform: "zhaopin",
  conversationKey,
  observedAt: "2026-09-18T01:00:00.000Z",
  events: [{
    messageKey: digest("message-1"),
    platformMessageId: "101",
    direction: "friend",
    kind: "text",
    text: "方便沟通吗？",
    occurredAt: "2026-09-18T00:59:00.000Z",
    metadata: { cardType: "" }
  }]
});
assert.equal(inserted.length, 1);
upsertMessageEvents(db, { /* same identity, later observedAt */ });
assert.equal(listMessageEvents(db, { profileId, platform: "zhaopin", conversationKey }).length, 1);
```

Also test ordering, cross-profile isolation, malformed digests, unknown-card metadata size limits, and media placeholders with empty text.

- [ ] **Step 2: Run the store tests and confirm failure**

Run:

```powershell
node tests/message_timeline_store_smoke.js
node tests/storage_migration_smoke.js
```

Expected: missing store/schema assertions fail before implementation.

- [ ] **Step 3: Add schema version 33 and the focused store**

Add this table to `schema.js` and migration 33 in `core/storage.js`:

```sql
CREATE TABLE IF NOT EXISTS message_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('boss','zhaopin')),
  conversation_key TEXT NOT NULL,
  message_key TEXT NOT NULL,
  platform_message_id TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK(direction IN ('friend','myself','platform','unknown')),
  kind TEXT NOT NULL CHECK(kind IN (
    'text','platform_notice','resume_request','interview_invitation',
    'contact_exchange','media_ignored','unknown_card'
  )),
  text TEXT NOT NULL DEFAULT '',
  occurred_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  UNIQUE(profile_id, platform, conversation_key, message_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_message_events_timeline
  ON message_events(profile_id, platform, conversation_key, occurred_at, id);
```

Implement bulk upsert inside one `immediateTransaction`. Preserve `first_observed_at`, update only `last_observed_at` and safe metadata, cap text at 4,000 characters and serialized metadata at 2,000 characters.

- [ ] **Step 4: Run focused storage checks**

```powershell
node tests/message_timeline_store_smoke.js
node tests/message_inbox_store_smoke.js
node tests/storage_migration_smoke.js
npm run test:fast
```

Expected: schema version 33 opens old databases through one backed-up ordered migration; duplicate events remain one row.

- [ ] **Step 5: Commit the timeline store**

```powershell
git add src/storage/message_timeline_store.js src/storage/schema.js src/core/storage.js tests/message_timeline_store_smoke.js tests/storage_migration_smoke.js tests/message_inbox_store_smoke.js tests/test_manifest.js
git commit -m "feat(messages): persist complete conversation timelines"
```

---

### Task 3: Normalize all current text and action-card message shapes

**Files:**
- Modify: `src/adapters/sites/boss_message_dom.js`
- Modify: `src/adapters/sites/boss_message_reader.js`
- Modify: `src/adapters/sites/zhaopin_message_reader.js`
- Modify: `src/core/message_discovery.js`
- Modify: `tests/boss_message_dom_smoke.js`
- Modify: `tests/boss_message_reader_smoke.js`
- Modify: `tests/zhaopin_message_reader_smoke.js`
- Modify: `tests/message_discovery_smoke.js`

**Interfaces:**
- Produces from both readers: `selected.messages[]` containing `{ messageId, messageKey, direction, contentKind, text, occurredAt, metadata }`.
- `contentKind` uses the Task 2 event-kind names.
- Consumes later: timeline persistence and action-card rendering.

- [ ] **Step 1: Extend fixtures with the observed live structures**

Add fixture DOM for Zhaopin `303` and `346` without copying real message content:

```js
message({ idServer: "105", type: "custom", cardType: "303", body: "合成富文本" }),
message({ idServer: "106", type: "custom", cardType: "346", body: "合成平台提示", tip: true })
```

Render `303` through `.im-msg-rich` and `346` through `.im-msg-346__text`. Add a BOSS sequence containing text, voice, text, and a resume request. Assert the two text messages and action survive while voice becomes one `media_ignored` event.

- [ ] **Step 2: Run parser tests and confirm failure**

```powershell
node tests/zhaopin_message_reader_smoke.js
node tests/boss_message_dom_smoke.js
node tests/message_discovery_smoke.js
```

Expected: Zhaopin `303`/`346` are unsupported and the BOSS media item currently rejects the actionable group.

- [ ] **Step 3: Implement the normalized mapping**

Use these mappings:

```js
const zhaopinCardKinds = Object.freeze({
  "11": "resume_request",
  "131": "text",
  "303": "text",
  "346": "platform_notice",
  "255": "platform_notice"
});
```

For `303`, require `.im-msg-rich` text to equal the Vue message body after whitespace folding. For `346`, read only `.im-msg-346__text`, require `tip === true`, and classify it as `platform_notice`. Do not accept a body string that is not represented by the verified DOM.

Map BOSS voice, image, and attachment nodes to `media_ignored` with empty text and metadata `{ mediaKind }`. `message_timeline_store` receives `kind: message.contentKind`. Change `selectUnprocessedFriendMessageGroup` so it:

```js
const actionable = unprocessed.filter((item) => [
  "text", "resume_request", "interview_invitation", "contact_exchange"
].includes(item.contentKind));
const ignored = unprocessed.filter((item) => ["platform_notice", "media_ignored"].includes(item.contentKind));
const unknown = unprocessed.filter((item) => item.contentKind === "unknown_card");
```

It must return all three groups for Task 4 persistence, generate drafts/actions only from `actionable`, and report platform sync incomplete only when `unknown.length > 0`. It must never erase or reject recognized text because another event is media or unknown.

- [ ] **Step 4: Run parser and discovery checks**

```powershell
node tests/zhaopin_message_reader_smoke.js
node tests/boss_message_dom_smoke.js
node tests/boss_message_reader_smoke.js
node tests/message_discovery_smoke.js
npm run test:fast
```

Expected: current synthetic `303`, `346`, resume-request, text, and media sequences normalize deterministically with no real content in fixtures.

- [ ] **Step 5: Commit reader coverage**

```powershell
git add src/adapters/sites/boss_message_dom.js src/adapters/sites/boss_message_reader.js src/adapters/sites/zhaopin_message_reader.js src/core/message_discovery.js tests/boss_message_dom_smoke.js tests/boss_message_reader_smoke.js tests/zhaopin_message_reader_smoke.js tests/message_discovery_smoke.js
git commit -m "feat(messages): normalize current platform message cards"
```

---

### Task 4: Persist timelines before job enrichment and complete the 72-hour sync

**Files:**
- Modify: `src/application/message_discovery/run.js`
- Modify: `src/application/message_inbox/index.js`
- Modify: `src/core/message_discovery.js`
- Modify: `src/adapters/sites/boss_message_reader.js`
- Modify: `src/adapters/sites/zhaopin_message_reader.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `tests/message_discovery_smoke.js`
- Modify: `tests/zhaopin_message_discovery_smoke.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/dashboard_unified_messages_journey.js`

**Interfaces:**
- Consumes: Task 2 `upsertMessageEvents` and `listMessageEvents`.
- Produces: `runBossMessageDiscovery` always persists a selected timeline before `resolveJobContext`.
- Produces: platform sync state with `coverageStartAt`, `coverageComplete`, `watermarkAt`, and internal `stopCode`.

- [ ] **Step 1: Write failing ordering, recovery, and coverage tests**

Record call order in `message_discovery_smoke.js`:

```js
assert.deepEqual(callOrder, [
  "open-conversation",
  "persist-events",
  "resolve-job-context",
  "classify-and-draft"
]);
```

Make `resolveJobContext` throw `ZHAOPIN_MESSAGE_DETAIL_TARGET_UNAVAILABLE`, then assert the timeline still contains the HR text and the inbox item is visible with job status `unavailable` rather than a manual-platform task.

Add first-sync rows spanning 80 hours and assert the reader requests/loads additional list pages until `oldestActivityAt <= cutoffAt`. Add a restart after half the queue and assert completed conversations are not opened again.

- [ ] **Step 2: Run the discovery tests and confirm failure**

```powershell
node tests/message_discovery_smoke.js
node tests/zhaopin_message_discovery_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: current code attempts job context before durable timeline persistence and still surfaces job-context failures as user work.

- [ ] **Step 3: Inject the timeline port and persist first**

In `application/message_discovery/run.js`:

```js
const messageTimeline = require("../../storage/message_timeline_store");

return coreDiscovery.runBossMessageDiscovery({
  ...options,
  messageInbox: options.messageInbox || messageInbox,
  messageTimeline: options.messageTimeline || messageTimeline
});
```

In the core run loop, after `openQueuedConversation` returns and before any detail/JD work, map and upsert every selected message. Update the inbox from the latest persisted event. Job-enrichment failure sets `jobContextStatus: "unavailable"` in display state and may produce a conservative draft from verified résumé facts plus message text.

Remove the message-level copy and state that says the user must visit the original platform. Keep an internal unknown-card stop code only at platform-sync level.

- [ ] **Step 4: Extend both readers to the 72-hour boundary**

Keep the existing `scanConversationRows(signal, { cutoffAt })` interface. Inside each platform adapter, load additional conversation rows only while all are true:

```js
const needsMore = Number.isFinite(Date.parse(cutoffAt))
  && oldestActivityAt(rows) > Date.parse(cutoffAt)
  && hasMoreRows === true;
```

Each extra load must pass tab-identity checks, reserve the existing message-list access budget, use the existing nonzero randomized message pacing, and checkpoint the new oldest activity. A platform-confirmed end marks coverage complete even if fewer than three days exist.

- [ ] **Step 5: Run focused and integration checks**

```powershell
node tests/message_discovery_smoke.js
node tests/zhaopin_message_discovery_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_unified_messages_journey.js
npm run test:integration
```

Expected: job-detail failures no longer remove messages; restart resumes from the durable event/watermark; platform reads remain serial.

- [ ] **Step 6: Commit the durable sync**

```powershell
git add src/application/message_discovery/run.js src/application/message_inbox/index.js src/core/message_discovery.js src/adapters/sites/boss_message_reader.js src/adapters/sites/zhaopin_message_reader.js src/dashboard/message_discovery_controller.js tests/message_discovery_smoke.js tests/zhaopin_message_discovery_smoke.js tests/dashboard_message_discovery_smoke.js tests/dashboard_unified_messages_journey.js
git commit -m "feat(messages): sync complete timelines before job details"
```

---

### Task 5: Render the complete conversation in the Action Inbox

**Files:**
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/dashboard/assets/dashboard.css`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/dashboard_unified_messages_journey.js`
- Modify: `tests/dashboard_information_architecture_smoke.js`

**Interfaces:**
- Consumes: ordered Task 2 timeline events and current inbox rows.
- Produces: each conversation view model with `timeline`, `jobContextStatus`, `drafts`, and `actions`.
- Preserves: `/messages?profileId=<id>` and `message-selection-<profileId>`.

- [ ] **Step 1: Write failing rendered-journey assertions**

Build one timeline containing platform, friend, self, media placeholder, and resume-request events. Assert:

```js
assert.match(page.body, /class="message-bubble message-bubble--friend"/);
assert.match(page.body, /class="message-bubble message-bubble--self"/);
assert.match(page.body, /收到一条语音消息，本版本暂不读取内容/);
assert.match(page.body, /data-message-action="resume_request:accept"/);
assert.doesNotMatch(page.body, /请自行到(?: BOSS|智联)|原始会话/);
```

In the browser journey, select the second conversation and assert its checked input, visible timeline heading, draft editor, and persisted localStorage key all share the same conversation key.

- [ ] **Step 2: Run Dashboard tests and confirm failure**

```powershell
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_unified_messages_journey.js
node tests/dashboard_information_architecture_smoke.js
```

Expected: the current right pane renders one discovery result rather than an ordered complete timeline.

- [ ] **Step 3: Build the timeline view model and HTML**

Use an explicit renderer rather than a client framework:

```js
function renderMessageEvent(event) {
  const side = event.direction === "myself" ? "self"
    : event.direction === "friend" ? "friend" : "platform";
  const content = event.kind === "media_ignored"
    ? mediaPlaceholder(event.metadata?.mediaKind)
    : escapeHtml(event.text || actionLabel(event.kind));
  return `<article class="message-bubble message-bubble--${side}" data-message-key="${escapeAttr(event.messageKey)}">${content}</article>`;
}

function mediaPlaceholder(kind) {
  return {
    voice: "收到一条语音消息，本版本暂不读取内容",
    image: "收到一张图片，本版本暂不读取内容",
    attachment: "收到一个附件，本版本暂不读取内容"
  }[kind] || "收到一条媒体消息，本版本暂不读取内容";
}
```

Group the left list as `needs_action`, `waiting`, `needs_review` renamed in copy to `系统正在补充资料`, and `done`. Job enrichment belongs in a collapsed panel. Keep the reply editor and current action buttons at the bottom of the selected conversation.

- [ ] **Step 4: Run the Dashboard checks**

```powershell
node tests/dashboard_message_discovery_smoke.js
node tests/dashboard_unified_messages_journey.js
node tests/dashboard_information_architecture_smoke.js
npm run test:fast
```

Expected: the selected list row and visible timeline always match, job context may be incomplete, and no platform-message-page instruction remains.

- [ ] **Step 5: Commit the conversation UI**

```powershell
git add src/dashboard/message_discovery_controller.js src/dashboard/message_discovery_view.js src/dashboard/assets/dashboard.css tests/dashboard_message_discovery_smoke.js tests/dashboard_unified_messages_journey.js tests/dashboard_information_architecture_smoke.js
git commit -m "feat(messages): show complete cross-platform conversations"
```

---

### Task 6: Add verified Zhaopin text replies to the existing send flow

**Files:**
- Create: `src/adapters/sites/zhaopin_message_reply_sender.js`
- Create: `tests/zhaopin_message_reply_sender_smoke.js`
- Modify: `src/storage/schema.js`
- Modify: `src/core/storage.js`
- Modify: `src/storage/message_reply_send_store.js`
- Modify: `src/core/message_reply_send_batches.js`
- Modify: `src/core/message_reply_send_executor.js`
- Modify: `src/dashboard/message_reply_send_controller.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `tests/message_reply_send_store_smoke.js`
- Modify: `tests/message_reply_send_executor_smoke.js`
- Modify: `tests/dashboard_message_reply_send_smoke.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/test_manifest.js`

**Interfaces:**
- Produces: `createZhaopinMessageReplySender({ browser, reader, sleepFn })` with the same five methods as the BOSS sender.
- Reply item adds immutable `platform: "boss" | "zhaopin"`.
- One send batch contains exactly one platform; mixed selection is rejected before confirmation.

- [ ] **Step 1: Write failing schema, sender, and controller tests**

Add schema version 34 and assert old items backfill `platform = 'boss'`. Add a Zhaopin fixture with `.im-sender__input` and `.im-sender__send-btn`.

Test the full fake-browser sequence:

```js
const inspection = await sender.inspectReplyTarget(frozenItem, signal);
const preparation = await sender.fillReply(inspection, frozenItem.replyText, signal);
await sender.dispatchReply(preparation, signal);
assert.equal(fixture.sendClicks, 1);
assert.deepEqual(await sender.verifyReplyResult(preparation, signal), {
  state: "succeeded",
  evidence: { verification: "new_outgoing_message", outgoingMessageId: "202", replyDigest }
});
```

Also cover target drift, a nonempty editor, readback mismatch, button loss, rejected response, ambiguous result, cleanup before click, and no cleanup after click.

- [ ] **Step 2: Run send tests and confirm failure**

```powershell
node tests/zhaopin_message_reply_sender_smoke.js
node tests/message_reply_send_store_smoke.js
node tests/dashboard_message_reply_send_smoke.js
```

Expected: the Zhaopin sender is missing and the store rejects non-BOSS drafts.

- [ ] **Step 3: Add platform ownership to schema version 34**

Add `platform TEXT NOT NULL DEFAULT 'boss' CHECK(platform IN ('boss','zhaopin'))` to `message_reply_send_items`. Migration 34 uses `ALTER TABLE ... ADD COLUMN`, then updates every row from `message_reply_drafts -> jobs.source`. Before returning, query for a missing/unsupported source or a card/job source mismatch and throw `MESSAGE_REPLY_SEND_SOURCE_MISMATCH`; the outer migration transaction then rolls back the column and version change.

In `freezeDraft`, replace the BOSS-only check with:

```js
if (!owner || owner.card_source !== owner.job_source || !["boss", "zhaopin"].includes(owner.job_source)) {
  throw storageError("MESSAGE_REPLY_SEND_SOURCE_MISMATCH", "reply draft source is inconsistent");
}
return { ...frozen, platform: owner.job_source };
```

Reject a batch when its frozen platform set has more than one value.

- [ ] **Step 4: Implement the Zhaopin sender**

Mirror the BOSS sender contract but use only live verified Zhaopin controls:

```js
const EDITOR_SELECTOR = ".im-sender__input";
const SEND_SELECTOR = ".im-sender__send-btn";
```

`inspectReplyTarget` must match conversation key, source job ID, and expected last incoming message ID. `fillReply` focuses the empty textarea, inserts the frozen text, dispatches input/change events if required by Vue, and verifies exact readback. `dispatchReply` persists click ownership before one coordinate click. `verifyReplyResult` requires one new outgoing text event with the same digest in the same conversation.

- [ ] **Step 5: Route batches by platform**

In `message_reply_send_controller.js`, load the frozen batch platform before acquiring a lease:

```js
const platform = snapshot.items[0].platform;
acquireLease(db, { site: platform, owner, command: "message-reply-send", planId: null });
const reader = platform === "zhaopin"
  ? createZhaopinReader({ browser })
  : createBossReader({ browser });
const sender = platform === "zhaopin"
  ? createZhaopinSender({ browser, reader })
  : createBossSender({ browser, reader });
```

Generalize executor error codes to `MESSAGE_REPLY_TARGET_MISMATCH` and `MESSAGE_REPLY_PLATFORM_REJECTED` while retaining old BOSS codes as accepted compatibility inputs. The UI enables send controls for both platforms and prevents one mixed-platform batch selection.

- [ ] **Step 6: Run focused and integration checks**

```powershell
node tests/zhaopin_message_reply_sender_smoke.js
node tests/message_reply_send_store_smoke.js
node tests/message_reply_send_executor_smoke.js
node tests/dashboard_message_reply_send_smoke.js
node tests/storage_migration_smoke.js
npm run test:integration
```

Expected: fake BOSS and Zhaopin replies both complete through one-click verified batches; no real platform write occurs.

- [ ] **Step 7: Commit cross-platform replies**

```powershell
git add src/adapters/sites/zhaopin_message_reply_sender.js src/storage/schema.js src/core/storage.js src/storage/message_reply_send_store.js src/core/message_reply_send_batches.js src/core/message_reply_send_executor.js src/dashboard/message_reply_send_controller.js src/dashboard/message_discovery_view.js tests/zhaopin_message_reply_sender_smoke.js tests/message_reply_send_store_smoke.js tests/message_reply_send_executor_smoke.js tests/dashboard_message_reply_send_smoke.js tests/storage_migration_smoke.js tests/test_manifest.js
git commit -m "feat(messages): send verified Zhaopin replies"
```

---

### Task 7: Execute verified platform action cards inside OfferGo

**Files:**
- Create: `src/storage/message_action_store.js`
- Create: `src/application/message_actions/index.js`
- Create: `src/dashboard/message_action_controller.js`
- Create: `src/adapters/sites/boss_message_action_sender.js`
- Create: `src/adapters/sites/zhaopin_message_action_sender.js`
- Create: `tests/message_platform_action_smoke.js`
- Modify: `src/storage/schema.js`
- Modify: `src/core/storage.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/test_manifest.js`

**Interfaces:**
- Produces: `confirmMessageAction(db, { profileId, platform, conversationKey, messageKey, actionKind, idempotencyKey })`.
- `actionKind` initially allows `resume_request_accept` and `resume_request_decline`; add another kind only after a current redacted live probe proves its control and result.
- Sender contract: `inspectTarget`, `prepareAction`, `dispatchAction`, `verifyActionResult`, `clearPreparedAction`.

- [ ] **Step 1: Capture redacted live evidence before selecting controls**

For each currently available resume-request card, record only:

```js
{
  platform,
  cardType,
  rootClasses,
  buttonClasses,
  buttonLabels: ["同意", "拒绝"],
  disabledStates,
  componentName
}
```

Do not record message text, recruiter/company names, job IDs, session IDs, cookies, or request bodies. If a BOSS card is not currently available, implement and enable only the proven Zhaopin action; keep the BOSS adapter export disabled until a later live sample exists.

- [ ] **Step 2: Write failing durable-action and fake-browser tests**

Add schema version 35 and assert one idempotency key creates one item:

```js
const first = confirmMessageAction(db, input);
const second = confirmMessageAction(db, input);
assert.equal(second.id, first.id);
assert.equal(second.clickCount, 0);
```

Verify transitions `confirmed -> selecting -> verified -> click_dispatched -> succeeded`, `click_count` can change only `0 -> 1`, an ambiguous post-click result never returns to pending, and a historical `click_dispatched` item restores as `ambiguous`.

- [ ] **Step 3: Run action tests and confirm failure**

```powershell
node tests/message_platform_action_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/storage_migration_smoke.js
```

Expected: action store/controller modules and action endpoints do not exist.

- [ ] **Step 4: Add schema version 35 and the action service**

Create `message_platform_actions` with one row per immutable action:

```sql
CREATE TABLE message_platform_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('boss','zhaopin')),
  conversation_key TEXT NOT NULL,
  message_key TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK(action_kind IN ('resume_request_accept','resume_request_decline')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'confirmed','selecting','verified','click_dispatched','succeeded',
    'target_mismatch','platform_rejected','ambiguous','stopped'
  )),
  click_count INTEGER NOT NULL DEFAULT 0 CHECK(click_count IN (0,1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, idempotency_key),
  UNIQUE(profile_id, platform, conversation_key, message_key, action_kind)
);
```

The application service checks that the source event is still present and actionable, owns one click durably, executes serially under the platform lease, and updates the inbox after verified success.

- [ ] **Step 5: Implement only evidence-backed action senders**

Each sender reopens the exact conversation, matches the source message ID/key and card type, verifies exactly one visible enabled action button, and calculates a guarded click point. The result verifier must observe a changed card state or a new platform notice tied to the same source event. Label text alone is never enough to establish the target.

For the observed Zhaopin card, use the proven `.im-msg-11__btn--agree` and `.im-msg-11__btn--refuse` controls together with Vue session/message identity. Do not dispatch during automated or live read-only acceptance.

- [ ] **Step 6: Add Dashboard confirmation and status endpoints**

Register:

```text
POST /api/message-action/confirm
GET  /api/message-action/status?profileId=<id>&actionId=<id>
POST /api/message-action/stop
```

The page posts `profileId`, `platform`, `conversationKey`, `messageKey`, `actionKind`, and a newly generated idempotency key. Disable the card after confirmation and poll until terminal. Do not navigate users to a platform message page.

- [ ] **Step 7: Run focused and integration checks**

```powershell
node tests/message_platform_action_smoke.js
node tests/dashboard_message_discovery_smoke.js
node tests/storage_migration_smoke.js
npm run test:integration
```

Expected: fake action success executes one click; all ambiguous and mismatch cases stop without replay; real platforms remain untouched.

- [ ] **Step 8: Commit platform actions**

```powershell
git add src/storage/message_action_store.js src/application/message_actions/index.js src/dashboard/message_action_controller.js src/adapters/sites/boss_message_action_sender.js src/adapters/sites/zhaopin_message_action_sender.js src/storage/schema.js src/core/storage.js src/dashboard/server.js src/dashboard/message_discovery_view.js tests/message_platform_action_smoke.js tests/dashboard_message_discovery_smoke.js tests/storage_migration_smoke.js tests/test_manifest.js
git commit -m "feat(messages): handle verified platform action cards"
```

---

### Task 8: Run exact-SHA gates and real Edge acceptance

**Files:**
- Modify only if evidence requires a product fix: files from Tasks 1-7 plus the matching regression test.
- Create outside Git: `D:\DevData\OfferGo-acceptance\unified-messages-<short-sha>\` evidence and screenshots.
- Build outside Git: `D:\DevData\OfferGo-installer\unified-messages-<short-sha>\`.

**Interfaces:**
- Consumes: a clean exact commit containing Tasks 1-7.
- Produces: full offline-gate evidence, an exact-SHA installer, an isolated installed acceptance environment, and a real Edge acceptance record.

- [ ] **Step 1: Run focused groups and the complete offline gate**

```powershell
npm run test:fast
npm run test:integration
npm run test:package
npm test
git diff --check
git status --short
```

Expected: all four new smoke files appear exactly once in the manifest, all **176 offline checks pass**, `git diff --check` is empty, and the worktree is clean.

- [ ] **Step 2: Freeze the exact candidate SHA and rerun the full gate**

```powershell
$candidateSha = (git rev-parse HEAD).Trim()
npm test
if ((git rev-parse HEAD).Trim() -ne $candidateSha) { throw 'candidate SHA changed during gate' }
```

Expected: the second full gate passes on the same SHA. Record SHA, start/end time, and test count under the D-drive evidence directory.

- [ ] **Step 3: Build an unpublished exact-SHA installer on D:**

```powershell
$shortSha = $candidateSha.Substring(0, 8)
$buildRoot = "D:\DevData\OfferGo-installer\unified-messages-$shortSha"
$outputDir = Join-Path $buildRoot 'artifacts'
& .\scripts\build-installer.ps1 `
  -BuildRoot $buildRoot `
  -OutputDir $outputDir `
  -PortableNodeRoot 'D:\Apps\OfferGo-Acceptance-20260917-9091810\runtime\node' `
  -SkipTests
if ($LASTEXITCODE -ne 0) { throw 'installer build failed' }
```

`-SkipTests` reuses only the immediately preceding exact-SHA full gate. Verify the stage contains production files and excludes SQLite databases, résumés, keys, logs, reports, browser profiles, tests, and Edge Control. Record installer path, bytes, SHA-256, and source SHA.

- [ ] **Step 4: Install to a new isolated acceptance directory**

Install under `D:\Apps\OfferGo-Acceptance-20260918-<short-sha>`. Preserve the existing `%LOCALAPPDATA%\RoleFlow` data directory and logged-in browser profile. Stop only the previous acceptance server after verifying its exact executable/command path; do not remove the previous installer or data.

Start the installed product through its normal installed launcher, then verify:

```powershell
$health = Invoke-RestMethod 'http://127.0.0.1:8787/health'
if ($health.projectRoot -ne "D:\Apps\OfferGo-Acceptance-20260918-$shortSha") {
  throw 'wrong acceptance root'
}
```

- [ ] **Step 5: Complete the real read-only Edge journey**

Using the existing logged-in Edge window and the actual Dashboard button:

1. Click `同步最新消息` once.
2. Verify the healthy BOSS page with a stale `_security_check` parameter is not labeled risk control.
3. Verify BOSS and Zhaopin run serially and reach a terminal state.
4. Verify the first-sync coverage state reaches the current three-day boundary or records a platform-confirmed reachable end.
5. Open representative BOSS and Zhaopin conversations in OfferGo and compare their text timeline, direction, order, platform, job title, and company with the live pages.
6. Verify a missing JD shows `岗位资料暂不可取得` while the message and reply editor remain available.
7. Verify no page tells the user to process a message in the original platform.
8. Reload OfferGo and verify the same selected conversation and timeline persist.

Capture redacted screenshots and structured DOM evidence. Do not activate platform tabs, send text, accept a résumé request, or reject an action.

- [ ] **Step 6: Prepare concrete write candidates and request authorization only then**

Identify one harmless BOSS test conversation and one harmless Zhaopin test conversation whose target, last incoming message, reply text, and expected result are immutable and visible in OfferGo. Prepare but do not dispatch:

```text
platform | conversation label | source job | final reply text | action | expected verification
```

If an evidence-backed card action exists, prepare it separately. Ask the user to authorize each concrete item or immutable batch. Authorization for a text reply does not authorize a card action, another conversation, or a retry after an ambiguous result.

- [ ] **Step 7: After authorization, execute and verify writes serially**

For each authorized item:

1. Confirm it in OfferGo.
2. Observe one local durable click owner.
3. Observe exactly one platform click.
4. Verify the outgoing message or action result in the same conversation.
5. Resync and verify OfferGo moves the conversation to the correct action group without duplication.

Stop immediately on risk control, login loss, target drift, page loss, platform rejection, or ambiguity. Never replay an uncertain click.

- [ ] **Step 8: Commit only evidence-driven fixes, then regenerate the candidate**

If real acceptance exposes a product defect, write the smallest failing regression test, fix it, commit it, and repeat Steps 1-7 from a new exact SHA. Do not amend acceptance evidence across different SHAs.

When all authorized and read-only acceptance cases pass, leave the exact installed environment running for the user's visual and experience review. Do not push, merge, tag, publish, or create a GitHub Release as part of this plan.
