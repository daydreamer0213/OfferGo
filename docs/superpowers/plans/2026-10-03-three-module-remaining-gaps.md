# 三模块剩余缺口实施计划

> For agentic workers: use subagent-driven-development task by task, with independent task review and final review.

**Goal:** 修复普通资料阻塞回复、晚到改写恢复撤回资料、面试当前话题资料漏选三个已复现问题。

**Architecture:** 复用现有 CommonJS application/core/store。保留事实来源，在回复契约按真实输入判断扩展字段；改写前后核对当前记录；面试入口调整选择器查询词。

**Tech Stack:** Node 22、CommonJS、原生 SQLite、现有 Playwright/系统 Edge。

## Global Constraints

- 基线 b7fa4b5，复用当前隔离分支；不改变 schema 37、外部协议或依赖。
- 不操作真实招聘平台，不写用户数据库；证据及临时数据在 D:\DevData\OfferGo-validation\2026-10-03\remaining-gaps。
- 不加隐私大类拒答、逐句审批或知识库设施；原动态资料时间和岗位范围规则不变。
- 每项先失败回归再实现；复用已有测试文件，完整185项清单不变。
- 三个实现任务顺序执行，避免 shared structured.js 并行修改；实现者仅改本人拥有文件，不撤销其他人的工作；控制者负责最终提交和冻结。

### Task 1: 普通个人资料回复

Files: src/core/candidate_fact_policy.js、src/core/message_reply_contract.js、src/core/message_reply_analyzer.js、src/adapters/models/structured.js；tests/message_reply_contract_smoke.js、tests/dashboard_message_discovery_smoke.js（现有补资料应用路径）。

Interfaces: 保留 facts.source 到 analyzer/contract；factStatus(now, fact) 识别来自 user_provided 且有确认时间的普通扩展资料。isKnownFactKey 仍用于原内置字段与自动提取，不无条件放宽。契约允许真实输入提供的用户扩展键，或尚未回答时与 missingFact.key 对应的安全键；普通键应符合 /^[a-z][a-z0-9_.-]{0,79}$/i，已有键规则保留。

- [x] 增加实际 analyzer 与 answerMissingMessageFact 行为回归：英语能力缺失时可向用户询问；填写 english_proficiency 后生成并保存非空草稿。记录修复前 MESSAGE_REPLY_UNKNOWN_FACT。
- [x] 增加对照：无来源的模型自造扩展资料仍拒绝；已知 employment_status 过期仍要求确认；已有薪资和混合问题正常。
- [x] 最小实现来源传递、键校验与普通资料有效性，更新模型说明，使用既有字段与保存入口。
- [x] 运行 message_reply_contract_smoke、dashboard_message_discovery_smoke、message_reply_learning_smoke 和 candidate_learning_journey；独立 task review。

### Task 2: 改写等待期间资料一致性

Files: src/application/message_learning/index.js，必要时 src/storage/message_learning_store.js；tests/message_reply_learning_smoke.js。

Interfaces: reviseMemory({profileId,memoryId,finalText}) 外部不变；getCurrentCandidateAnswerMemory 定点读取当前版本，listCandidateEvidence 支持当前和已撤回记录。保存前保留最新有效人工经历，不恢复已撤回 quote，已有 saveReplyExperiences 和事务继续复用。

- [x] 把复核等待探针加入既有测试：先采用排障经历+20K，等待改成25K的整理时撤回经历，返回后有效经历仍为0；修复前断言失败。
- [x] 加入等待时源回答撤回/新版替代拒绝、经历人工修正保留、正常仅改薪资保留经历、A→B→A 仍可用的行为对照。
- [x] 返回后定点核对当前源回答，重新读取有效关联经历和已撤回来源；对返回的提取结果排除撤回及被人工纠正的旧片段；避免引入通用任务框架。
- [x] 运行 message_reply_learning_smoke、message_learning_store_smoke、message_reply_send_service_smoke、candidate_learning_journey；独立 task review。

### Task 3: 面试按当前话题选资料

Files: src/application/mock_interview/index.js；tests/mock_interview_service_smoke.js。

Interfaces: refreshSupplementalContext(session,{query}={}) 内部接收当前任务查询；默认为冻结 JD/简历。answerTurn 传最后一题与刚提交答案；retryTurn 传题目与 retryAnswer；finishSession 传本轮已答题目及回答。选择器、预算、冻结主上下文不变。

- [x] 增加一条较早协作经历+13条较新技术经历的实际应用回归，当前协作回答后的下一次模型输入必须包含协作经历；修复前遗漏断言失败。
- [x] 检查专项完整 JD、冻结简历仍保留；重答按其问题/新回答选择资料；复盘能读本轮主题资料；撤回资料刷新回归仍通过。
- [x] 只调整调用查询，不修改平台或建立新检索服务。
- [x] 运行 mock_interview_service_smoke、mock_interview_contract_smoke、candidate_learning_journey；独立 task review。

### Task 4: 整体复查与冻结验收

- [x] 独立 whole-change review，修复真实阻塞。
- [x] 系统 Edge 隔离 Dashboard 实际走英语资料补充到草稿，以及资料学习失败后补做；核对刷新后的结果，无真实平台操作。
- [x] 冻结源码提交，执行 tests/run_all.js --browser-required，确认完整185项通过。
- [x] 保存报告及逐项清单，说明本轮证据与真实模型/平台验证边界，文档提交后 src/tests 与冻结提交无差异。
