# 岗位筛选统一决策实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划默认在当前任务内顺序实施，不要求额外 Agent 或新会话。

**Goal:** 修复资格判断丢失、资格混入能力分和证据失真的问题，使最终推荐正确、有用、可解释，并保留合理的可迁移机会。

**Architecture:** 继续使用当前模型理解 JD、分阶段匹配和本地四档规则。统一条件与证据，由一个最终决策入口生成结果，页面、岗位池和消息模块共用该结果。新增最多三个纯规则模块，复用现有比较、重试、存储和浏览器流程。

**Tech Stack:** Node 22、CommonJS、Node 标准库、原生 SQLite、现有 Dashboard/CLI、现有模型适配器和 Playwright 检查；不新增运行依赖。

**Status:** 2026-10-10 用户批准并授权计划内操作，目标持续执行。Tasks 0–4 已提交，Tasks 0–4 基线 b7c1a9a 的 CI 页面轮询检查失败，受控回归已修复，不能记为 CI 通过。Task 5 产品链路与后续恢复修复已实现；第十、十三、十四、十六个冻结副本197项严格门禁通过。第十七轮发现旧接口数量断言和崩溃恢复样本缺少当前分析版本，已保留失败、更新样本并验证恢复只处理5个未完成任务；新增北京时间跨午夜显示检查已失败→通过。第十七轮又发现迁移时期的函数体冻结断言未登记本次有意改变的恢复接口，已由实际事务/恢复行为覆盖；第十八轮5586f75在面试时间夹具的旧UTC假设失败；已将“北京时间下午三点”输入修正为对应UTC07:00，原15:00展示期望保留并通过。第十九个源码副本d1ae334的197项完整浏览器必跑门禁已通过；新增智联分析恢复入口与额度停止修复已在第二十个副本3e966caa通过197项完整浏览器必跑门禁，代码收口及暂停计数修复已提交为5e6f82e；7598636的197项完整浏览器门禁与CI通过，5e6f82e的精确版本门禁和CI在本记录写入时仍运行。Task 6 的38类、20份固定全文及原31例实际输出已判读；31例严格标签8/31，不宣称全部达标。新空操作库实际Edge双平台采集完成：BOSS60个岗位、57份完整JD、0待补、3份本地边界无需读取；智联59/59份JD。模型余额不足阻塞剩余分析，已验证额度暂停、保留进度及继续入口；13份曾被检查点覆盖的分析已核对资料与岗位内容后从生产缓存恢复，0网络请求。实际页面确认主投/可投3个默认选中、慎投13个不自动选中，未执行外部沟通。原不确定简历动作及长期观察待办保留，继续完成离线与隔离环境；不提前发布。详见[效果记录](../reports/2026-10-10-matching-decision-effects.md)、[原任务检查点](../reports/2026-10-10-four-step-acceptance-checkpoint.md)和[统一设计](../specs/2026-10-10-matching-decision-convergence-design.md)。

**本轮授权：** 用户明确允许自主推进所有计划内操作；标签页休眠时先自行恢复，必要时可激活，无需等待手动显示。该授权不允许重放结果不确定的发送，也不改变账号节奏、目标核验或本轮不自动发布的范围。

**空间管理补充：** 用户要求先恢复 D 盘空间，再继续实施；执行期间尽量保持 15–20 GiB 可用，目标接近 20 GiB。开始大型检查、复制验收环境或生成模型资料前检查空间；不足 15 GiB 时先清理可再生缓存或归档已结束的测试资料。当前数据、账号资料、运行依赖和原验收证据保留。归档清单及逐文件校验放 `E:\迁移目录\OfferGo-2026-10-10-space`。

**Task 0 当前检查点：** VM 已补齐浏览器事件接口，并实际触发搜索条件变化，验证重新查询期间立即禁用按钮及查询后状态；真实 Edge 双平台标题、就绪状态及搜索范围也已验证。D 盘冻结副本缺少依赖链接、Git 版本及历史对象的环境问题均已定位并补齐；两处测试仍断言旧决策版本，已同步日期规则的新版本，定向通过。最终 `task0-baseline/full-gate-complete.log` 为 195 项全部通过，进程退出码 0。旧修复及回归共 15 个文件独立暂存；后续条件实现不混入 Task 0 提交。

**空间检查点：** 2026-10-10 已恢复超过 20 GiB 可用空间。旧版本、过期首次使用环境、非活动旧浏览器资料与缓存已逐文件 SHA-256 校验后归档到 E；旧浏览器路径用可恢复目录链接保留。历史测试目录采用压缩归档并对每个源文件与归档内容比对，通过后才清除原目录。当前验收库、正在运行的浏览器资料、运行时和其他项目的活动数据未移动。

## Global Constraints

