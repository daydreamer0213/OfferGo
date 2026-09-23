# Search condition sync implementation plan

**Goal:** When the user returns to Today's Tasks, show the current platform search conditions and use validated changes for the next run; provide a manual reread button.

**Architecture:** Reuse the existing serialized BOSS preview and Zhaopin save routes. Trigger a single guarded read on initial display and when the dashboard regains focus. Keep active workflow snapshots immutable and leave BOSS generated mode tied to its saved local plan.

**Tech Stack:** Node 22, CommonJS, native SQLite, existing Dashboard scripts and Playwright smoke tests.

## Constraints

- No foreground platform tab activation, concurrent browser reads, or new browser session.
- Never replace an active run's frozen conditions.
- If the page cannot be read safely, keep the last known conditions and show a retryable error.

## Tasks

- [x] Add failing browser regressions for automatic and manual condition refresh on BOSS and Zhaopin, stale read responses, and repeated identical Zhaopin sync.
- [x] Reuse the existing serialized routes, make identical Zhaopin saves idempotent, and update the Today page controls and status text.
- [x] Run focused smoke tests, the full offline gate, and an Edge UI journey with synthetic platform pages.
