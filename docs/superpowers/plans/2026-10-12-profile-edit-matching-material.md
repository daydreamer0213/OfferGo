# 资料保存与匹配依据更新：有限修复计划

> 沿用用户已确认的持续整改授权，在现有隔离工作树使用 executing-plans 逐项执行，不增加代理或线程。依据 systematic-debugging 的实际页面／原生输入证据，采用 brainstorming 与 writing-plans 明确范围；不是重新定义原四步目标。

**目标：** 用户保存项目等资料时不丢事实；修改后能通过普通页面检查并确认新的匹配依据，确认前继续使用旧依据。

**架构：** 修复现有表单字段读写和画像版本／匹配卡衔接，复用原生草稿、确认及方案依赖机制。保留同源完整原简历、人工搜索条件和历史版本，不增加模型调用、学历证明或按关键词改档。

**技术：** Node.js、现有原生HTTP表单与SQLite；不安装新依赖，生成数据全部留D盘。

## 已验证问题与边界

准确91源码的真实资料副本，在普通Edge原样提交一次 `/api/profile`，303返回保存成功。原项目名称包含管道符，渲染和解析又以管道符分列；项目名被截短、时间接收名称后半段、成果落入“不主动讲”。关闭服务后用新只读连接确认已持久化。最初准备改写项目结果，但在写入前发现九列，因此取消文字改写，改作原样保存；全部首记录保留。

新画像版本为2，当前匹配卡仍绑定版本1；两阶段共6次面试／简历／筛选原生入口截取及两次回复资料组装，所有输入哈希相同，零模型HTTP、零生成效果信用。原生依赖判定 `stale=false`，实际保存页没有匹配卡确认入口；已确认卡页面写着编辑另存，却没有表单或入口。保留旧确认依据本身合理，缺少正常更新途径及错误提示才是问题。此副本错误不是此前高级岗位解释缺陷的成因，后者的真实输入本就有完整事实。

八库业务行、三实际文件、原82／77、原服务及准确91源码保持；原当前库仅条件目录发现／更新时间刷新，实际选项、来源和版本相同，不能称整个数据库不变。一个本地临时页签已关闭，服务57948退出，前台回到同一Codex。三个本地实际画面已查看，但有可见姓名，只在D盘，不能称脱敏图或复制进仓库。

## 方案取舍

采用现有表单的无损字段表示，并在未改的栏目保留原结构；字段中含分隔符、引号或换行时使用成对引号，读取遵循同一规则。每个未修改的数组字段保留原数组和元数据，避免把句子中的顿号误拆为新条目。修改后的资料生成待确认卡，显式确认后才更新依据。

独立输入框整体重做可以改善编辑体验，但不是这次必要范围；按多余列猜项目名称或替换原文分隔符会继续丢信息，不采用。保留已有普通文本格式；遇到无法确定列边界的旧提交应拒绝写入并让用户重新打开资料页，不猜测错位内容。

## Task 1：无损保存原有资料

**文件：** 新增 `src/dashboard/profile_field_lines.js`；修改 `src/dashboard/server.js` 中画像各栏目渲染／解析与 `profileFromForm`；新增 `tests/profile_edit_matching_smoke.js` 的实际HTTP回归。

**接口：** `formatFieldLines(rows)` 接收二维文本字段，返回可编辑文本；`parseFieldLines(text, { maxFields, label })` 返回二维字段。允许未引用的旧简单格式、空末列、引用内分隔符与换行、双写引号。异常引号或超过该栏目列数抛出有栏目名的错误，发生在数据库写入前。

- [x] 先写原生服务回归：合成项目名为 `项目A | 开发作品`，时间／参与范围／成果／不主动讲分别给不同非空值；读取实际表单，原样POST，再用新连接核对字段。先运行 `node tests/profile_edit_matching_smoke.js`，必须在现有代码复现名称／时间／成果错位，保留首失败。
- [x] 实现同一读写规则；空、分隔符、引号、换行及空末列有结构回归。比如 `parseFieldLines(formatFieldLines([["A | B", "他说\"完成\"", ""]]), { maxFields: 3, label: "项目" })` 必须返回原三列，不能截断或替换原字符。
- [x] 未改栏目直接使用原结构；修改栏目逐字段保留未改的数组和未展示元数据。数组中含逗号／顿号的完整句子不得因保存其他字段而被拆分或截短。修改一个成果时，项目名、时间、其他项目与贡献边界保持。
- [x] 错列／错误引用提交不得改变画像、版本或匹配卡，输入保留且提示重新检查栏目。测试应比较真实保存值，不能只查页面字串或解析器自身循环。
- [x] 运行新回归与 `node tests/onboarding_smoke.js`，只在失败或新变化要求时扩大核对。

## Task 2：资料修改进入可确认的新匹配依据