- 原四步验收仍有效，最新进度见[检查点](../reports/2026-10-10-four-step-acceptance-checkpoint.md)。本计划对应第 3 步的整改，不提前打包。
- 先收口当前未提交的四组修复，不将旧完整门禁或 CI 当作工作区当前通过证据。
- 70/30 能力权重、二维矩阵、年限宽松规则保持不变；资格退出能力评分是本次明确修复。慎投范围是否进一步收紧，先量化后由用户决定，未决定时保持现行政策。
- 不降低卡片/JD 覆盖、逻辑目标、节奏或预算；不因测试时间缩减效果检查。
- 不变更 HTTP 路由、CLI 参数与退出行为、`offergo.agent.stdio` v1 外层协议、SQLite schema、现有用户数据及 `%LOCALAPPDATA%\RoleFlow` 兼容路径。
- 活动推荐使用新判断；历史发送、不可变授权批次和原始标签不改写。
- 不访问真实平台做自动发送。真实 Edge 验证保持现有登录、后台、平台内串行、固定标签、身份核验和 `trusted_pane` 路径。
- 不确定发送不能重放。当前智联简历动作 `ambiguous`、点击计数 1 的记录继续保留。
- 实际简历/JD/账号/模型密钥/截图/数据库/长日志与新生成测试资料放 D 盘，不进入 Git，不写项目外长期记忆。
- 每阶段先做能证明缺陷的失败检查，再实现、复测、核对非目标影响；阶段完成前运行完整门禁。不得删除失败测试、放宽期望或伪造完成来使门禁通过。

## 执行顺序与阶段交付

| 阶段 | 任务 | 完成后得到什么 |
|---|---|---|
| 0. 固定起点 | Task 0 | 已有四组修复完整通过并独立冻结，原验收待办可接续 |
| 1. 条件与资格 | Tasks 1–2 | 统一条件和证据；明确冲突真正生效；关键资格未知不被抬高 |
| 2. 评分与来源 | Tasks 3–4 | 资格不再加能力分；一个最终决定；有事实依据的判断、有限修复及正确分支范围 |
| 3. 产品链路 | Task 5 | 缓存、重评、保存、页面、默认选择和消息机会判断一致 |
| 4. 效果验收 | Tasks 6–7 | 实际模型逐份判读、差异报告、精确 SHA 门禁/CI、Edge 产品验收，并回原四步任务 |

阶段内工作按任务拆开；任务 1 是供后续使用的纯规则基础，不能单独宣布岗位判定已修好。阶段提交不混入未完成的下一阶段功能。

## 接口约定

以下接口由对应任务实现，字段结构以设计文档为准，不临时另起同义字段。

```js
// src/core/job_match_evidence.js
buildJobMatchEvidence({ candidateProfile, jobFacts });
// => { entries: EvidenceEntry[] }
verifyJobMatchEvidence({ evidence, refs, sourceKind });
// => { valid: boolean, invalidIds: string[], mismatches: string[] }

// src/core/job_match_conditions.js
normalizeJobConditions({ jobUnderstanding, evidence });
// => JobCondition[]，固定来源、类别、作用范围、替代条件
assessJobConditions({ conditions, reportedResults, evidence, selectedTrackId });
// => ConditionResult[]，双向核对确定事实，不抹掉 reportedState
summarizeQualifications({ conditions, conditionResults, selectedTrackId });
// => { status: 'satisfied'|'conflict'|'unknown'|'not_required',
//      conflictIds: string[], unresolvedIds: string[] }
projectCapabilityRequirements({ conditions, conditionResults, selectedTrackId });
// => 原矩阵接受的 requirementMatches[]，不含资格

// src/core/job_match_decision.js，任务 3 收口
decideJobMatch({ analysis, job });
// => 完整 Analysis；保留现有字段，加 conditionSchemaVersion、conditions、
//    conditionResults、qualificationStatus、decisionReasons

// 兼容入口不改调用方式：
applyRuleGuard(analysis, job); // 转调 decideJobMatch
createJobAnalysisRunner(configs, keywordPlan, deps); // 仍返回 analyzeJob
```

`buildJobMatchEvidence` 与条件模块都是纯函数，不读数据库、不调用模型、不向终端输出。证据 ID 由本地按来源与稳定顺序生成，证据目录可以序列化；不将 Map 或函数保存进 analysis JSON。

## 验证资料与测试矩阵

保留原 31 个通用基准和新采集首 20 份独立标签，新增合成用例到 `tests/fixtures/job_match_effect_cases.json`。所有用例在生成模型输出前固定期望。通用基准如需调整，必须附该条原输出、独立理由和新规则依据，不能为提高通过率批量改标签。

