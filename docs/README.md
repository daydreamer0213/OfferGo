# OfferGo 文档导航

## 用户从这里开始

**[用户说明与设计指南](user-guide/README.md)** 是当前产品的统一阅读入口，2026-10-16 按源码 `1d8eab0` 核对。它说明项目整体、首次使用、找岗判断、沟通与进展、简历、面试、求职体检，以及设置和恢复；各章展开设计理由、实际处理步骤与具体例子。

- 想先弄懂项目：[指南总览](user-guide/README.md)。
- 想按顺序使用：[首次使用](user-guide/01-getting-started.md)。
- 想区分已实现、待验收与安装版：[当前能力和文档地图](user-guide/08-status-and-documents.md)。
- 正在用公开安装版：[安装版使用说明](installed-user-guide.md)。

## 新会话必读

按以下顺序读取，不要先加载历史聊天或整个 `superpowers` 目录：

1. [`../AGENTS.md`](../AGENTS.md)：长期安全、质量、浏览器和数据边界。
2. [`user-guide/08-status-and-documents.md`](user-guide/08-status-and-documents.md)：当前源码、发布版和文档适用范围。
3. [`superpowers/plans/2026-10-09-four-step-acceptance.md`](superpowers/plans/2026-10-09-four-step-acceptance.md)：活跃验收任务，先看顶部最新记录。`PROJECT_HANDOFF.md` 和 `NEXT_PHASE.md` 下方正文保留较早截面，不替代当前清单。
4. 当前任务直接涉及的源码、测试和一份对应设计；核实对象后再引用历史证据。

## 当前产品文档

以下文档需要与当前代码持续保持一致：

- [`user-guide/README.md`](user-guide/README.md)：当前用户说明与模块设计主入口。
- [`offergo-project-map.md`](offergo-project-map.md)：v1.4.1 基线的图形解释；新能力和默认判断以用户指南为先。
- [`offergo-product-module-flows.md`](offergo-product-module-flows.md)：v1.4.1 各页面与消息分支图，保留历史版本范围。
- [`../README.md`](../README.md)：项目定位、安装方式、主要能力和快速开始。
- [`releases/v1.4.1.md`](releases/v1.4.1.md)：主题按钮重叠修复；公开状态以 GitHub Release 为准。
- [`releases/v1.4.0.md`](releases/v1.4.0.md)：OfferGo 名称、双平台找岗、消息、简历和面试改进的正式版本说明。
- [`product_spec.md`](product_spec.md)：发布基线和历史设计规格，顶部列明与当前默认判断的差别。
- [`architecture.md`](architecture.md)：当前分层、普通用户与 Agent 共用流程、已建立的护栏和仍需逐项处理的依赖。
- [`lifecycle.md`](lifecycle.md)：扫描、工作流、分析、沟通和消息发送的状态负责人、恢复结果与事务边界。
- [`daily_workflow.md`](daily_workflow.md)：较早日常流程细节；当前操作和判断见指南第02、03章。
- [`onboarding_workflow.md`](onboarding_workflow.md)：模型配置、简历解析、画像与筛选方案首次使用流程。
- [`agent-operation.md`](agent-operation.md)：Agent 不打开前端、不填写 Key，直接通过 CLI 和 stdio 协议运行项目。
- [`llm_contracts.md`](llm_contracts.md)：画像、岗位理解、分开匹配、消息学习、简历优化和面试任务的当前模型契约。
- [`resume_and_feedback_workflow.md`](resume_and_feedback_workflow.md)：简历版本、消息回复学习、确认经历及平台简历动作。
- [`frontend-ux-principles.md`](frontend-ux-principles.md)：按用户当前任务取舍信息、自然展示与体验验收的依据；不是所有页面都已达标的证明。
- [`roleflow-decision-matrix.md`](roleflow-decision-matrix.md)：当前默认入口与旧二维评分机制的适用范围；普通用户先看指南第02章。`roleflow-terminology.md` 保留工程字段解释。
- [`superpowers/reports/2026-10-09-documentation-reconciliation.md`](superpowers/reports/2026-10-09-documentation-reconciliation.md)：本次全仓文档核对范围、修正项及验证记录。
- [`operations.md`](operations.md)：日志、错误码、恢复和排错方法。
- [`release_boundary.md`](release_boundary.md)：安装包、隐私数据和外部操作边界。

