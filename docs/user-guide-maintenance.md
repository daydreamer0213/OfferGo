# 用户指南的实现参考与维护说明

本页供开发、实现核对和文档维护使用。普通使用与模块设计从[用户指南](user-guide/README.md)阅读。

## 核对基准

首次建档日期为2026-10-16，业务源码基准为1d8eab0，指南初版为cb55d27。公开安装版v1.4.1对应19dd6b1，后续改进在开发版中使用。

当前默认匹配使用whole_jd：模型结合完整JD、已确认卡绑定的原简历与筛选上下文给四档投递建议；代码校验本地范围、材料与引用。旧split、70/30机制保留在兼容路径，历史说明见[四档规则](roleflow-decision-matrix.md)。

## 01 首次使用：把简历变成可执行的求职方向
- [首次使用流程](../src/application/onboarding/run.js)、[Agent 首次使用](../src/application/onboarding/agent_onboarding.js)。
- [简历解析](../src/core/resume_parser.js)、[画像整理](../src/core/profile_onboarding.js)、[匹配卡](../src/core/matching_card.js)。
- [搜索方案](../src/core/search_plan.js)、[工作台入口](../src/dashboard/server.js)：资料、匹配卡和方案确认。

## 02 找岗与岗位判断：先看实际工作，再判断值不值得投
- [默认配置](../src/config.js)、[岗位分析流程](../src/core/job_analysis.js)。
- [完整 JD 工作判断](../src/core/job_work_matching.js)、[最终决策入口](../src/core/job_match_decision.js)。
- [本地范围规则](../src/core/scoring.js)、[默认选择](../src/core/decision_policy.js)、[候选库存](../src/core/workflow_inventory.js)。
- [岗位保存](../src/storage/job_store.js)、[结果有效性](../src/core/analysis_revision.js)、[今日任务](../src/dashboard/pages/today.js)。

## 03 沟通、消息与进展：把准备、确认和执行分清楚
- [单轮任务](../src/application/workflow/index.js)、[双平台安排](../src/application/workflow/dashboard_service.js)。
- [主动沟通](../src/application/communication/index.js)、[执行与结果](../src/core/communication_executor.js)。
- [消息发现](../src/core/message_discovery.js)、[岗位上下文](../src/application/message_discovery/job_context.js)。
- [回复确认与发送](../src/application/message_reply_sending/index.js)、[平台简历动作](../src/application/message_actions/index.js)。
- [本人进展](../src/core/candidate_progress.js)、[事实有效期](../src/core/candidate_fact_policy.js)、[无回复跟进](../src/core/message_follow_up.js)。

## 04 简历工作室：沿原简历结构，把真实工作写清楚
- [简历优化流程](../src/application/resume_optimization/index.js)：生成、保存、启用与资料组织。
- [修改依据与启用检查](../src/core/resume_optimization.js)。
- [分区与全文编辑页面](../src/dashboard/pages/resume_optimization.js)。
- [草稿及版本保存](../src/storage/resume_optimization_store.js)。

## 05 面试准备与训练：先讲清工作，再练深入追问
- [用户确认的面试设计](mock_interview_design.md)。
- [故事、训练与确认流程](../src/application/mock_interview/index.js)。
- [故事与问答校验](../src/core/mock_interview.js)、[生成任务](../src/adapters/models/structured.js)。
- [面试页面](../src/dashboard/pages/mock_interview.js)、[准备稿和训练保存](../src/storage/mock_interview_store.js)。

## 06 求职体检：根据什么判断先改哪里
- [样本与策略轮次](../src/storage/funnel_store.js)、[成熟与分母](../src/core/funnel_maturity.js)。
- [统计诊断与比较](../src/application/funnel_analysis/index.js)、[体检视图](../src/application/funnel_analysis/health_view.js)。
- [具体反馈取证](../src/storage/funnel_feedback_store.js)、[反馈检查](../src/application/funnel_analysis/feedback_review.js)。
- [体检页面](../src/dashboard/pages/funnel.js)、[收到的联系](../src/application/funnel_analysis/incoming_contacts.js)。

## 07 设置、资料与异常恢复
- [平台工作区](../src/core/platform_workspace.js)、[浏览器就绪检查](../src/core/browser_readiness.js)：平台与页面准备。
- [运行路径](../src/core/runtime_paths.js)、[密钥保存](../src/core/secret_store.js)：程序、数据目录和系统加密。
- [模型设置](../src/core/model_settings.js)、[工作台入口](../src/dashboard/server.js)：配置验证、诊断与页面动作。
- [运维说明](operations.md)、[安装版说明](installed-user-guide.md)：开发排查与安装版补充细节。

## 运行参数参考

参数见[src/core/product_policy.js](../src/core/product_policy.js)。以下保留本次核对值，按实际改动更新。

以下为本次源码的正式默认值，不是要求用户必须完成的投递指标：

| 项目 | 默认安排及含义 |
| --- | --- |
| 联系目标 | 每日目标 70、每轮上限 40；实际仍取决于可用岗位、用户选择与结果核验 |
| 轮次 | 每天最多 3 轮，前两轮为常规轮，第三轮只在库存不足等条件成立时追加 |
| 扫描轮次间隔 | 默认 120 分钟；页面提供的“提前开始下一轮”需要明确确认，只解除这一次轮间限制 |
| 获取预算 | 每轮最多 120 份详情、20 页搜索；日共享上限为 360 份详情、60 页搜索 |
| BOSS 详情动作 | 有 8—14 秒随机间隔，并叠加阶段休息；不是所有动作都统一等待这个时长 |

提前开始也保留随机动作间隔、周期休息、访问记账和风控停止。模型可以并发处理已保存的岗位资料，不代表招聘页面可以并行点击。

测试期间获准的内部额度或轮间等待覆盖只适用于对应实验；随机动作节奏、休息、记账、串行、风险停止和结果不明确时的处置保留。

## 文档与状态记录

[活跃验收清单](superpowers/plans/2026-10-09-four-step-acceptance.md)的顶部最新记录说明当前交付与下一步；[交接](PROJECT_HANDOFF.md)与[后续工作索引](NEXT_PHASE.md)保留较早截面。superpowers下的specs记录设计、plans记录安排、reports记录对应版本与材料的检查结果。首次建档前有604份Markdown文档，其中计划229份、设计151份、报告169份。

## 用户表达的维护要求

遵循[前端与用户体验审查原则](frontend-ux-principles.md)：先回答用户当前要做的事，解释实际意义，再按需要展开处理逻辑。操作写清点击后发生什么；会改变选择的限制就近说明。来源合同、版本哈希、实验配额与检查管理放开发资料，避免每章重复并不代表、不能保证等泛泛说明。

设计理由用具体情境解释，保留用户理解判断与操作所需的细节。维护时核对用户要求、对应版本源码和实际结果，更新受影响章节；历史报告保留当时结论，新的结果另记。
