# OfferGo 三模块共用经历实施计划

> 执行方式：使用 executing-plans 在本会话逐项执行；用户已授权设计文档完成后直接执行，无需再次询问执行方式。

**Goal:** 打通经用户确认的个人经历，改善求职回答、通用/岗位面试和通用/单岗位简历优化。

**Architecture:** 复用现有模块化单体、store 和模型适配器。一个已确认经历 store、一个共用纯函数选择器，供现有应用服务读取；页面沿用现有表单与编辑流程。

**Tech Stack:** Node.js 22+、CommonJS、原生 SQLite、现有 HTTP Dashboard、现有模型适配器。

## Global Constraints

- 无新运行依赖；不访问真实招聘平台或发送消息来进行离线回归。
- 旧数据库经现有迁移备份后自动升级；旧会话/草稿正常读取。
- source_quote 必须来自用户原始回答；用户确认后才成为共用经历。
- 普通求职问题不因 salary/sensitive 分类禁止草稿；未知事实补齐后继续。
- 不编造用户经历；实际对外写入继续使用现有确认和身份检查。
- 复用当前隔离分支；新增依赖遵守架构检查。

## Task 1：共用已确认经历与相关资料选择

Files: `src/storage/candidate_evidence_store.js`、`src/core/candidate_evidence.js`、`src/storage/schema.js`、`src/core/storage.js`、`tests/candidate_evidence_smoke.js`、`tests/test_manifest.js`。

Interfaces: `saveCandidateEvidence(db,{profileId,subject,text,sourceKind,sourceId,sourceItemKey,sourceQuote,scope})`；`listCandidateEvidence(db,{profileId,includeWithdrawn=false})`；`reviseCandidateEvidence(db,{profileId,id,subject,text})`；`withdrawCandidateEvidence(db,{profileId,id})`。纯函数 `selectRelevantCandidateMaterial(items,{query,job,limit,maxChars})` 返回按范围/相关度/时间筛选的材料。

- [x] 写回归：同一来源重复保存只有一条；候选人隔离；修改/撤回；相关旧记录领先于新但无关记录。
- [x] 执行 `node tests/candidate_evidence_smoke.js`，确认缺少接口而失败。
- [x] 新建已确认经历表，增加下一版本迁移；使用现有事务及所属校验。纯函数用规范化词/中文相邻字片段匹配，先主题后正文，时间只打破同分。
- [x] 运行新回归、`node tests/storage_migration_smoke.js`、架构检查，提交独立可验收改动。

## Task 2：面试题目覆盖、真实经历确认与资料管理

Files: `src/application/mock_interview/index.js`、`src/core/mock_interview.js`、`src/adapters/models/structured.js`、`src/dashboard/pages/mock_interview.js`、`src/dashboard/server.js`、现有 communication-profile 渲染、`tests/mock_interview_service_smoke.js`、`tests/mock_interview_contract_smoke.js`。

Interfaces: `mockInterview.confirmEvidence({profileId,planId,sessionId,turnNumber,subject,text,sourceQuote})` 保存用户确认经历；`dashboard` 提供已确认经历；报告 `evidenceCandidates:[{turnNumber,subject,sourceQuote,text}]` 为可选字段。question 添加 `questionKind:follow_up|topic_transition`，仅新上下文允许转题。

- [x] 增加行为回归：通用/专项简报、主题转换、未经确认不复用、保存原话、重复确认、非法候选人/题号/来源拒绝、撤回后不复用。
- [x] 运行相关回归，确认新增行为失败。
- [x] 构造 interviewBrief 并传入冻结上下文；更新契约和模型规则；可选经历候选只从原回答提取，坏候选不阻塞报告。
- [x] 页面报告给出最多三条可编辑经历确认表单；已回答题提供手动保存入口；资料页面提供查看、编辑和撤回；新 HTTP 输入交给 application。
- [x] 运行面试 store/service/contract 和 Dashboard 回归，提交。

## Task 3：正常求职回答与相关经历复用

Files: `src/core/message_reply_analyzer.js`、`src/core/message_reply_contract.js`、`src/adapters/models/structured.js`、`src/dashboard/message_discovery_controller.js`、`src/application/message_discovery/answer_fact.js`、相关 composition、`tests/message_reply_contract_smoke.js`、`tests/message_discovery_smoke.js`。

Interfaces: analyzer 输入增加 `candidateEvidence`，输出可选 `responseStrategy:{concern,focus,evidenceIds}`、`usedEvidenceIds`；资料来自 application/composition 注入，core 不新增具体 store 依赖。

- [x] 更新回归：已知薪资+到岗同时给草稿，普通个人问题能回答，面试邀请保留个性化草稿；相关旧记忆优先；无依据或撤回记录不能引用。
- [x] 运行回归确认行为失败。
- [x] 取消 salary/sensitive 大类硬拦截和固定面试草稿覆盖；保留缺事实补齐、未知目标和拒绝消息语义。扩大历史候选并先做相关度排序。
- [x] 注入共用已确认经历，包括用户补充事实后重新生成的路径；同一次模型调用理解关注点并生成短而自然的回复。
- [x] 运行消息 contract/discovery/learning/send 回归，提交。

## Task 4：通用与具体岗位简历优化

Files: `src/application/resume_optimization/index.js`、`src/storage/resume_optimization_store.js`、`src/core/resume_optimization.js`、`src/adapters/models/structured.js`、`src/dashboard/pages/resume_optimization.js`、`src/dashboard/server.js`、相关服务/页面测试。

Interfaces: `createDraft` 增加 `mode:general|job_specific|direction`、`jobId`。省略 mode 的现有调用保持 direction；界面默认 general。新草稿持久化 mode；单岗位 targetJobIds 长度为一；通用为零。

- [x] 回归：零完整岗位生成通用草稿；专项只绑定指定完整岗位；错误所属拒绝；确认经历进入证据和启用校验；旧 direction 调用兼容。
- [x] 运行回归确认新增行为失败。
- [x] 复用已有生成/编辑/保存/启用，支持新 mode、通用空目标岗位和专项单岗位；通用姓名及联系信息沿用现有保护而不阻断正文改善。
- [x] 页面提供两种主要用途及专项岗位选择，历史方向版继续显示参考岗位；模型按 mode 使用通用可读性/STAR 或单 JD 相关性规则。
- [x] 运行简历 store/service/contract 和 Dashboard 回归，提交。

## Task 5：跨模块验收与完整门禁

Files: `tests/candidate_learning_journey.js`、`tests/test_manifest.js`、`docs/superpowers/reports/2026-10-03-candidate-learning-three-modules.md`、模块当前说明。

- [x] 构造独立 SQLite 场景：面试原话“我做接口联调，没有主导架构”，确认 → HR 回复上下文/简历依据读取 → 撤回 → 后续两者不再读取；无真实平台写入。
- [x] 使用真实模型接口或当前外层 Agent 对匿名样例检查切题程度、职责真实性、自然程度、专项覆盖和简历改善；分别记录模型样例与实际应用证据，不能用 mock 冒充真实模型验收。
- [x] 运行 `npm test`：功能提交 `d5d4b13` 的 185 项标准离线检查退出码 0；11 项测试记录浏览器分支跳过，详见报告。隔离 Dashboard 已通过内置浏览器实际点击验收，Edge 当前不可连接，未宣称其验收通过；未触碰用户当前数据库。
- [x] 核对设计要求与现状文档，更新实施报告及本清单；完整门禁后提交文档，报告实际完成范围及未具备条件的验证。