| 编号 | 具体情况 | 必须验证的结果 |
|---|---|---|
| Q01 | 要求 2026-11-01 至 2027-10-31 毕业，2024 年毕业 | 冲突、不推荐、不默认选择 |
| Q02 | 毕业日恰好为两个边界日期 | 两个都满足 |
| Q03 | 毕业日早/晚于边界一天 | 两个都冲突 |
| Q04 | 只写 2026 年，范围起点为 11 月 | 未知，不能补成 11 月，不推荐为优先/可投 |
| Q05 | JD 是“此日期毕业优先”或“不要求此日期” | 不硬排除 |
| Q06 | JD 未限定学历阶段，旧本科已毕业，新学历在读、毕业日期未知 | 不用旧本科直接断言所有学历不符 |
| Q07 | 明确仅限在校，候选人已毕业且无在读学历 | 冲突 |
| Q08 | 学历要求硕士，只有本科 | 冲突 |
| Q09 | 学历要求本科，已有本科 | 满足，但不加能力分 |
| Q10 | 必须 C1 驾驶证，明确尚未取得 | 冲突，不能因为未命中文字规则而失效 |
| Q11 | 必须证照，简历没有写是否持有 | 未知，不以未写当未取得 |
| Q12 | JD 明确接受两种证照之一，已具备其中一个 | 满足；另外一项不符不得抵消 |
| Q13 | 同一要求的两个替代分支，均明确不符 | 冲突 |
| Q14 | 一个替代分支不符，另一个缺事实 | 未知 |
| Q15 | 条件只属于 T1，候选人选择 T2 | 不使用 T1 条件阻断 T2 |
| Q16 | 所选 T1 不符，真实 T2 仍可考虑 | 检查有效替代方向，不直接整岗拒绝 |
| Q17 | 全部方向共用的明确资格冲突 | 全岗不推荐，不浪费额外分支调用 |
| Q18 | JD 明确限制本科毕业窗口，本科日期不符，另有在读硕士日期未知 | 不能用无关硕士状态冲淡本科冲突；同一条教育记录联合比较 |
| E01 | 原文本科，模型证据写取得硕士 | 证据矛盾；不允许“满足”直接生效 |
| E02 | 引用不存在的 JD/候选人 ID | 拒绝引用，最多一次修复，保留其他有效结果 |
| E03 | 自然概括项目，但引用了支持该概括的原事实 | 接受，不要求机械逐字相同 |
| E04 | 8 个月经历被说成满足一年 | 不虚报事实；不足年限仍按既有宽松策略，不硬排除 |
| E05 | 输入已有答案，但模型遗漏资格行 | 本地补判或一次针对性修复，不要求用户重复填写 |
| E06 | 同一证据被重复引用、条件交换顺序 | 最终结果不变，不重复加分/拒绝 |
| E07 | 当前 JD 否定/放宽了看似硬的条件 | 按完整原文作用范围判断，不能凭关键词淘汰 |
| M01 | 主要工作匹配，普通工具未写 | 保留机会，不把未知当明确不能履职 |
| M02 | 只有学历相符，主工作缺口大 | 学历不撑高能力分，结果如实显示职责差距 |
| M03 | 相邻职责可迁移，但指定平台未证明 | 可迁移与直接满足分开，不能将课程/相邻项目夸成精通平台 |
| M04 | 普通偏好满足很多，但一个资格冲突 | 仍不推荐 |
| M05 | 普通偏好满足很多，但一个资格未知 | 不自动升到优先/可投 |
| M06 | 多个确定能力项中有普通未知项 | 沿用原能力覆盖规则，不能新增“一项未知就全卡住” |
| R01 | 一条岗位模型调用失败，其他岗位有效 | 失败可定位，其他岗位完成，结果不丢失 |
| R02 | 有界修复再次失败或用户暂停 | 不循环；保留有效行和原任务状态 |
| R03 | 保存并重开数据库、重放同一已验证结果 | 档位、资格、理由、默认选择一致，不产生重复记录 |
| R04 | 旧模型缓存、新管线版本 | 旧缓存不当新证据；完整 JD 可复用，不重建画像 |
| P01 | Dashboard 与 CLI 使用同一候选资料/JD | 得到同一最终判断 |
| P02 | Agent stdio v1 接收新内部任务输入 | 外层协议、命令、退出行为兼容，不启动嵌套 Agent |
| P03 | 岗位列表、默认清单、消息机会判断 | 不出现同岗位互相矛盾的推荐/资格 |

本矩阵是明确的必测集合，不声称穷尽所有行业。面向真实效果的职业背景至少覆盖技术、产品/运营、客户服务、需要执业/驾驶证照的岗位；证照背景为合成资料，不伪造真实用户证照。

## Task 0：收口旧任务并固定可回退基线

**Files:**
- Modify: `tests/workflow_dashboard_smoke.js` 的 VM 浏览器就绪测试夹具。
- Verify existing changes: `src/adapters/sites/boss.js`、`src/core/analysis_revision.js`、`src/core/job_eligibility.js`、`src/core/workflow_progress.js`、`src/dashboard/assets/runtime.js`、`src/dashboard/pages/today.js`、`src/dashboard/view_models/today.js` 和已有对应回归。
- Update: 原四步清单与检查点。

**Interfaces:** 保持现有 HTTP、事件和扫描入口，修正测试环境缺失，不修改生产行为以迎合夹具。

- [x] 重新确认当前完整门禁失败位置及冻结文件；定向执行 `workflow_dashboard_smoke.js`，保存原失败。
- [x] 在 VM 夹具提供实际脚本使用的最小 `window` 事件能力，监听和触发真实事件，不能用 catch 吞掉脚本错误。

```js
const listeners = new Map();
// 放入现有 vm.createContext 对象；保留 document/fetch 等原有夹具。
window: {
  addEventListener(name, callback) { listeners.set(name, callback); }
}
// 断言原按钮禁用、恢复和事件后刷新行为；实际浏览器回归仍保留。
```

