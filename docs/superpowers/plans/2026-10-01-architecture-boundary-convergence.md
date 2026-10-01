# OfferGo 架构边界渐进收口 Implementation Plan

> **For agentic workers:** Use `executing-plans` task by task; check off each step after verification. Do not delegate work unless the task has genuinely independent, separately verifiable parts.

**Goal:** 纠正过期架构说明，并消除两处已证实的职责混杂，同时保持用户行为不变。

**Architecture:** 保持本地模块化单体。CLI/Dashboard 可以组装运行依赖；应用层负责用例；核心层保留可复用规则；存储层拥有数据操作。只迁移确有反向依赖或入口业务编排的两条链路。

**Tech Stack:** Node.js 22、CommonJS、原生 SQLite、现有日志与测试运行器；不增加运行依赖。

## Global Constraints

- 基线提交：`248a038`；实施前重新确认工作区和 HEAD，没有未经核对的后续改动。
- 不改变页面地址、CLI 参数与输出、Agent stdio v1、SQLite schema、用户数据、BOSS/智联节奏与外部动作授权。
- 本轮不访问真实招聘平台、不扫描、不读取登录消息、不发送沟通；以假浏览器和本地数据库验证。
- 每阶段单独提交，可独立回退；最终冻结提交重新运行完整离线门禁。

---

## 先纠正整改方向

OfferGo 保持 Node.js/CommonJS + 本地 Dashboard + CLI + SQLite 的模块化单体。工程规范关注职责是否清楚、依赖是否可控、变更是否可验证，不要求每个文件一样短，也不要求入口完全不能引用底层模块。

- `src/cli.js` 和 `src/dashboard/server.js` 是运行装配入口：创建数据库、模型与浏览器实例，连接模块，是合理职责。不能给整个 CLI 增加“禁止引用 storage/adapters”的笼统规则；现有 `commands/**` 规则已经约束新命令处理器。
- 架构检查当前通过：614 条内部静态依赖、无文件循环。44 条精确例外不等于 44 个缺陷。其中 `core/storage.js` 的 15 条属于兼容门面；部分 Dashboard controller 对适配器的引用属于组装。不能以减少例外总数为目标盲目搬文件。
- Dashboard 和 application 当前没有直接 `db.prepare`；旧版 `docs/architecture.md` 所写的“23/17 处直接 SQL”和“尚无依赖检查”是过期快照，必须改正。
- 确实值得收口的边界包括 `core/message_discovery.js -> application/message_draft_quality`：底层消息流程反向调用应用服务；以及 `src/cli.js` 内 `reassessBatch` 同时负责命令输出和重评估业务校验、装配、执行。按具体链路处理，不全面重写。

## Task 1：校准架构说明与例外分类

**文件：**`docs/architecture.md`、`docs/README.md`（仅在导航需要时）、`architecture-boundaries.json`（仅删除已消失例外；不放宽规则）。

- [x] 运行 `git status --short`、`git rev-parse --short HEAD`、`node scripts/check-architecture-boundaries.js`，记录实际基线。若 HEAD 已变化，用实际数字更新文档，不照抄本计划的 614/44。
- [x] 核对 `architecture-boundaries.json` 的每条例外及 `src` 中真实引用；按“兼容门面”“入口组装”“待收口的反向依赖”“其他需逐项核对”分类，并写清复查条件。
- [x] 按当前代码重写 `docs/architecture.md` 的现状部分，保留历史评审为有日期的快照。说明 Dashboard/CLI 的组装职责、application 的用例职责、core 的规则职责、storage 的数据职责和 adapters 的平台访问职责。不将旧 SQL 数字写成当前事实。
- [x] 运行 `node tests/architecture_boundaries_smoke.js` 和架构检查；核对没有新增违规、过期例外或循环引用。
- [x] 提交文档阶段；不改产品逻辑。

**完成标准：**读者能区分正常组装与真正越界；文档数字与本次基线一致；架构检查通过。单独提交，可独立回退。

## Task 2：修正消息发现的一处真实反向依赖

**文件：**`src/core/message_discovery.js`、`src/application/message_discovery/run.js`、`src/application/message_draft_quality/index.js`（如需）、`tests/message_discovery_smoke.js`、`tests/zhaopin_message_discovery_smoke.js`、`architecture-boundaries.json`。

**接口：**`application/message_discovery/run.js` 继续导出 `runBossMessageDiscovery(options)`；向内部 `coreDiscovery.runBossMessageDiscovery` 传入一个 `qualityCheckDraft(input)` 函数。`input` 包含 `db`、`profileId`、`job`、`messageTexts`、`generate`、`shouldAssess`，返回现有 `generateQualityCheckedDraft` 的结果。Dashboard 不更改调用方式。

