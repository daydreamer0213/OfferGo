# OfferGo Startup Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flashing PowerShell shortcut with a branded, visible startup window that reports progress and preserves current startup safety checks.

**Architecture:** Build a small WinForms launcher during packaging with the Windows .NET Framework compiler already present on supported Windows systems. The launcher starts the existing PowerShell launcher hidden and reads fixed progress values from a per-run file; PowerShell remains the owner of startup identity, mutex, logging and error handling.

**Tech Stack:** C# WinForms, PowerShell 5.1, Inno Setup, Node smoke tests

## Global Constraints

- No new runtime dependency.
- Keep current startup mutex, project identity, browser authority and user-data safety checks.
- Never place generated launcher build output or caches on `C:` when a project-local or `D:` path is available.

---

### Task 1: Observable startup protocol

**Files:**
- Modify: `scripts/launch-installed.ps1`
- Modify: `scripts/start-workspace.ps1`
- Test: `tests/windows_installer_smoke.js`

**Interfaces:**
- Consumes: optional `-ProgressPath <absolute path>`
- Produces: UTF-8 JSON `{state,message,updatedAt}` using only approved state values

- [ ] Add a failing smoke test that requires `launch-installed.ps1` and `start-workspace.ps1` to accept `ProgressPath`, write `checking_install`, `starting_service`, `starting_browser`, `checking_workspace`, and finish with `ready`.
- [ ] Run `node tests/windows_installer_smoke.js` and confirm the new assertions fail because no progress protocol exists.
- [ ] Add an atomic `Write-OfferGoProgress` helper and emit each state immediately before the corresponding existing startup operation.
- [ ] Run `node tests/windows_installer_smoke.js` and confirm it passes.
- [ ] Commit the startup protocol.

### Task 2: Native launcher and installer wiring

**Files:**
- Create: `installer/launcher/OfferGoLauncher.cs`
- Create: `scripts/build-launcher.ps1`
- Modify: `installer/offergo.iss`
- Modify: `scripts/build-installer.ps1`
- Test: `tests/windows_installer_smoke.js`

**Interfaces:**
- Produces: `OfferGo.Launcher.exe` next to installed scripts
- Executes: hidden PowerShell `scripts/launch-installed.ps1 -ProgressPath <file>`

- [ ] Extend the installer smoke test to require shortcuts and post-install launch to target `OfferGo.Launcher.exe`, and require the launcher source to use `UseShellExecute=false`, `CreateNoWindow=true`, the installed icon, reduced-motion-safe spinner timing, and the progress state labels.
- [ ] Run the smoke test and verify it fails on the current PowerShell shortcut.
- [ ] Implement the WinForms launcher with one icon, one status line, one progress ring, error retention, and an “打开诊断信息” button.
- [ ] Add `build-launcher.ps1` using `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` with 32-bit fallback, writing output under the existing staging directory.
- [ ] Update packaging and shortcuts to use the compiled launcher.
- [ ] Run the installer smoke test and package group.
- [ ] Build an installer on `D:` and verify cold start, already-running start, and failure display.
- [ ] Commit the launcher.
