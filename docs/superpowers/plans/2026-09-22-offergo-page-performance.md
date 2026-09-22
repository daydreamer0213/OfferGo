# OfferGo Page Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove repeated DPAPI subprocess work from read-only page navigation so 简历工作室 and 面试训练 render in under 500 ms on the current acceptance data.

**Architecture:** Add a Dashboard-local model runtime cache keyed by the settings and secret file signatures. Read-only routes use cached public readiness and cached services; settings saves invalidate the cache before the next model operation.

**Tech Stack:** Node.js 22 CommonJS, existing DPAPI secret store, native HTTP server

## Global Constraints

- Never persist or log plaintext API keys.
- Preserve immediate settings changes and current model task-profile behavior.
- Do not weaken DPAPI storage or connection verification.

---

### Task 1: Runtime model cache

**Files:**
- Create: `src/application/model_runtime_cache.js`
- Modify: `src/dashboard/server.js`
- Test: `tests/model_settings_ui_smoke.js`
- Test: `tests/dashboard_resume_optimization_smoke.js`
- Test: `tests/dashboard_mock_interview_smoke.js`

**Interfaces:**
- Produces: `createModelRuntimeCache({ resolve, signature })` with `get(taskProfile)`, `ready(taskProfile)`, and `invalidate()`

- [ ] Add failing tests with a counting resolver proving repeated GET requests resolve a task profile once, while invalidation forces exactly one new resolution.
- [ ] Run focused tests and confirm current routes invoke the resolver repeatedly.
- [ ] Implement the cache and make resume/interview services share cached runtime state.
- [ ] Invalidate after successful model settings save and preserve injected test resolvers.
- [ ] Run focused tests and commit.

### Task 2: Performance regression gate

**Files:**
- Create: `tests/dashboard_page_performance_smoke.js`
- Modify: `tests/test_manifest.js`

**Interfaces:**
- Measures repeated route behavior with deterministic fake resolver counts rather than machine timing alone.

- [ ] Add the regression test to the integration group, asserting one secret resolution across repeated resume/interview navigation and fresh resolution after settings change.
- [ ] Run the test and complete integration group.
- [ ] Measure the installed acceptance routes three times each and require p95 below 500 ms on the current data.
- [ ] Commit the performance gate.
