# CI 页面检查修复计划

目标：修复 `76e774a` 在 GitHub 缺少 Playwright 时提前退出的问题，远端必须实际执行现有页面检查。

设计：仅调整 CI 和发布测试环境。独立锁定 Playwright 版本并安装到 D 盘；通过已有 NODE_PATH 机制供测试使用，不加入产品依赖或安装包。复用现有 195 项检查和 `--browser-required` 门禁。普通 CI 给完整检查 30 分钟，发布作业另外包含打包，给 40 分钟；各测试自己的超时不变。

执行步骤：

- [x] 读取实际 GitHub 失败日志，并在没有额外 NODE_PATH 的本机复现同一模块缺失。
- [x] 增加独立测试依赖清单及锁文件，在普通 CI、发布工作流中准备相同环境。
- [x] 在干净依赖环境复验原失败入口，然后执行完整页面必需门禁。
- [x] 提交推送，读取对应 SHA 的 GitHub 作业结果；失败继续依据日志修复。
- [x] 补充验证记录，区分确定性回归、真实模型内容审查和真实平台操作，不以 CI 绿色代替内容效果达标。

本次不修改产品业务、模型提示、平台节奏、真实用户数据库或当前验收软件。没有真实 HR 发送动作。已有细分情境证据见 `2026-10-08-situational-effect-review.md`，不将本次离线检查宣称为新的真实模型验收。

## 完成记录（2026-10-09）

最终发布提交 `19dd6b18bbb8477f4e6fc5218518d3632076cf82` 已完成 195 项完整门禁，页面检查为必需项。本机最终记录为 `D:/DevData/OfferGo-release-v1.4.1/verification/full-final-19dd6b1.log`；[同 SHA 的 main CI](https://github.com/daydreamer0213/OfferGo/actions/runs/37890736460) 与 [发布作业](https://github.com/daydreamer0213/OfferGo/actions/runs/37890743089) 均成功。普通分支与标签 CI 也成功。此处只补充离线门禁与发布证据，不新增真实平台或模型效果验收结论。
