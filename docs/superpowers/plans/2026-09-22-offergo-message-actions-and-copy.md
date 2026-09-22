# OfferGo Message Actions and Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn resume requests into verified platform actions, generate platform-aware drafts only for remaining questions, and present message details in plain user language.

**Architecture:** Derive requested platform actions before draft generation, carry platform and actions into the reply contract, and render a user-facing view model rather than raw internal analysis strings. Extend the existing message action service for BOSS only after live DOM evidence identifies a stable send-resume control and success signal.

**Tech Stack:** Node.js 22 CommonJS, native SQLite, existing browser adapters and Dashboard HTML/CSS

## Global Constraints

- Message sync remains read-only.
- Every external action requires a concrete user confirmation and executes at most once.
- Never retry an ambiguous BOSS or 智联 action.
- Voice, images and attachments remain out of scope.

---

### Task 1: Resume action derivation and reply contract

**Files:**
- Create: `src/core/message_requested_actions.js`
- Modify: `src/core/message_discovery.js`
- Modify: `src/core/message_reply_analyzer.js`
- Modify: `src/core/message_reply_contract.js`
- Modify: `src/adapters/models/structured.js`
- Modify: `src/adapters/models/mock.js`
- Test: `tests/message_reply_contract_smoke.js`
- Test: `tests/message_discovery_smoke.js`
- Test: `tests/model_adapter_smoke.js`

**Interfaces:**
- Produces: `deriveRequestedActions({ platform, messages, manualActions }) -> { requestedActions, replyMessages }`
- Adds analyzer input: `platform`, `requestedActions`

- [ ] Add failing tests for a BOSS text asking only for a resume, a resume plus scheduling question, and a message that merely mentions a resume without requesting it.
- [ ] Run the three focused tests and confirm they fail because textual resume requests are not actions and platform is absent.
- [ ] Implement conservative resume-request derivation and pass platform/actions through the analyzer and model adapter.
- [ ] Enforce no draft for action-only requests and reject channel switching or resume promises unless explicitly requested by HR.
- [ ] Run focused tests and commit.

### Task 2: User-facing message presentation

**Files:**
- Create: `src/dashboard/message_presenter.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/dashboard_message_discovery_smoke.js`
- Test: `tests/dashboard_unified_messages_journey.js`

**Interfaces:**
- Produces: `presentMessageResult(result) -> { recruiterRequest, opportunity, knownFacts, details }`

- [ ] Add failing view tests proving unknown fields and internal phrases are omitted, actions appear before analysis, and known salary/location/schedule values remain visible.
- [ ] Run focused view tests and confirm failure on current raw rendering.
- [ ] Implement the presenter and restrained action-first layout using the approved OfferGo palette.
- [ ] Run focused tests and capture desktop/mobile screenshots for critique.
- [ ] Remove any decorative element that does not help identify the next action, rerun tests, and commit.

### Task 3: BOSS send-resume action

**Files:**
- Create: `src/adapters/sites/boss_message_action_sender.js`
- Modify: `src/dashboard/message_action_controller.js`
- Modify: `src/application/message_actions/index.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Test: `tests/boss_message_action_sender_smoke.js`
- Test: `tests/message_platform_action_smoke.js`

**Interfaces:**
- Supports: `platform="boss", actionKind="resume_request_accept"`
- Requires evidence: conversation key, message key, source message identity, active resume identity, verified success marker

- [ ] Use the current logged-in fixed BOSS communication tab for one read-only calibration of an actual resume-request conversation; record redacted DOM evidence and the stable target/success fields in the test fixture.
- [ ] Add failing adapter tests for exact target selection, active resume verification, one click, success, mismatch and ambiguous outcomes.
- [ ] Implement the sender with the same inspect/prepare/dispatch/verify token lifecycle as existing senders.
- [ ] Extend the controller lease and cleanup path for serial BOSS execution.
- [ ] Run focused action tests, then perform a no-click live preparation probe.
- [ ] Commit. Do not execute a real resume send without a separate user confirmation on the concrete UI item.
