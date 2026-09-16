# 由本机 Agent 安装并使用 OfferGo

这份流程供已经登录 Codex 的本机 Agent 执行。目标是把 OfferGo 安装到本机、完成离线检查，并让用户在模型设置中启用 Codex。安装过程不得读取、复制或展示 API Key、Codex 登录凭据、浏览器 Cookie、真实简历和招聘网站登录资料。

## 1. 放置项目

有 `D:` 盘时，把仓库、依赖、构建产物和临时验收数据放到 `D:\DevData`。推荐目录：

```powershell
New-Item -ItemType Directory -Force -Path D:\DevData | Out-Null
Set-Location D:\DevData
git clone https://github.com/daydreamer0213/OfferGo.git
Set-Location .\OfferGo
```

成功信号：当前目录包含 `package.json`、`src`、`scripts` 和 `tests`。如果目录已经存在，先确认它是 OfferGo 仓库，再使用正常的 Git 更新流程；不要删除用户数据目录来解决代码更新问题。

## 2. 检查本机能力

```powershell
node --version
npm --version
git --version
codex --version
```

成功信号：Node.js 为 22.5 或更高版本，Git、npm 和 Codex 都能正常输出版本。随后让 Codex 在自己的正常交互入口确认已登录；不要检查或打印它的凭据文件。

如果 Codex 不存在、版本不受支持或尚未登录，停止在这里并把缺少的项目告诉用户。不要改成索要 API Key，也不要在两种计费方式之间自动切换。

## 3. 安装依赖并运行离线检查

```powershell
npm ci
npm test
```

成功信号：依赖安装结束，完整离线检查全部通过。离线检查不会访问招聘网站，也不需要真实简历、真实模型或 API Key。

失败时保留完整错误编号，先修复依赖或代码问题，再重新运行失败项和完整离线检查。不要通过删除数据库、跳过测试或放宽安全校验来绕过失败。

## 4. 启动 OfferGo

源码方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-workspace.ps1
```

成功信号：终端显示本地工作台地址，浏览器打开 OfferGo 页面。也可以由维护者运行 `BuildInstaller.bat` 生成标准安装器；大型构建数据默认放在 `D:\DevData\OfferGo-installer`。

## 5. 启用本机 Codex

1. 打开“模型设置”。
2. 选择“使用本机 Agent”。
3. 阅读额度和数据发送说明。
4. 点击“测试 Codex 并启用”。
5. 等待页面显示“本机 Agent 连接测试通过，已启用免填 API Key 模式”。

成功后，“下一步：填写简历”会解锁。免填 API Key 不等于免费：模型任务会消耗当前 Codex 账号的套餐额度。OfferGo 会把已做本地隐私遮盖的简历文本、职位信息和任务提示发送给 Codex；不会保存 Codex 登录凭据。

常见恢复动作：

- “没有找到本机 Codex”：安装 Codex 并确认命令可用，再返回重试。
- “本机 Codex 需要更新”：更新 Codex，再返回重试。
- “本机 Codex 尚未登录”：在 Codex 的正常入口完成登录，再返回重试。
- “本机 Codex 额度不足”：检查套餐或等待额度恢复，再返回重试。
- “本机 Codex 暂时不可用”：先确认 Codex 能独立运行并能访问网络，再返回重试。

失败不会部分启用 Agent，也不会自动回退到 API Key 模式。相同的重复点击只执行一次检测；不同任务会串行处理，避免本机 Agent 被重复并发调用。

## 6. 把外部操作留给用户

安装和模型验证完成后停止。不要替用户登录招聘网站，不要读取真实账号凭据，不要扫描职位，不要发起沟通、发送消息或投递简历。用户完成登录后，OfferGo 仍会按页面上的确认步骤执行所有招聘网站操作。
