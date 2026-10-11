# 原生补充资料问题 Implementation Plan

> **For agentic workers:** 按执行计划逐步处理；独立代码复查使用 requesting-code-review，实施不委派共享文件。

**Goal:** 让合法且没有草稿的补充资料问题显示并允许用户继续回答。

**Architecture:** 复用normalizeReply和现有事实请求/回答流程，仅去除提问状态额外绑定问题覆盖条目的条件；已有事实、作用域、覆盖、草稿和执行校验继续执行。

**Tech Stack:** Node.js22、已有assert回归和SQLite；不加依赖。

## Global Constraints

沿原授权原四步与实际职责，不自动发布、不发送、不重放不确定动作、不改模型或提示、不减少正式JD覆盖。复用当前隔离工作区；生成数据和临时目录置于D盘。

### Task 1: 共用协议与完整事实回答回归

Files: src/core/message_reply_contract.js；tests/message_reply_contract_smoke.js；tests/message_discovery_smoke.js。

- [x] 先在英语提问现有用例中令responseItems/coverage为空，验证仍保存missingFact、messages为空、stage为needs_user_action；增加未确认使用事实、错误覆盖和带草稿的反例。
- [x] 消息发现现有project_status用例改为经createMessageReplyAnalyzer验证，模型返回requiredFactKeys:[project_status]、usedFactKeys:[]、responseItems:[]、coverage:[]、missingFact及messages:[]；随后调用answerMissingMessageFact，模型只用用户已回答事实，保留正常完整草稿覆盖，检查草稿保存、问题清除及错目标回答拒绝。
- [x] 用D盘临时目录运行两个回归，记录修前UNKNOWN_FACT/缺问题失败，排除环境错误后再改产品。
- [x] 最小实现canAskForUnansweredKey = !normalized.messages.length && normalized.requiredFactKeys.includes(unansweredKey)；安全key/未提供事实/coverage校验保持原调用顺序。
- [x] 两个回归通过后，用上一轮两条实际原始响应在当前实现回放：原响应无补写地进入待确认，事实未确认且带草稿的反例仍拒绝；零模型和平台调用。
- [x] 独立只读审查已通过（无重要阻断）；协议、消息发现、消息学习和Dashboard相关检查在准确28476bdf完整门禁中通过。原单独运行末次输出丢失记录保留，未据句柄猜终态。

### Task 2: 准确版本及普通Edge

- [x] 提交后为该SHA准备D盘准确验证副本，固定源码/配置指纹，运行tests/run_all.js --browser-required并等待同SHA CI。
- [x] 在独立虚拟库经普通Edge核对原生问题表单、答案提交、草稿状态；冻结重放或模拟模型须明确标记零新质量样本，不替代真实模型效果。
- [x] 保留原8800/8801及82/77、原始简历/设置/失败，恢复原Edge页面和同一Codex前台。
- [x] 更新原四步当前检查点，继续其他效果及机会质量，不把此修复当作整体完成。
