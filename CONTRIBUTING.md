# 贡献指南

感谢你改进 OfferGo。项目优先保证求职数据隐私、账号安全、岗位详情覆盖率和推荐质量。

## 开始之前

1. 先搜索现有 Issue；涉及行为、架构或 BOSS 页面适配的改动，请先用 Issue 说明问题、证据和预期结果。
2. Fork 仓库并从当前主分支创建短期分支。
3. 使用与 CI、安装包一致的 Node.js **22.23.1**，运行 `npm.cmd ci` 安装锁文件中的依赖。`package.json` 的最低版本声明不代表所有更早版本都经过验收。
4. 修改后运行相关分组检查，再运行 `npm.cmd test`。当前清单有 195 项：`test:fast` 40 项、`test:integration` 150 项、`test:package` 5 项。发布前运行 `npm.cmd run test:release`，要求页面检查实际执行。数字以 `tests/test_manifest.js` 为准；离线测试不得访问真实招聘账号、发送消息或执行沟通。

页面检查需要 `.github/browser-tests` 中锁定的 Playwright 和已安装的 Edge。它是开发测试依赖，不是产品运行依赖。CI 将它安装到 `D:\DevData\OfferGo-browser-checks`，通过 `NODE_PATH` 加载；本机测试也可按同样方式准备。不要把测试浏览器依赖放进安装包。

## 提交要求

- 只提交可复现问题所需的最小改动，并为非简单行为保留回归检查。
- 不得提交真实简历、姓名、联系方式、账号凭据、Cookie、API Key、聊天内容、岗位数据库或浏览器配置。
- 涉及 BOSS 的测试优先使用脱敏 fixture。真实页面只做必要的最小验证，并遵守项目的只读边界和用户确认门槛。
- 不得为了速度降低岗位详情覆盖、推荐质量、风控保护或失败停止机制。
- 提交内容需兼容本项目的 `AGPL-3.0-only` 许可证。

安全问题不要创建公开 Issue，请按 [SECURITY.md](SECURITY.md) 报告。
