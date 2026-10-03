# 三模块缺口补齐 Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent selection work, and execute the coupled learning/interview work sequentially in this existing isolated worktree. Each checkbox includes a regression and review checkpoint.

**Goal:** 让确认资料与改写经历真正跨模块复用，面试围绕实际能力和岗位适配考察。

**Architecture:** 复用现有经历表、事实规则、回复整理调用和应用服务；不增加 schema、运行依赖或外部平台动作。动态出题进度作为模型输入，不新增任务状态机。

**Tech Stack:** Node 22、CommonJS、原生 SQLite。

## Global Constraints

- schema 37 保持不变；无新运行依赖；生成内容仍以真实资料为依据。
- 不访问真实 BOSS/智联，不发送消息或简历，不操作用户现有数据库。
- 流程确认事项不充当面试训练题；不得硬性要求短训练覆盖全部主题。

## Task 1：明确事实投影

Files: src/core/candidate_fact_policy.js、src/core/message_reply_analyzer.js、src/application/mock_interview/index.js、src/application/resume_optimization/index.js、src/application/message_learning/index.js、tests/candidate_learning_journey.js。

Interface: mergeCandidateFacts(facts, evidence, {job, factRevisions}) 返回按范围与确认时间合并的事实；无写入副作用。listCandidateFacts(db, profileId, {job}) 按当前岗位读取有效修订，省略第三参保留原管理页列表行为。

- [x] 先加回归：确认面试中明确的已离职/下周到岗 → HR 正常回复；撤回后失效；较新的手动事实优先。运行见失败。
- [x] 在共同事实规则中实现明确陈述投影，所有使用入口复用；参考实现 `const facts = mergeCandidateFacts(existingFacts, candidateEvidence, { job });`。补充删除记录、历史状态、原确认时间和岗位/公司范围回归。
- [x] 运行 candidate_learning_journey 和消息契约/学习、面试、简历服务检查，提交。

## Task 2：改写中的通用经历

Files: src/core/message_reply_learning.js、src/application/message_learning/index.js、src/adapters/models/structured.js、tests/message_reply_learning_smoke.js。

Interface: 现有 extractReplyEditFacts 可返回 experiences[{subject,text,sourceQuote}]；有效段落用 manual/reply-edit:<memoryId> 保存。

- [x] 加回归：混合改写中真实经历跨岗可用、公司条件不进入段落、无真实引用丢弃；重试不重复；修改/撤回后旧段落失效。运行见失败。
- [x] 复用同一次整理调用提取经历，保持旧返回兼容，使用完成事务回调保存，`sourceId = 'reply-edit:' + memory.id`；历史数据在读取时按现有范围继续使用。仅修改薪资保留旧经历；短语纠正更新已确认经历。
- [x] 运行学习与消息 Dashboard/发送相关检查，提交。

## Task 3：同义问题的资料选择（独立任务）

Files: src/core/candidate_evidence.js、tests/candidate_evidence_smoke.js。

Interface: selectRelevantCandidateMaterial 原参数及输出保持不变。

- [x] 回归：12 条较新无关资料前，旧排障经历仍被难题提问选中；另测合作和个人贡献；岗位/公司范围继续有效。运行见失败。
- [x] 增加少量跨职业通用主题匹配，例如排障/定位问题/遇到难题 → problem_solving；保留范围、字数、数量与文字精确相关度。
- [x] 运行候选人经历与跨模块检查，复核 diff 后提交。

## Task 4：专项简报与真实面试题

Files: src/core/mock_interview.js、src/application/mock_interview/index.js、src/adapters/models/structured.js、tests/mock_interview_contract_smoke.js、tests/mock_interview_service_smoke.js、tests/candidate_learning_journey.js。

Interface: buildInterviewBrief 使用生产分析字段；buildInterviewProgress(brief, turns) 返回当前覆盖和已问问题；步骤质量错误携带可识别错误码，最多一次定向重新生成。

- [x] 回归：coreRequirements/requirementMatches 进入简报；到岗/薪资题及重复题被识别；离职动机和项目深挖正常；生成反馈后改出能力题，数据库只保存一次回答。运行见失败。
- [x] 修复简报字段并补充动态覆盖输入，`generateMockInterviewStep({ context, settings, turns, progress, questionRevision })` 复用原模型调用；不新增浏览器操作。
- [x] 运行面试契约/store/service/Dashboard 及 Agent 协议检查，提交。

## Task 5：内容验证与最终门禁

Files: docs/superpowers/reports/2026-10-03-candidate-learning-gap-closure.md、现行三模块说明。

- [x] 匿名场景验证跨岗位回复、一般及专项面试、一般及专项简历，不以 Mock 文案替代真实内容评估。另用匿名产品岗位确认未套用工程师题目和简历内容。
- [x] 运行完整 npm test，记录实际跳过项；具备 Playwright 运行库时要求浏览器分支执行。执行同一 185 项清单的 `tests/run_all.js --browser-required`，最终退出码 0。
- [x] 核对需求与报告、提交源码/文档，说明安装包和真实平台验收边界。

## 验收中追加的必要修复

- 简历模型输入经过 Unicode 规范化，中文标点会变成半角标点；现在只对可唯一对应的原文锚点恢复原始片段，保持逐字与职责边界校验。
- 浏览器必跑门禁发现 390px 消息列表首项过于靠下；复用现有移动布局，把主题切换放到品牌同行，消息来源与状态放到同一行，保留全部内容。
- 最终源码冻结在 `283160153b2ebe5dcf869009f65e048936604d63`。首次完整检查因 dashboard_zhaopin_smoke 超时未通过；同一源码单项复测通过，再次完整检查 185 项全部通过并要求浏览器分支执行。最终结果与范围见实施报告。
