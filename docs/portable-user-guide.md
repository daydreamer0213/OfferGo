# OfferGo v1.4.0 便携版使用说明

普通 Windows 用户建议使用同版本的 **OfferGo-Setup-1.4.0.exe** 安装程序，安装后从桌面小狗图标启动。本压缩包适合便携运行或交给 Agent 使用，不是标准安装器。

## 启动工作台

1. 将整个压缩包解压到可写目录，例如 `D:\Apps\OfferGo-portable`，不要在压缩包内直接启动。
2. 双击 `Install.bat` 检查内置 Node.js、依赖和 Microsoft Edge。检查成功后双击 `Start.bat`。
3. 工作台打开后，在 **招聘平台** 选择 BOSS、智联或两个平台，在专用 Edge 中登录所选平台。
4. 在 **模型与设置** 填写模型服务 Key，点击 **测试连接并保存**。随后上传简历，确认匹配偏好和搜索方案，再进入 **今日任务**。

首次使用详情见[首次使用说明](docs/onboarding_workflow.md)，找岗和沟通见[每日使用说明](docs/daily_workflow.md)。所有对外沟通、回复和简历发送，都需要先确认具体目标。

## 交给 Agent 使用

让 Agent 阅读[无界面操作说明](docs/agent-operation.md)，通过现有 CLI 和 stdio 协议运行，不需要打开工作台或在模型设置填 Key。操作资料请选择 D 盘独立目录；同一简历可以复用已有分析，新一次使用采用新的操作编号。

## 数据与更新

通过 `Start.bat` 启动的工作台将运行资料保存在 `%LOCALAPPDATA%\RoleFlow\Data`，专用 Edge 登录资料位于 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`；它们不会随压缩包移动到另一台电脑。Agent 和 CLI 显式指定的数据目录以启动参数为准。

本包包含固定版 Node.js、依赖和匿名示例，不包含任何人的 Key、真实简历、岗位数据库、聊天记录或浏览器登录资料。升级前保留自己的运行资料，不覆盖或删除活动数据库；更换电脑后重新配置 Key 并登录平台。

本版变化见[版本说明](docs/releases/v1.4.0.md)，数据位置与交付范围见[资料边界](docs/release_boundary.md)，故障处理见[运行说明](docs/operations.md)。