- [x] 先运行 `node tests/message_discovery_smoke.js`、`node tests/zhaopin_message_discovery_smoke.js`，记录基线；检查现有测试对首次生成、二次修订、修订失败、事实缺失、拒绝消息和仅发送简历分支的覆盖。只给实际缺口补回归断言，先确认新增断言能识别错误实现。
- [x] 在 `application/message_discovery/run.js` 组装 `qualityCheckDraft`：调用 `buildMessageDraftQualityContext(db, { profileId, job, messageTexts })` 后，把证据和 `generate`、`shouldAssess` 交给 `generateQualityCheckedDraft`。
- [x] `core/message_discovery.js` 改为调用传入的 `qualityCheckDraft`，删除对 `application/message_draft_quality` 的 `require`。保留现有错误、重试次数、草稿可发送判断和事务顺序；不改变提示词、读取节奏或外部动作。
- [x] 删除 `architecture-boundaries.json` 中该条精确例外。运行上述两项定向测试、`node tests/architecture_boundaries_smoke.js`、`npm run test:fast`、`npm run test:integration` 和完整 `npm test`；提交。

**完成标准：**相关 BOSS/智联离线测试、架构检查、`npm run test:fast`、`npm run test:integration` 和完整 `npm test` 通过；该反向依赖消失。单独提交，可独立回退。

## Task 3：把 CLI 重评估命令中的业务编排放进现有应用层

**文件：**`src/cli.js`、`src/application/analysis/reassess_batch.js`（或在现有 `analysis` 模块中新增单一用例）、`tests/onboarding_smoke.js`、`tests/job_store_contract_smoke.js`。

**接口：**新增 `reassessBatch({ db, batchId, planId, createConfigs, logger, cleanDescription })`，返回现有 `reassessBatchObservations` 的结果。`createConfigs()` 由 CLI 提供，并仅在应用用例校验方案与已确认匹配卡后调用，以保持原有错误顺序；它按 `--agent`、`--use-model`、默认规则模式选定 `configs.model`。`cleanDescription` 继续由 CLI 从现有 BOSS 适配器传入，避免 application 反向引入适配器。CLI 负责把结果映射为原日志、中文输出和退出行为。

- [x] 先运行 `node tests/onboarding_smoke.js` 和 `node tests/job_store_contract_smoke.js`。核对缺参数、无方案、画像缺失、匹配卡未确认、默认最新批次、三种模型模式、成功输出和失败退出码；仅补现有检查没有覆盖的关键分支。
- [x] 从 `src/cli.js` 的 `reassessBatch` 提出方案读取、匹配上下文校验、运行配置补全、岗位分析执行到 `src/application/analysis/reassess_batch.js`，直接复用 `reassessBatchObservations`；不复制筛选或存储算法。
- [x] CLI 留下参数转换、默认批次选择、模型模式选择、现有 `cleanDetailText` 函数、日志与标准输出。接口只传 `db`、两个 ID、配置创建函数、logger 与文本清理函数；如果迁移需要大量透传参数，先重新审视边界，不继续堆抽象。
- [x] 运行两项定向测试、架构检查、`npm run test:fast`、`npm run test:integration` 和完整 `npm test`；逐字段比对 CLI 可观察输出后提交。

**完成标准：**CLI 文本、错误码与退出行为一致；重评估结果、批次归属和失败恢复一致；定向测试、架构检查及完整离线门禁通过。单独提交，可独立回退。

## 本轮明确不做

- 不按行数拆 `server.js`、`storage.js` 或 BOSS 适配器；只有出现实际修改冲突、重复规则或难以验证的变更时才做局部提取。
- 不因例外存在就清除 `core/storage.js` 兼容门面，不把 Dashboard 的浏览器装配强行塞进 application。
- 不扩大静态检查到“任何 CLI 引用底层即失败”；也不新建万能 repository、服务容器或框架。
- 不访问真实招聘平台、不扫描、不读取登录消息、不发送沟通。本轮架构改造以假浏览器和本地数据库完成自动验证；真实路径验收需另按用户恢复验收的安排进行。

## 总体验收与回退

每阶段先补缺失的回归检查，再做最小迁移，再运行定向测试及完整离线门禁；阶段之间单独提交。最后在冻结提交上重新运行 `npm run test:release`（含浏览器测试环境，但不登录真实招聘平台），记录精确 SHA 与通过数量。任何阶段如果改变外部协议、既有数据、站点访问节奏或产生新的无理由跨层例外，回退该阶段并重新设计。衡量结果是**真实职责边界更清楚且行为不变**，而不是文件数或例外总数下降。
