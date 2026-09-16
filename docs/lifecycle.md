# OfferGo 运行生命周期

本页是当前运行状态的权威导航。它说明每类记录由谁负责、如何与父记录关联，以及异常退出后应该得到什么结果。具体字段和合法转换仍以当前 schema、store 和回归测试为准。

## 记录与负责人

| 记录 | 存储负责人 | 应用负责人 | 主要状态 | 父子关系 |
|---|---|---|---|---|
| Onboarding Run | `storage/onboarding_store.js` | onboarding 应用用例 | queued、running、completed、failed | 生成候选人画像、匹配卡和搜索方案 |
| Batch / Scan Run | `storage/scan_store.js` | CLI 扫描与 workflow 应用用例 | running、completed、partial、failed、interrupted | Workflow 可绑定一个 scan run 和岗位 batch |
| Workflow Run | `storage/workflow_store.js` | `application/workflow` | created、scanning、analyzing、review_required、communicating、paused、completed、interrupted、failed、stopped | 管理扫描、岗位分析和沟通批次 |
| Workflow Job Task | `storage/workflow_store.js` | workflow analysis executor | pending、retry_pending、running、succeeded、failed、stopped | 必须属于一个 Workflow Run；分析尝试属于一个 task |
| Communication Batch | `storage/communication_store.js` | `application/communication` | confirmed、running、paused、stopping、completed、stopped、interrupted、failed | 可绑定 Workflow；每个 item 固定岗位和确认时快照 |
| Message Send Batch | `storage/message_reply_send_store.js` | message reply sending 应用用例 | confirmed、running、completed、stopped、interrupted | 每个 item 固定会话、草稿和目标身份 |
| Funnel Strategy Round | `storage/funnel_store.js` | funnel analysis 应用用例 | active、closed | Funnel entry 永久绑定创建时的策略轮次 |

## 主工作流

```text
created
  -> scanning
  -> analyzing
  -> review_required
  -> communicating
  -> completed

scanning / analyzing -> paused -> scanning / analyzing
scanning / analyzing / communicating -> interrupted -> 显式继续
非终止状态 -> stopped
不可恢复错误 -> failed
```

- `completed`、`failed` 和 `stopped` 是终止状态，不能再次继续。
- `review_required` 表示本地候选清单已经可以由用户复核，不代表已授权沟通。
- 暂停和停止先写控制请求，再由正在运行的子进程安全落盘；超过宽限时间才由精确状态检查收口。
- 继续扫描时必须复用已冻结的浏览器身份、搜索范围和批次归属。继续分析不需要重新检查招聘网站页面。

## 异常与恢复

| 事件 | 必须得到的结果 |
|---|---|
| 同一站点已有扫描租约 | 新扫描拒绝启动，不创建第二个并行访问者 |
| 扫描子进程失去租约 | 当前操作取消，run 进入可解释的中断或失败状态 |
| Dashboard 或进程异常退出 | 下次状态读取先根据心跳、子任务和批次结果调和父状态 |
| 浏览器登录失效、风控或页面身份不符 | 当前平台操作停止；已保存数据保留；不自动换浏览器或重试外部动作 |
| 模型任务失败 | 记录 attempt 与错误；仅满足重试条件的任务进入 retry_pending |
| 沟通结果不明确 | item 标为 ambiguous，批次停止，必须人工核对，不能自动重试 |
| 重复开始、继续或控制请求 | 返回当前有效状态或幂等结果，不重复创建批次和子任务 |

## 事务边界

- 单个 store 内的多表写入使用 `BEGIN IMMEDIATE`，任何一步失败都回滚。
- 一个应用用例需要同时更新多个 store 时，由该应用用例拥有最外层事务；内部 store 不得提前提交。
- 父记录状态、子记录状态和绑定 ID 在需要共同成立时必须在同一事务完成。
- 浏览器或模型调用不得放在长时间数据库事务中；先取得或声明任务，再执行外部工作，最后用身份和版本条件提交结果。

## 不变量

1. 运行中的子任务必须引用存在且未终止的父任务。
2. 同一个平台同一时间最多有一个有效扫描租约。
3. 已终止的 item 不会因恢复再次执行外部动作。
4. Workflow 的 scan、analysis 和 communication 绑定必须属于同一候选人和 Search Plan。
5. 用户确认的沟通批次是不可变快照；恢复只能处理尚未执行且结果明确的剩余项。
6. 相同 Agent `operation-id` 只能对应同一份简历；简历内容相同不等于同一使用轮次。
7. Funnel 历史不因后续策略修改重新归类。

## 修改规则

- 新增状态前，先更新本页、schema/store 的状态集合、合法转换和恢复测试。
- 新增父子关系时，必须同时增加归属校验和孤儿恢复测试。
- 不把所有生命周期合并成一张万能表；每个领域保留自己的记录和负责人。
