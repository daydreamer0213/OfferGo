# 让 Agent 无界面运行 OfferGo

这条路径用于用户把 OfferGo 仓库直接交给 Codex、Claude Code、Kimi 等 Agent。Agent 自己安装、检查和运行项目；用户不需要打开 OfferGo 前端，也不需要提供模型 API Key。

## 两条使用路径

- 普通用户：启动本地页面，在“模型设置”填写 API Key。
- Agent 用户：Agent 在终端运行 CLI，并直接承担模型理解和流程编排。

两条路径不共享模型设置。Agent 路径不会在 OfferGo 中保存 Agent 登录信息，也不会从项目内部再次启动一个 Agent。

## Agent 的执行顺序

1. 把仓库和临时数据放到 `D:`，例如仓库 `D:\DevData\OfferGo`、数据 `D:\DevData\OfferGo-user-data`。
2. 运行 `npm ci` 和 `npm test`。离线检查通过后再使用真实资料。
3. 每次开始使用时都可以用绝对路径运行准备命令：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 agent-onboard `
     --resume "D:\资料\resume.docx" `
     --operation-id "550e8400-e29b-41d4-a716-446655440000" `
     --agent `
     --data-root "D:\DevData\OfferGo-user-data"
   ```

4. OfferGo 会在当前终端输出一行 `offergo.agent.stdio` 请求。Agent读取 `task`、`instruction` 和 `input`，自行完成判断，再向同一进程标准输入写回一行响应：

   ```json
   {"protocol":"offergo.agent.stdio","version":1,"type":"model_response","id":"与请求完全相同","result":{}}
   ```

5. 首次使用或简历变化时，流程依次完成简历画像、匹配偏好卡和搜索计划。简历内容没有变化时，OfferGo 直接返回已经保存的画像、匹配卡和搜索计划，`result.reused` 为 `true`，不会再次调用 Agent 做分析。完成后输出的 `command_result` 包含完整匹配卡、搜索计划及其 ID。Agent 检查内容符合用户意图后确认匹配卡；已经确认过的卡重复确认也是安全的：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 agent-confirm `
     --profile 1 --card 1 --agent `
     --data-root "D:\DevData\OfferGo-user-data"
   ```

6. 用户明确要求重新分析同一份简历时，生成新 UUID 并额外传入 `--refresh-profile`。普通的第二次、第三次使用不要传这个选项。
7. 后续命令继续带 `--agent`。每次扫描会产生独立的扫描轮次，不会因为复用画像和方案而复用旧岗位结果。例如只读扫描：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 scan `
     --plan 1 --browser portable --cdp-port 9222 --agent `
     --data-root "D:\DevData\OfferGo-user-data"
   ```

## 协议边界

- `operation-id` 标识一次命令。命令因超时、中断或误重发而重试时沿用同一 UUID，OfferGo 会复用结果或从检查点继续；下一次使用生成新的 UUID。
- 新 UUID 不等于强制重做画像。简历内容相同时，新一轮只复用已经准备好的画像、匹配卡和搜索方案；岗位扫描仍会建立新的扫描轮次。只有 `--refresh-profile` 才会强制重新分析同一份简历。
- 同一个 `operation-id` 不能换成另一份简历，避免误把旧结果套到新输入。
- 同一进程每次只发一个请求；下一个请求会等当前结果通过校验后再出现。
- 响应必须是单行 JSON、使用同一任务 ID，并返回 JSON 对象。
- ID 不匹配、无效 JSON、结果过大、超时、取消或模型契约失败都会停止当前任务，不会套用到下一项。
- 请求和响应不写入模型设置，不创建 Agent 会话，也不保存 API Key。
- Agent 可以读取当前任务需要的已脱敏简历文本和职位信息；不得把这些正文复制进日志、提交或公开报告。

## 外部操作

`--agent` 只改变模型任务由谁完成，不改变招聘网站权限。扫描保持只读。沟通、发送消息或投递简历仍需要用户针对具体清单明确授权；结果不明确时停止，不自动重试。