**文件：** 修改 `src/storage/candidate_store.js:updateCandidateProfile` 和 `src/dashboard/server.js:handleProfileSave/renderProfilePage/renderMatchCardPage`；扩展上述回归及 `tests/candidate_store_contract_smoke.js` 必要事务检查。

**接口：** 保留 `updateCandidateProfile(db, { profileId, profile, displayName })` 的既有返回；复用 `matchingCardFromProfile`、`createMatchingCardDraft`、`listProfileVersions`、`listMatchingCards`、`confirmMatchingCard`。不调用 `saveConfirmedMatchingCardRevision` 自动改当前卡。

- [x] 新画像版本保留真实原简历的文档归属。只通过该profile的原来源哈希查找同源文档，不能把无关投递版本或其他人的文件接入；没有可验证绑定时不编造哈希／来源。完整简历恢复仍使用现有隐私和文档绑定校验。
- [x] 画像与其新草稿在同一事务完成，草稿绑定新版本及同源文档；失败全部回滚。旧确认卡、旧方案与历史保持；用户补充偏好保留在待检查的草稿，不能被当作简历事实。
- [x] 保存后直接显示待确认卡和明确提示：资料已保存，确认前仍用旧资料筛选。已确认页提供到普通资料编辑页的入口；不再留下不能操作的编辑另存承诺。使用原确认按钮，确认后让原方案依赖变为待检查，不静默改变人工条件。
- [ ] 用实际完整原生输入验证三阶段：新草稿确认前与旧输入相同；确认后候选画像／卡／版本指纹更新，原CV仍完整同源；普通方案保存后绑定新版本且人工条件不变。面试、简历、筛选均检查真正入口，回复资料只计组装，零模型结果信用。
- [x] 检查重复提交、历史卡不可重启、另一profile的卡／文档不可混用；无事实变化保存不制造无意义的确认义务。只保留会影响真实保存、版本或来源安全的回归。
- [x] 运行 `node tests/profile_edit_matching_smoke.js`、`node tests/onboarding_smoke.js`、`node tests/candidate_store_contract_smoke.js` 及改动影响的现有资料来源回归，保留真实失败并完成有限复查。

## Task 3：准确提交与普通页面复验

- [ ] 在新的真实资料副本复验原项目名、普通保存／编辑、待确认／确认、人工方案保存与新连接重开；不修补或覆盖本次已失败副本。截取确认前后完整原生输入，保持实际保存模型及原CV，验证没有被旧缓存误用。
- [ ] 实际画面和DOM逐步核对，截图留D盘并遮盖姓名／联系信息；本地临时页签和检查服务清理，前台回同一Codex。旧库、原服务和实际文件重新核对。
- [ ] 对最终代码有限复查，冻结提交后在D盘准确源码副本运行现有完整浏览器必跑门禁及同SHA官方CI；不沿用91的历史通过。只在对应新变化或失败解释要求时重复检查。
- [ ] 更新本计划、原四步与运行检查点。继续实质基础CV上传／新确认版本传播、普通工作台完整推荐及下游默认资料、共同反馈、连续使用／最终人工验收；这次有限修复不代表全部完成。

## 当前状态与私有证据

有限源码修复及原生HTTP回归已执行：原样字段、修改后新草稿、确认前后上下文、完整同源CV、普通方案保存、两个错误表单输入保留、同公司经历删除、事务回滚和归属隔离通过。独立复查发现的两项Important已补首失败与修复；第三项名称互换反例也已先失败后通过，最终有限复查通过；普通Edge三个实际入口及准确SHA完整门禁／CI仍待执行，候选说明仍冻结未采用；原目标 active。后续按现有持续授权直接实施，不新增外部发送、发布或一周定时任务。

- [实际终结与缺陷归属](D:/DevData/OfferGo-validation/2026-10-12/matching-material-entry-probe-91e58f2-1791789913551/terminal-profile-roundtrip-and-matching-entry.json)
- [真实输入与版本边界](D:/DevData/OfferGo-validation/2026-10-12/matching-material-entry-probe-91e58f2-1791789913551/observed-roundtrip-and-matching-boundary.json)
- [新连接的持久化核对](D:/DevData/OfferGo-validation/2026-10-12/matching-material-entry-probe-91e58f2-1791789913551/readonly-reopened-persistence.json)
- [原业务资料保护](D:/DevData/OfferGo-validation/2026-10-12/matching-material-entry-probe-91e58f2-1791789913551/protected-originals-after.json)
- [条件缓存仅时间变化](D:/DevData/OfferGo-validation/2026-10-12/matching-material-entry-probe-91e58f2-1791789913551/original-catalog-time-only-comparison.json)
- [准确源码与原服务](D:/DevData/OfferGo-validation/2026-10-12/matching-material-entry-probe-91e58f2-1791789913551/source-and-services-after.json)
