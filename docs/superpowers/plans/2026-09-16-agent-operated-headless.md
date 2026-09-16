# Agent 无界面运行实施计划

1. 保留模型任务与传输层分离的结构，新增 stdio JSON 行传输及适配器。
2. 新增 `agent-onboard --resume <path> --operation-id <uuid> --agent` 与 `agent-confirm`；同操作 UUID 处理重试，简历哈希处理画像与方案复用，`--refresh-profile` 显式强制重分析，并让扫描、补读、重评可显式使用 `--agent`。
3. 在根 `AGENTS.md` 和用户文档中写清无界面执行顺序及外部操作授权边界。
4. 加入协议、CLI 首次使用、前端无 Agent 入口和安装打包回归测试。
5. 在最终提交运行完整离线门禁并重建隔离安装候选；不再启动人工前端验收页。
