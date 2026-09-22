# OfferGo 导航、设置性能与双平台调度实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Keep the implementation inline when delegation is unavailable.

**Goal:** 用最小改动统一导航、加快模型设置页，并通过薄调度层同时运行现有 BOSS 与智联流程。

**Architecture:** 不新增平台业务实现。Dashboard 解析共享导航上下文；设置首屏只做便宜的本地状态读取；workflow service 对 `site=both` 分发两次现有单平台 start。扫描 lease、运行键和分析任务领取只补充并行所需的作用域。

**Tech Stack:** Node.js 22、CommonJS、原生 SQLite、现有 Dashboard 与 CLI。

### Task 1: 一致导航

**Files:**
- Modify: `src/dashboard/ui/navigation.js`
- Modify: `src/dashboard/server.js`
- Test: `tests/dashboard_information_architecture_smoke.js`
- Test: `tests/dashboard_shell_smoke.js`

1. 先增加失败测试：工具页有有效方案时必须显示完整导航，智联上下文也显示求职体检。
2. 从现有 candidate/search plan store 解析最近有效方案，不增加页面层 SQL。
3. 向招聘平台、模型设置和诊断渲染器传入同一导航上下文。
4. 运行两项导航测试。

### Task 2: 模型设置页快速打开

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `tests/model_settings_ui_smoke.js`
- Test: `tests/dashboard_model_runtime_cache_smoke.js`

1. 先增加失败测试：GET `/settings` 的默认公共读取必须传入 `inspectCredential:false`，且保存后页面仍显示 Key 已保存。
2. 公共页面状态使用设置文件与 Key 文件存在性；真实模型 readiness 继续使用现有 runtime cache。
3. 保持保存、验证和 cache 失效逻辑不变。
4. 运行模型设置与 runtime cache 测试，并测量本地 GET 延迟。

### Task 3: 按平台隔离现有运行

**Files:**
- Modify: `src/storage/scan_store.js`
- Modify: `src/application/workflow/dashboard_service.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/scan_store_contract_smoke.js`
- Modify: `tests/workflow_dashboard_smoke.js`
- Modify: `tests/zhaopin_workflow_smoke.js`

1. 先把旧的跨平台互斥断言改为：不同平台 lease 可并存，同平台第二个 lease 失败。
2. workflow 可用性检查只检查目标平台的活动 run 和 lease。
3. scanRuns 使用包含 site 的键，并让状态与控制逻辑按 workflow 精确查找。
4. 运行存储和 workflow 回归测试。

### Task 4: 薄双平台调度与共享分析上限

**Files:**
- Modify: `src/application/workflow/dashboard_service.js`
- Modify: `src/dashboard/pages/today.js`
- Modify: `src/dashboard/controllers/workflow_controller.js`
- Modify: `src/core/workflow_analysis_tasks.js`
- Modify: `src/core/workflow_analysis_executor.js`
- Modify: `src/storage/workflow_store.js`
- Test: `tests/dashboard_workflow_controller_smoke.js`
- Test: `tests/workflow_analysis_executor_smoke.js`
- Test: `tests/today_dashboard_smoke.js`

1. 先增加失败测试：`site=both` 并行调用两次现有 start，并返回逐平台结果；单平台调用不变。
2. 页面只在两个平台均启用时显示“同时运行 BOSS + 智联”。
3. controller 接受现有表单字段并返回可显示的部分成功结果。
4. 在现有分析任务 claim 事务中增加跨 workflow 的 running 数量上限；没有空位时等待后继续领取，不创建新队列。
5. 运行 controller、页面和分析执行器测试。

### Task 5: 完整验证与验收环境

1. 运行相关快速与集成测试。
2. 运行完整离线门禁，记录精确 commit SHA。
3. 构建并安装到 `D:\Apps\OfferGo-Acceptance-<sha>`，大型产物保存在 `D:\DevData\OfferGo-acceptance\<sha>`。
4. 在 Edge 走真实页面路径，验证左栏、设置页打开速度和双平台入口展示；外部平台扫描只做已授权的只读检查，不触发沟通或投递。
5. 推送当前分支到远端。

