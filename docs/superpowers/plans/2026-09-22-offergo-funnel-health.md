# OfferGo Funnel Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn 求职体检 into an understandable stage funnel with useful diagnostics and complete final outcomes.

**Architecture:** Reuse the current mature per-platform funnel projection and expose its existing stages through a dedicated view model. Extend candidate progress with three user-authored outcome stages while preserving old data and existing terminal semantics.

**Tech Stack:** Node.js 22 CommonJS, native SQLite, server-rendered Dashboard

## Global Constraints

- Unknown platform status is never counted as failure.
- BOSS and 智联 remain separate diagnostic populations.
- Existing databases open without losing or rewriting prior events.

---

### Task 1: Complete outcome vocabulary

**Files:**
- Modify: `src/core/candidate_progress.js`
- Modify: `src/core/funnel_maturity.js`
- Modify: `src/storage/schema.js`
- Test: `tests/job_search_funnel_smoke.js`
- Test: `tests/funnel_diagnosis_smoke.js`

**Interfaces:**
- Adds user stages: `interview_completed`, `offer_received`, `withdrawn`
- Adds snapshot stages: `interviewCompleted`, `offerReceived`

- [ ] Add failing projection tests for interview completion, offer receipt and user withdrawal, including reopening and terminal behavior.
- [ ] Run focused tests and verify the new stages are rejected by current validation.
- [ ] Add the stages and map them into append-only progress events and funnel projection.
- [ ] Run focused tests and commit.

### Task 2: Health dashboard view model and page

**Files:**
- Create: `src/application/funnel_analysis/health_view.js`
- Modify: `src/application/funnel_analysis/index.js`
- Modify: `src/dashboard/pages/funnel.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/dashboard_funnel_smoke.js`
- Test: `tests/funnel_platform_feedback_smoke.js`

**Interfaces:**
- Produces: `buildHealthView(dashboard) -> { overview, platformFunnels, diagnosis, stale }`

- [ ] Add failing tests for stage order, known denominators, waiting/unknown counts, seven-day stale count, and suppression of unsupported 智联 read metrics.
- [ ] Run focused tests and confirm the current four-column table fails the desired output.
- [ ] Implement the health view and a stage-track layout with plain labels and one primary diagnosis.
- [ ] Keep detailed comparisons and strategy-round controls below the main diagnosis.
- [ ] Run focused tests, capture screenshots at desktop/mobile widths, refine, and commit.