## 专项设计与实现范围

- [`mock_interview_design.md`](mock_interview_design.md)：用户确认的故事准备、深度追问与岗位定制主次。主动初稿、编辑补充、保存重开和选故事练习已落地；内容审阅与整体效果边界见指南第05、08章，不能只按旧“待落实”标签理解。

## 历史记录

- [`releases/v1.3.2.md`](releases/v1.3.2.md)：旧名称 RoleFlow v1.3.2 的历史版本说明。
- [`superpowers/reports/2026-09-04-v1.3.2-release-acceptance.md`](superpowers/reports/2026-09-04-v1.3.2-release-acceptance.md)：v1.3.2 精确版本发布、目录问题诊断和两轮人工验收环境准备回执。
- [`releases/v1.3.1.md`](releases/v1.3.1.md)：已发布 v1.3.1 的历史版本说明。
- [`superpowers/reports/2026-09-04-v1.3.1-release-acceptance.md`](superpowers/reports/2026-09-04-v1.3.1-release-acceptance.md)：v1.3.1 磁盘清理、精确版本发布和新用户模拟验收回执，不代表 v1.3.2 验收结果。
- [`releases/v1.3.0.md`](releases/v1.3.0.md)：已发布 v1.3.0 的历史版本说明与验证记录。
- [`releases/v1.2.2.md`](releases/v1.2.2.md)：已发布 v1.2.2 的历史版本说明；不代表当前正式版。
- [`releases/v1.2.1.md`](releases/v1.2.1.md)：已发布 v1.2.1 的历史版本说明；不代表当前正式版。
- [`releases/v1.2.0.md`](releases/v1.2.0.md)：已发布 v1.2.0 的历史版本说明；不代表当前 source candidate。
- [`releases/v1.0.0.md`](releases/v1.0.0.md)：已发布 v1.0.0 的历史版本说明；不代表当前 source candidate。

- [`superpowers/reports/2026-10-08-deep-effect-acceptance.md`](superpowers/reports/2026-10-08-deep-effect-acceptance.md)：全模块独立效果标准、真实合成资料输出、修复与未验证范围；不代表真实招聘平台验收或新安装版发布。

以下内容保留当时的设计、计划与验收证据，不代表当前版本状态：

- `runtime_flow_review.md`
- `remediation_plan.md`
- `resilience_audit.md`
- `completion_audit.md`
- `two-run-workflow-validation.md`
- `boss-communication-calibration.md`
- `communication_live_acceptance.md`
- [`PROJECT_HANDOFF_2026-09-10.md`](PROJECT_HANDOFF_2026-09-10.md)：9 月 10 日交接原文，保留当时分支和验收状态。
- [`NEXT_PHASE_2026-09-10.md`](NEXT_PHASE_2026-09-10.md)：9 月 10 日主控索引原文，不代表当前待办。
- `prototypes/roleflow-dashboard/`：早期页面原型，保留设计过程，不代表当前 OfferGo 页面。
- `superpowers/plans/`
- `superpowers/specs/`
- `superpowers/reports/`

历史报告保留当时结论；需要纠正阅读范围时，在入口明确标注日期和对象，不把后来的结果伪装成当时已经完成。冲突时先核对版本、入口与用户要求，再以对应源码、运行及内容证据判断。

## 事实优先级

1. 当前用户确认的要求与项目边界，决定产品应该怎样做。
2. 对应版本的源码，以及该版本实际运行和内容证据，判断已经做到什么；自动检查不替代内容效果。
3. 用户指南和当前专项设计；活跃任务以四步清单的顶部最新记录为准。
4. 带日期的发布交接、历史报告、实验设计与计划，用于追溯，不能覆盖当前事实。

数据库、真实简历、日志、浏览器登录态、本机密钥和真实消息正文不属于项目文档，不得提交到公共仓库。
