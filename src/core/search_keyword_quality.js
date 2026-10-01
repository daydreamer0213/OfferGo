// Model-generated search terms must describe jobs. Skills and project actions belong in matching.
const ROLE_ENDING = /(?:工程师|架构师|分析师|设计师|研究员|科学家|咨询师|会计师|审计师|教师|医生|护士|律师|经理|主管|总监|专员|助理|顾问|运营|测试|运维|后端|前端|算法|会计|财务|法务|行政|人事|招聘|采购|销售|客服|编辑|策划|翻译|厨师)$/i;
const SHORT_ROLE_TITLE = /^(?:(?:数据|商业|市场|业务|财务|用户|供应链|风险|增长)分析|(?:平面|视觉|交互|室内|服装|工业|UI|UX|产品|游戏)设计)$/i;

function selectGeneratedRoleKeywords(profile = {}, proposal = {}) {
  // These targets can come from resume analysis, so validate them like model suggestions.
  const targets = list(profile.candidate?.targetTitles).filter(isRoleTitle);
  const suggestions = list(proposal.keywords).map((item) => typeof item === "string" ? { word: item } : item)
    .filter((item) => isRoleTitle(item?.word));
  const directions = list(proposal.directions).filter(isRoleTitle)
    .map((word) => ({ word, priority: "B", reason: "岗位方向" }));
  const experiences = targets.length || suggestions.length || directions.length ? [] : list(profile.experiences)
    .map((item) => item?.role).filter(isRoleTitle).map((word) => ({ word, priority: "B", reason: "简历中的岗位经历" }));
  const result = [];
  for (const item of [
    ...targets.map((word) => ({ word, priority: "A", reason: "简历目标岗位" })),
    ...suggestions,
    ...directions,
    ...experiences
  ]) {
    const word = String(item.word).trim();
    const key = word.replace(/\s+/g, "").toLowerCase();
    if (result.some((existing) => {
      const existingKey = existing.word.replace(/\s+/g, "").toLowerCase();
      return existingKey === key || (existingKey.includes(key) && existingKey.length - key.length <= 3);
    })) continue;
    result.push({ word, priority: ["A", "B", "C"].includes(item.priority) ? item.priority : "B", reason: item.reason || "岗位方向" });
  }
  return result.slice(0, 18);
}

function isRoleTitle(value) {
  const word = String(value || "").trim();
  if (word.length < 2 || word.length > 40) return false;
  const title = word.replace(/[（(][^（）()]{1,20}[）)]$/, "").trim();
  return ROLE_ENDING.test(title) || SHORT_ROLE_TITLE.test(title);
}

function list(value) { return Array.isArray(value) ? value : []; }

module.exports = { selectGeneratedRoleKeywords };
