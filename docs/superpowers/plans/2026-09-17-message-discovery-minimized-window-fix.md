# Message Discovery Minimized Window Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复智联未选择会话和 BOSS 专用 Edge 最小化时的只读消息发现误判，同时保留现有身份与标签页安全边界。

**Architecture:** 智联读取器把列表就绪与会话就绪分开；CDP 适配器暴露窗口状态，BOSS 基线比较只豁免有证据的最小化可见性变化。详情读取器增加枚举化脱敏诊断。

**Tech Stack:** Node.js 22、CommonJS、原生 CDP、Node assert、现有 Playwright 测试运行时。

## Global Constraints

- 不改变任何外部写操作授权边界，不发送消息或申请岗位。
- 不放宽固定标签页、窗口、岗位身份、风控和登录检查。
- 不新增运行依赖，不修改 SQLite schema。
- 使用现有 OfferGo 专用 Edge 和登录状态进行最终只读验证。

---

### Task 1: 智联空选择状态

**Files:**
- Modify: `tests/zhaopin_message_reader_smoke.js`
- Modify: `src/adapters/sites/zhaopin_message_reader.js`

**Interfaces:**
- Consumes: `createZhaopinMessageReader({ browser, ... })`
- Produces: `scanConversationRows()` 在列表已加载但无活动会话时返回会话行。

- [ ] **Step 1: Write the failing test** — 创建会话列表存在、`active=null`、标题节点缺失、消息为空的夹具，断言扫描返回全部会话。
- [ ] **Step 2: Run test to verify it fails** — 运行 `node tests/zhaopin_message_reader_smoke.js`，预期收到 `ZHAOPIN_MESSAGE_STRUCTURE_CHANGED`。
- [ ] **Step 3: Write minimal implementation** — 快照只把 side/main 组件作为列表就绪条件，标题会话字段使用可选读取。
- [ ] **Step 4: Run test to verify it passes** — 再次运行同一测试并确认成功。
- [ ] **Step 5: Commit** — 提交智联回归测试与最小修复。

### Task 2: BOSS 最小化基线

**Files:**
- Modify: `src/adapters/browser/cdp.js`
- Modify: `src/adapters/sites/boss_message_detail_reader.js`
- Modify: `tests/cdp_browser_smoke.js`
- Modify: `tests/boss_message_detail_reader_smoke.js`

**Interfaces:**
- Consumes: `CdpBrowserAdapter.listTabs()` 和 `assertRestoredBaseline(tabs, binding)`。
- Produces: tab 对象新增 `windowState`；基线比较识别有证据的最小化状态。

- [ ] **Step 1: Write the failing tests** — 断言 CDP tab 带有窗口状态；断言正常到最小化且标签身份不变时恢复通过，真实标签差异仍失败。
- [ ] **Step 2: Run tests to verify they fail** — 运行两个 smoke 测试，确认分别因缺少 `windowState` 和最小化可见集合变化而失败。
- [ ] **Step 3: Write minimal implementation** — 读取 `Browser.getWindowBounds` 并在 BOSS 基线中只豁免最小化导致的可见性不可观察。
- [ ] **Step 4: Add safe diagnostics** — 基线错误只附带固定枚举差异字段，详情读取器记录所有安全停止错误的阶段。
- [ ] **Step 5: Run tests to verify they pass** — 重跑两个 smoke 测试。
- [ ] **Step 6: Commit** — 提交 BOSS 最小化修复和诊断。

### Task 3: 门禁、只读实测与验收环境

**Files:**
- Modify only if a failing gate exposes a defect required by this fix.

**Interfaces:**
- Consumes: 修复后的消息读取器和现有打包脚本。
- Produces: 完整测试证据、只读实测证据和可点击验收环境。

- [ ] **Step 1: Run focused and fast gates** — 运行相关 smoke 与 `npm run test:fast`。
- [ ] **Step 2: Run the full offline gate** — 运行 `npm test` 并保存精确提交证据。
- [ ] **Step 3: Run serial read-only acceptance** — 使用现有登录页先 BOSS 后智联，只读发现消息；验证无发送、无申请和无多余标签页。
- [ ] **Step 4: Build the acceptance environment** — 生成新验收目录，使用可点击启动入口并隔离验收数据。
- [ ] **Step 5: Verify the frozen build** — 对最终提交重新执行完整门禁和启动健康检查。

