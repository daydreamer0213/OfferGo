# OfferGo Robustness Implementation Plan

**Goal:** Make platform selection respond promptly and prevent concurrent model settings saves from overwriting one another.

**Architecture:** Keep browser workspace reconciliation serial and asynchronous after platform preference persistence. Coalesce duplicate platform choices and process changed preferences using the latest saved choice. Keep identical model save requests coalesced and serialize distinct writes to the one settings file.

**Tech Stack:** Node.js dashboard, SQLite preference store, JSON model settings, existing smoke tests.

## Constraints

- Keep the running manual acceptance installation and its user data unchanged.
- Preserve browser identity checks, serial access, pacing, JD coverage, and external-write safeguards.
- Do not block unrelated local pages while browser preparation or model verification is pending.

## Task 1: Platform selection

- [x] Add one failing dashboard regression for quick redirect during a blocked workspace pass, repeated identical choice, and latest changed choice.
- [x] Make identical preference saves leave timestamps unchanged.
- [x] Move platform-triggered reconciliation behind the redirect and coalesce desired choice updates while preserving serial passes.
- [x] Report saved/pending/error state accurately and verify the targeted dashboard test.

## Task 2: Model settings

- [x] Add one failing regression with two distinct model settings saves whose controlled connection tests complete in reverse order.
- [x] Serialize distinct model settings operations while retaining identical request coalescing.
- [x] Verify final settings contain both edits and run the targeted model settings test.

## Final verification

- [x] Run the repository's required offline gate on the exact changed checkout (162 checks, exit 0).
- [x] Review diff for account safety and product-quality regressions.
- [ ] Build a separate acceptance candidate only after the gate passes; leave the current installed acceptance candidate intact.