- [x] 运行工作流 Dashboard、today、shell、资格、采集与进度对应测试；核对双平台真实页面状态，不能开始真实发送。
- [x] 冻结工作区指纹，执行完整浏览器必跑门禁；若仍失败，定位具体原因，不擅自放宽超时或跳过测试。
- [x] 通过后将四组已完成修改及夹具修复独立提交，记基线 SHA、门禁日志和同 SHA CI；当前 12 文件旧失败证据继续保留。提交 `ff61673856d6065a4219c12aa0d1a8f2d2884012` 已推送，[同 SHA CI](https://github.com/daydreamer0213/OfferGo/actions/runs/37970408956) 成功。

**完成标准：** 原未提交修改有明确通过基线，已有待办未丢失；不声称 BOSS 12 份详情和真实发送已完成。

## Task 1：建立统一条件与证据基础

**Files:**
- Create: `src/core/job_match_evidence.js`、`src/core/job_match_conditions.js`。
- Modify: `src/core/job_eligibility.js`，仅导出/复用已有确定比较，不复制解析实现。
- Create: `tests/job_match_evidence_smoke.js`、`tests/job_match_conditions_smoke.js`、`tests/fixtures/job_match_effect_cases.json`。
- Modify: `tests/test_manifest.js`，两个纯函数测试属于 fast，all 按执行顺序登记一次。

**Interfaces:** 产出计划“接口约定”的五个证据/条件函数；不切换正式最终决策。

- [x] 先为 Q01–Q18、E01–E07 建立含原文、资料、期望和理由的合成输入。用现有校验重放 Q01/Q10，保存当前冲突降为未知的失败证据；不能把原真实资料复制到 fixture。
- [x] 新模块的测试先失败，然后实现来源目录、条件分类、范围、替代逻辑和确定事实比较。

```js
const assert = require('node:assert/strict');
const { summarizeQualifications } = require('../src/core/job_match_conditions');
const conditions = [{ id: 'E1', category: 'qualification', strength: 'mandatory', trackIds: ['T1'] }];
const qualified = state => summarizeQualifications({
  conditions, selectedTrackId: 'T1',
  conditionResults: [{ conditionId: 'E1', category: 'qualification', state }]
}).status;
assert.equal(qualified('conflict'), 'conflict');
assert.equal(qualified('unknown'), 'unknown');
assert.equal(qualified('satisfied'), 'satisfied');
```

- [x] 证据测试检查正反向事实、未知粒度、自然概括引用及重复顺序；模块只从输入读事实，不能读取 SQL 或补造证照/日期。
- [x] `normalizeJobConditions` 对当前旧 eligibility 字符串提供明确兼容；不能靠标签包含“本科”就把一条开发职责判成资格。新条件在未知类型时保留原来源和未知原因，不默默丢失。
- [x] 运行两个新测试、原资格测试、架构和清单一致性检查；纯基础模块未接入时说明业务缺口还在。

**完成标准：** 所有条件比较正反例通过；能力、资格和偏好不会混成同一类；无循环依赖或新跨层例外。

## Task 2：贯通资格状态，消除冲突失效和未知升档

**Files:**
- Modify: `src/core/model_contract.js`、`src/core/split_semantic_matching.js`、`src/core/job_analysis.js`、`src/adapters/models/structured.js`、`src/adapters/models/mock.js`、`src/core/analysis_revision.js`。
- Test: `tests/semantic_pipeline_smoke.js`、`tests/four_tier_pipeline_smoke.js`、`tests/model_adapter_smoke.js`、`tests/agent_headless_cli_smoke.js`。

**Interfaces:** 使用 Task 1 的条件与证据函数；完整分析保存 `conditions/conditionResults/qualificationStatus`。对外 `applyRuleGuard` 调用方式不变。

- [x] 先加原生产路径的失败回归：`validateModelResult → compactAnalysis → applyRuleGuard → decisionBucket`。用 Q01、Q10、M04、M05，不只断言中间 `review/skip`。

```js
// 加入现有 four_tier_pipeline_smoke.js，analysis() 使用该文件已有帮助函数。
const input = analysis({
  conditionSchemaVersion: 1,
  conditions: [{ id: 'E1', category: 'qualification', strength: 'mandatory', trackIds: ['T1'] }],
  selectedTrackId: 'T1',
  conditionResults: [{ conditionId: 'E1', category: 'qualification', state: 'conflict' }]
});
assert.equal(applyRuleGuard(input, {}).recommendation, 'not_recommended');
input.conditionResults[0].state = 'unknown';
assert.equal(applyRuleGuard(input, {}).recommendation, 'caution');
```

完整 runner 用例还须通过真实来源引用构造状态；上面直接决策测试不替代来源校验。

- [x] 修改内部理解契约，使资格有类别、范围、比较/替代条件和原文引用；匹配输出引用本地已知条件与证据 ID。旧入口继续受控归一化，不增加供应商专用实现。
- [x] 校验后的资格状态完整通过分阶段匹配、缓存与 `compactAnalysis`。原模型 state 留在 `reportedState`，正式 `state` 使用归一化结果，两者不再混为一个数组。
- [x] 资格冲突优先阻断；资格未知最高慎投；既有本地边界仍优先。技术失败仍为空推荐和 `needs_retry`，普通能力未知不新增一刀切限制。
- [x] 更新理解/匹配管线和规则版本，避免旧缓存绕过新结果；记录新增 schema，但不改 SQLite schema。
- [x] 跑语义、四档、适配器、Agent 相关检查，阶段结束跑完整门禁并提交。

**完成标准：** Q01/Q10 真正到最终不推荐；M04/M05 不再被普通高分推高；已有合格对照仍可推荐，stdio 外层 v1 不变。

## Task 3：资格退出能力分，收口唯一最终决策

**Files:**
- Create: `src/core/job_match_decision.js`。
- Modify: `src/core/four_tier_decision.js`、`src/core/job_analysis.js`、`src/core/model_contract.js`、`src/core/job_match_conditions.js`、`src/core/analysis_revision.js`。
- Test: `tests/four_tier_decision_smoke.js`、`tests/four_tier_pipeline_smoke.js`、`tests/semantic_pipeline_smoke.js`。

**Interfaces:** `decideJobMatch({analysis,job})` 唯一生成正式推荐；原 `applyRuleGuard` 转发；矩阵仅消费 `projectCapabilityRequirements`。

- [x] 先加入 Q09/M02 的失败回归和固定能力评分不变量：加一个合格学历，不应改变能力分。

```js
const { projectCapabilityRequirements } = require('../src/core/job_match_conditions');
const { computeWeightedRequirementFit } = require('../src/core/four_tier_decision');
const conditions = [
  { id: 'R1', category: 'capability', trackIds: ['T1'], label: '交付业务接口', central: true },
  { id: 'E1', category: 'qualification', trackIds: ['T1'], label: '本科', strength: 'mandatory' }
];
const score = rows => computeWeightedRequirementFit(projectCapabilityRequirements({
  conditions, conditionResults: rows, selectedTrackId: 'T1'
})).combinedFit;
const capability = { conditionId: 'R1', category: 'capability', state: 'matched' };
assert.equal(score([capability]), score([capability,
  { conditionId: 'E1', category: 'qualification', state: 'satisfied' }]));
```

- [x] 将现有 `applyRuleGuard` 的本地边界、技术状态、硬性冲突、能力矩阵及降档逻辑按原顺序迁入 `decideJobMatch`。不新建可配置规则注册器，不改变矩阵、权重和普通未知的分母处理。
- [x] 核心组只接收能力项；资格与加分项不通过 indispensable 混进核心组。任职要求缺口仍区分明确不兼容、未知和可迁移。
- [x] 契约层遗留推荐字段只作兼容/诊断，不能覆盖正式输出；统一生成 `decisionReasons`，清楚指向具体条件，不以“本科学历”概括职业胜任度。
- [x] 原 31 例与新正反例全部对照；需要变化的旧预期逐条记录原因。阶段结束完整门禁、独立提交。

**完成标准：** 学历不撑高能力分；原能力评分政策保留；只有一个正式最终档位来源；不把“几乎不能履职”的案例虚写成充分匹配。

## Task 4：事实校验、有限修复与多方向范围

**Files:**
- Modify: `src/core/job_match_evidence.js`、`src/core/job_match_conditions.js`、`src/core/model_contract.js`、`src/core/split_semantic_matching.js`、`src/adapters/models/structured.js`、`src/core/job_analysis.js`。
- Test: `tests/job_match_evidence_smoke.js`、`tests/job_match_conditions_smoke.js`、`tests/model_adapter_smoke.js`、`tests/semantic_pipeline_smoke.js`、`tests/workflow_analysis_executor_smoke.js`。

**Interfaces:** 复用当前 `matchRequirements`、`callSplitEvidenceStage` 和 `contractRepair`，不创建新 stdio 协议、长期记忆或循环审查任务。

- [x] 先使 E01/E02/E05/Q15/Q16/R02 暴露失败：满足与冲突都必须有事实来源；已有事实漏答只能触发有限修复；分支资格不能全局化。
- [x] 将当前候选人事实目录加入匹配校验上下文。确定比较覆盖毕业粒度、学历、在校和证照；不支持确定比較的语义条件保留 grounded_model 依据和诊断，不因关键词陌生直接清空。
- [x] 实现一次条件修复：收集出错条件 ID，冻结其余有效结果；修复返回后核对无关行未改变。真实缺事实不触发反复模型调用，失败保留已有结果并解释原因。

```js
// 加入已有模型适配器 spy 测试。expected count 按既有三步路径计数，
// 不包含已经命中本地确定比较、无需修复的用例。
assert.equal(requests.filter(r => r.kind === 'matchRequirements'
  && r.input.contractRepair).length, 1);
assert.equal(secondRepairRequested, false);
assert.deepEqual(afterValidRows, beforeValidRows);
```

测试中的 `requests/beforeValidRows/afterValidRows/secondRepairRequested` 由 spy 实际调用和返回行取得，不能用固定值替代观测。

- [x] 方向选择先排除确定不合格方向；若当前分支明确失败，串行检查已有其他方向，每个最多一次。全局失败立即结束；一个未知分支不代表所有分支失败。
- [x] 核对普通单方向无固定新增调用；多方向和修复次数有界，暂停/停止信号穿透，单条失败不挂死队列。
- [x] 跑事实、条件、适配器、语义、执行器回归，阶段结束完整门禁并提交。

**完成标准：** 输入本科不会接受虚构硕士；合法自然总结仍通过；信息已有不重复问；未知与技术失败分开；方向与修复不循环。

## Task 5：保存、旧数据、页面与下游结果一致

**Files:**
- Modify: `src/storage/job_store.js`、`src/core/workflow_inventory.js`、`src/core/message_routing_policy.js`、`src/core/message_discovery.js` 的岗位判断投影、`src/core/analysis_revision.js`。
- Reuse: `src/application/analysis/index.js`、`src/application/analysis/reassess_batch.js` 的重试/重评，不新增直接 SQL。
- Test: `tests/job_store_contract_smoke.js`、`tests/analysis_application_smoke.js`、`tests/four_tier_product_surface_smoke.js`、`tests/workflow_inventory_smoke.js`、`tests/incoming_contacts_smoke.js`、`tests/message_discovery_smoke.js`、`tests/agent_headless_cli_smoke.js`。
- Update: `docs/architecture.md` 对应匹配职责说明及当前文档索引。

**Interfaces:** 通过现有 `analysis_json`、job store 和 application 用例持久化及重评。保持 `decisionBucket/listDecisionPool/workflowEligibility` 外部调用方式。

- [x] 先写生产用例→store保存→关闭重开→读取→岗位池/默认选择/消息路由的实际断言，覆盖 R03/R04/P01–P03。

```js
// 扩展现有四档 surface 测试，job() 为该文件已有构造函数。
const pendingQualification = job('caution', { analysis: {
  recommendationSchemaVersion: 2,
  qualificationStatus: 'unknown',
  conditionSchemaVersion: 1
}});
assert.equal(decisionBucket(pendingQualification), 'caution');
assert.equal(workflowEligibility(pendingQualification).eligible, false);
```

另在现有 SQLite 集成夹具中实际关闭重开验证相同值，不能只测内存对象。

- [x] 保存完整归一化结果；消费者只读该结果，不再各自解释 JD 或计算资格。理由显示具体中文，不把 ID、mandatory、primary、比较算子等暴露给用户。
- [x] 活动分析按新 revision 识别过期；有完整本地 JD 时复用现有单条/批次重评，不重新抓岗位、不重做画像/方案。
- [x] 验证旧数据库无需迁移即可打开；旧结果历史展示保留，旧分析不能默认进入新规则活动池。技术失败时已有正确资料不删除，原授权批次/发送记录不变。
- [x] 有 HR 历史回复的已匹配岗位继续复用有效分析，不因每条消息重新整岗匹配；仅新岗位或确实过期分析进入现有补全/重评路径。
- [x] 跑存储、应用、四档产品面、消息、Agent 和架构检查；阶段结束完整门禁并提交。

**完成标准：** 重启、保存和各入口一致；历史不丢；不会通过兼容别名误把慎投升档；无新增 Dashboard/application SQL。

## Task 6：实际模型效果与新旧差异定标

**Files:**
- Reuse: `tests/job_match_benchmark.js`、`scripts/lib/benchmark_metrics.js`；既有私有完整链路 runner 只有满足其当前路径、身份和授权门禁才可用，不为了本轮放宽那些历史门禁。
- Modify only if required by new telemetry: `tests/four_tier_benchmark_metrics_smoke.js`、现有指标脚本。
- Create report: `docs/superpowers/reports/2026-10-10-matching-decision-effects.md`，仅在实际执行后写入结果。
- Private artifacts: `D:\DevData\OfferGo-validation\2026-10-10\matching-decision-<SHA>-<runId>`。

**Interfaces:** 所有实际分析调用生产 `createJobAnalysisRunner`，结果比较使用现有指标函数。不得另造一个测试专用判定器。保留已有候选人资料/参考标签，冻结输入 hash、模型配置标识和源码 SHA，不输出 Key。

- [x] 先裁定首 20 份标签中政策差异：地区、活跃、年限宽松与纯资格/能力错判分开。保留原标签，新增裁定记录和依据，不覆盖原文件。
- [x] 运行原 31 例与新增跨职业合成情况，检查正反例。先完成 Q01/Q10/M02/E01 的实际模型集中样本，再进入新首 20 份完整运行；集中样本仍失败则修复对应环节后重测，不反复改标准。
- [x] 逐份阅读推荐、职责、相关经历、冲突/未知和中文解释，检查用户是否能据此作出有用选择；保留首次失败和修后结果。
- [x] 执行新旧对照，分别统计下面的明确指标；缺少真实期望的条目单列，不混进分母。

```js
assert.equal(metrics.confirmedQualificationFalseRecommendations, 0);
assert.equal(metrics.qualificationUnknownAutoSelections, 0);
assert.equal(metrics.inventedFactAcceptedCases, 0);
assert.equal(metrics.persistedDecisionMismatchCases, 0);
assert.equal(metrics.unexpectedKeepToExcludeCases, 0);
```

指标定义：对应参考类别的错误条目数，配套输出分母、岗位 ID 与理由。`unexpectedKeepToExcludeCases` 排除事先明确的资格冲突纠正，其他保留→排除必须逐条核对；发现意外误排不得默认切换。

- [x] 比较正常单方向模型调用数、有限修复和多方向额外调用数、等待时间；不能靠少读 JD、取消语义分析或改变预算换取速度。
- [x] 对“主要工作基本不符仍慎投”单独形成候选政策报告：现行政策与候选政策各保留/排除哪些岗位、哪些可迁移机会会失去。未获用户决定不修改矩阵或淘汰门槛；这不影响确定结构缺陷的整改。

**完成标准：** 明确约束类错误为零，已知合理机会未意外误排，真实输出有用而非仅 JSON 合法；集中 20 例不宣称代表全市场准确率。

## Task 7：精确版本验证、真实产品路径与回原任务

**Files:**
- Test: 原完整清单及新增登记的检查；不固定沿用 195 这个数字。
- Update: 原四步执行清单、当前检查点、`docs/NEXT_PHASE.md`、本计划的复选框、效果报告与对应当前架构说明。

**Interfaces:** 重用现有隔离 Dashboard 与 Agent CLI；Edge 走用户实际页面，模型走当前普通配置，不访问外部发送按钮。

- [x] 完成源码自审：对照审查每个问题对应的任务、失败证据和实际效果；再次判断修改是否必要、是否引入新的阻塞。
- [ ] 冻结提交 SHA 与文件指纹，从该提交在 D 盘创建隔离验证副本。测试的项目 `.runtime` 和新产物位于 D；使用现有 Node/Playwright，不新装运行时或把缓存写到 C。
- [ ] 运行完整浏览器必跑门禁，退出码 0；通过后核对相同 SHA CI。失败先定位，不能只重跑就宣称根因修复。
- [ ] 使用新提交的隔离环境，在 Edge 从今日任务到岗位列表、岗位详情、已有 JD 重评、慎投详情和默认清单走普通产品路径。逐项核对来源、日期、实际职责、相关经历、具体冲突/待确认、等待反馈；不出现内部字段，主题按钮不遮挡操作。
- [ ] 模拟输入更新、单条失败、暂停、关闭重启；核对保存结果与继续入口自然。Agent 路径另测同样的合成输入，不要求 Agent 用户打开页面。
- [ ] 回原第 3 步，补 BOSS 12 份详情并评估新样本；回原第 4 步补搜索刷新与休眠状态一致性，并核对已有局部修复真实效果。
- [ ] 整体筛选规则改动后，另建新的空操作库建立当前找岗质量基线，保留原简历、卡、方案、模型设置和账号访问预算/节奏。冻结 20 份 JD 的新旧实验不充当新规则的真实召回/精度验收；原库、旧待办和不确定发送记录继续保留，不以清库绕过。
- [ ] 原第 1 步的简历动作结果仍单独核验。不确定记录未解决前不宣称所有平台动作已通过；需要新一次执行时取得具体授权。
- [ ] 更新四步总状态，明确长期观察未覆盖范围；必要修复、验收和具体授权边界都已交代后，再准备用户最终验收。发布属于后续步骤，不在本计划中自动执行。

**完成标准：** 当前 SHA 的完整检查、CI、实际模型效果和 Edge 产品链路都有可复核证据，原任务没有被新整改替代。

## 验证入口

命令在当前实现目录或相同 SHA 的 D 盘验证副本运行。Node 使用 `D:\Guo\ZhiPing\.runtime\node\node.exe`；执行前确认仍存在，不下载替代运行时。Playwright 从现有依赖路径解析，缺失时报告具体依赖，不静默跳过浏览器检查。

```powershell
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/job_match_evidence_smoke.js
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/job_match_conditions_smoke.js
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/semantic_pipeline_smoke.js
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/four_tier_pipeline_smoke.js
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/analysis_application_smoke.js
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/architecture_boundaries_smoke.js
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/test_manifest_smoke.js
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/run_group.js fast
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/run_group.js integration
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/run_group.js package
& D:\Guo\ZhiPing\.runtime\node\node.exe tests/run_all.js --browser-required
git diff --check
```

各任务先运行相关检查；同一源码冻结后通过的检查不无理由反复运行。阶段/最终完整门禁日志保留实际 test manifest、SHA、版本、起止时间和退出码。

## 提交、回退与交接

- 阶段 0 旧修复独立提交；后续每阶段有自有变更、完整检查与效果范围说明。提交说明不将“基础模块已加”写成“整体效果通过”。
- 若新阶段出问题，回退该阶段代码/管线版本，保留新用户数据。不得重置账号预算、清空数据库、删除不确定动作或改写旧批次授权来恢复。
- 每次停止/继续前更新本计划已完成的复选框、最近通过 SHA、失败原因和下一项，不用聊天里的一句“继续”替代交接状态。
- 每个阶段报告只回答：修复什么、怎么证明、是否伤害正常推荐、下一项是什么。需要用户决定的只有有量化差异的政策选择或具体外部动作，不机械询问内部字段命名与实现方式。

## 余额恢复后的当前检查点（2026-10-10）

- `0d14b012e4591dc130013dd2116ad75936442484` 的精确提交197项浏览器必跑门禁和同SHA CI均通过，运行38012035213。这是本次补修前的证据，不代表下面的新改动通过最终门禁。
- 实际模型连接恢复HTTP200；正常Edge页面重新测试并保存连接后，原BOSS暂停任务继续完成6个分析，再通过原批次重试入口处理历史失败。新操作基线当前BOSS主投3、可投10、慎投23、不推荐22、分析失败1、待刷新1；智联主投1、可投3、慎投15、不推荐37、方向证据不足3。119份观察保留，没有重新抓取或发送。
- 华艺佳岗位的引用反复错误已确认：模型拼接过长风险引用，修复时又照抄。生产修复输入只移除无效风险引用，保留风险类型、严重度、有效引用和其他字段；仍只允许一次修复。真实生产分析器验证该岗位由失败变为完整分析，3次调用包含一次修复；不将只读验证结果冒充已写入产品库。
- 独立复查确认学制遗漏，新增同一教育记录的学历与学制联合比较，并核对OR替代条件。普通本科、全日制优先和明确学制不限保持；未知学制不能被模型的经历判断覆盖。决策修订升级v4.10，理解v21和匹配v55保持，旧缓存必须经新条件重新校验。语义形式的单一学历要求、分句学制限制、原简历已明确的学制和不可满足的替代分支均有失败→通过回归。
- 模型技术错误不再显示为用户需要确认的岗位要求；模型连接检查日期使用本地时间。原始错误仍保存在分析与诊断中，两平台页面回归及实际时间回归通过。
- 本次补修的独立复核、精确SHA完整门禁、CI和新版本Edge重评仍在推进。原不确定简历动作不重放，长期观察未被短期验证替代；本轮不发布。

## 计划自审记录

2026-10-10 对照整体审查与用户要求复核：

| 原问题/要求 | 覆盖任务 |
|---|---|
| 正确资格冲突被抹掉 | Tasks 1、2、4；Q01/Q10 与合格对照 |
| 资格状态丢失、未知被推高 | Tasks 2、3、5；M04/M05 与最终岗位池 |
| 学历等资格撑高能力分 | Task 3；Q09/M02 不变量 |
| 格式合法却无事实来源 | Tasks 1、4；E01–E07 双向检查 |
| 替代条件、多方向、学历阶段范围 | Tasks 1、4；Q12–Q18 |
| 不因保守设计卡住正常功能 | Tasks 2、4、6；合格对照、普通未知、可迁移、有限修复 |
| 真正有用而非流程通过 | Tasks 6、7；实际输出判读和 Edge 产品路径 |
| 不遗漏原计划 | Tasks 0、7；原四步检查点与回接待办 |

接口名与状态已核对；所有新增源模块只在 core 内协作，存储与 application 沿用既有入口。原 31 例、冻结 20 例、额外 38 类情况和新操作基线的用途分开，不拿旧规则采集量证明新规则召回。已检查修改范围、原任务衔接、文档链接及计划空缺；本记录不表示任何实施测试已经通过。

2026-10-10 最后复核：执行器预处理也按当前分析版本和语义状态判断，旧版本或pending/partial/stale/failed不再被旧hard_boundary来源再次跳过；当前明确blocked仍正常跳过。初始化→实际执行前处理的失败→通过回归及独立复查已完成，原事务、租约和重试上限保留。普通Edge点击继续已实际验证新提示“继续前需要重新测试模型连接”，进度保留且没有启动分析；剩余工作概览另列尚未解决失败，不把已解决的历史失败重复计入。最新副本再次对实际新基线隔离库验证20份有效分析JSON和20个成功任务整行不变，0网络请求，完整性/外键正常。最新整版本、最终根提交与同SHA CI尚待完成；账户余额、原不确定简历动作和长期观察仍未解决。

本次收口提交的状态截面：第二十个候选代码副本197项完整浏览器必跑门禁通过，实际Edge恢复链路与原邀请只读复核已记录；之后只调整两处错误提示文字。精确根提交的最终完整门禁及同SHA CI在提交后另行核对，不继承基线b7c1a9a的失败或更旧提交的成功。模型账户余额不足、原不确定发送和一周观察继续保留为未完成项。最新公开运行见[当前分支CI](https://github.com/daydreamer0213/OfferGo/actions?query=branch%3Acodex%2Foffergo-robustness-20260916)；本段是写入提交时的记录，不预先宣称后续运行通过。

后续暂停数量补验：普通重评成功和打开暂停任务页面都应核对当前可用推荐。现有同日BOSS核对纳入paused，历史日期和其他平台仍保持；只刷新计数，暂停原因、恢复阶段、代数等字段不变，也不启动分析。两条失败→通过回归及独立复查已完成。7598636的同SHA CI已通过；本项修改后的最终提交仍需重新冻结，运行197项浏览器必跑完整门禁、同SHA CI，并通过Edge核对概览与实际清单数量一致。模型额度、原不确定发送及一周观察仍未完成。
