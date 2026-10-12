"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openDb, saveProfileAnalysis, getCandidateProfile, listProfileVersions, createMatchingCardDraft, confirmMatchingCard, getActiveMatchingCard, getCandidateMatchingContext, listMatchingCards, getSearchPlan, getSearchPlanDependency, updateCandidateProfile } = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { formatFieldLines, parseFieldLines } = require("../src/dashboard/profile_field_lines");
const { normalizeCandidateProfile, normalizeSearchPlan } = require("../src/core/profile_schema");
const { createDashboardServer } = require("../src/dashboard/server");

function decodeHtml(value) {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity]);
}

function readForm(html, action) {
  const form = [...html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].find((match) => decodeHtml(match[1]) === action);
  assert(form, `ordinary page must expose ${action}`);
  const fields = new URLSearchParams();
  for (const match of form[2].matchAll(/<input\b[^>]*>/g)) {
    const name = match[0].match(/name="([^"]+)"/)?.[1];
    if (!name || /type="(?:checkbox|radio)"/.test(match[0]) && !/\schecked(?:\s|>|=)/.test(match[0])) continue;
    fields.append(name, decodeHtml(match[0].match(/value="([^"]*)"/)?.[1] ?? (/type="checkbox"/.test(match[0]) ? "on" : "")));
  }
  for (const match of form[2].matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields.set(match[1], decodeHtml(match[2]));
  for (const match of form[2].matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>/g)];
    const selected = options.find((option) => /\sselected(?:\s|>|=)/.test(option[0])) || options[0];
    if (selected) fields.set(match[1], decodeHtml(selected[1]));
  }
  return fields;
}

async function main() {
  const literalRows = [["A | B", '他说"完成"', ""], ["多行\n第二行", " 两端空白 ", "末列"]];
  assert.deepEqual(parseFieldLines(formatFieldLines(literalRows), { maxFields: 3, label: "项目" }), literalRows);
  assert.deepEqual(parseFieldLines("旧格式 | 事实 |\n", { maxFields: 3, label: "项目" }), [["旧格式", "事实", ""]]);
  assert.throws(() => parseFieldLines('"未闭合 | 内容', { maxFields: 3, label: "项目" }), /项目/);
  const root = path.resolve(__dirname, "..");
  const tempParent = process.platform === "win32" ? "D:/DevData/OfferGo-validation/smoke" : path.join(root, ".runtime", "smoke");
  fs.mkdirSync(tempParent, { recursive: true });
  const dataRoot = fs.mkdtempSync(path.join(tempParent, "profile-edit-"));
  const dbPath = path.join(dataRoot, "jobs.sqlite");
  const db = openDb(dbPath);
  let server;
  try {
    const profile = normalizeCandidateProfile({
      candidate: { name: "候选人", city: "广州", targetTitles: ["软件开发"], expectedSalary: "9-14K" },
      education: [{ school: "学校", degree: "本科", major: "电子信息", highlights: ["课程含程序设计、数据库"] }],
      experiences: [{ organization: "协作团队", role: "开发", highlights: ["完成设计、开发和回归"] }],
      skills: [{ name: "JavaScript", level: "resume", evidence: ["完成接口、页面及测试"] }],
      projects: [
        { name: "项目A | 开发作品", period: "2026.07-至今", context: '实际"交付"\n并维护', roleBoundary: "独立完成", canSay: ["完成页面、接口及测试"], technologies: ["JavaScript", "SQLite"], results: ["已经发布、持续维护"], avoidSaying: ["不声称带领团队"] },
        { name: "项目B", period: "2025", results: ["完成课程设计"] }
      ],
      credentials: [{ name: "证书 | 语言", details: '已通过"考试"' }],
      strengths: ["完成设计、实现和验证"]
    });
    profile.projects[0].privateMetadata = { attribution: "actual" };
    const saved = saveProfileAnalysis(db, { profile, document: { originalFileName: "测试候选人.txt", format: "text", contentHash: "synthetic-profile-hash", text: "姓名：测试候选人\n" + "实际简历项目材料\n".repeat(180) }, searchPlan: normalizeSearchPlan({ name: "人工方案", cities: ["广州"], keywords: ["软件"], excludeWords: ["外包"] }, profile) });
    const initialCard = createMatchingCardDraft(db, { profileId: saved.profileId, profileVersionId: saved.profileVersionId, resumeDocumentId: saved.resumeDocumentId, resumeContentHash: "synthetic-profile-hash", card: { ...matchingCardFromProfile(profile), userNotes: ["优先软件交付工作"] } });
    confirmMatchingCard(db, { profileId: saved.profileId, cardId: initialCard.id });
    const oldContext = getCandidateMatchingContext(db, saved.profileId, { includeResumeEvidence: true });
    const oldPlan = getSearchPlan(db, saved.planId);
    server = createDashboardServer({ db, root, dataRoot, dbPath, forceMock: true, allowOfflineMock: true, browserAuthority: { browserMode: "edge" }, browserReadinessProbe: async () => ({ ready: false }), browserFactory() { throw new Error("profile editing must not access recruitment pages"); }, logger: { requestId: () => "profile-edit-smoke", info() {}, warn() {}, error() {} } });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${base}/profile?profileId=${saved.profileId}`);
    assert.equal(page.status, 200);
    const fields = readForm(await page.text(), "/api/profile");
    const response = await fetch(`${base}/api/profile`, { method: "POST", body: fields, redirect: "manual" });
    assert.equal(response.status, 303, await response.text());
    const reopened = openDb(dbPath);
    try {
      const actual = getCandidateProfile(reopened, saved.profileId).profile;
      assert.equal(actual.projects[0].name, profile.projects[0].name, "unchanged native form save must preserve the literal project name");
      assert.deepEqual(actual, profile, "unchanged native form save must preserve fields, sentence arrays and unexposed metadata");
    } finally { reopened.close(); }
    const changedFields = readForm(await fetch(`${base}/profile?profileId=${saved.profileId}`).then((r) => r.text()), "/api/profile");
    const projectRows = parseFieldLines(changedFields.get("projects"), { maxFields: 8, label: "项目" });
    projectRows[0][6] = "发布第二版";
    changedFields.set("projects", formatFieldLines(projectRows));
    const changed = await fetch(`${base}/api/profile`, { method: "POST", body: changedFields, redirect: "manual" });
    assert.equal(changed.status, 303, await changed.text());
    assert.match(changed.headers.get("location"), /^\/match-card\?/, "changed facts must open the actual review and confirmation page");
    const newCardId = Number(new URL(changed.headers.get("location"), base).searchParams.get("cardId"));
    const latest = listProfileVersions(db, saved.profileId)[0];
    assert.equal(latest.resumeDocumentId, saved.resumeDocumentId, "manual version retains the verified original resume document");
    assert.equal(listProfileVersions(db, saved.profileId).length, 2, "unchanged saves create no versions and one real edit creates one");
    const expected = structuredClone(profile);
    expected.projects[0].results = ["发布第二版"];
    assert.deepEqual(getCandidateProfile(db, saved.profileId).profile, expected);
    assert.deepEqual(getCandidateMatchingContext(db, saved.profileId, { includeResumeEvidence: true }), oldContext, "draft must not silently replace confirmed inputs");
    assert.deepEqual(getSearchPlan(db, saved.planId), oldPlan);
    const review = await fetch(new URL(changed.headers.get("location"), base)).then((r) => r.text());
    assert.match(review, /发布第二版/, "review page must show the newly saved facts");
    const reviewFields = readForm(review, "/api/match-card");
    const rejectedCardFields = new URLSearchParams(reviewFields);
    rejectedCardFields.set("strongEvidence", '"未闭合 | 最新事实');
    rejectedCardFields.set("userNotes", "此次新输入应保留");
    const cardBeforeRejection = listMatchingCards(db, saved.profileId);
    const rejectedCard = await fetch(`${base}/api/match-card`, { method: "POST", body: rejectedCardFields, redirect: "manual" });
    const rejectedCardHtml = await rejectedCard.text();
    assert.equal(rejectedCard.status, 400, rejectedCardHtml);
    const restoredCardFields = readForm(rejectedCardHtml, "/api/match-card");
    for (const key of ["strongEvidence", "userNotes", "profileId", "cardId"]) assert.equal(restoredCardFields.get(key), rejectedCardFields.get(key));
    assert.deepEqual(listMatchingCards(db, saved.profileId), cardBeforeRejection);
    const resaved = await fetch(`${base}/api/match-card`, { method: "POST", body: reviewFields, redirect: "manual" });
    assert.equal(resaved.status, 303, await resaved.text());
    const draft = listMatchingCards(db, saved.profileId).find((card) => card.id === newCardId);
    assert.deepEqual(draft.card.userNotes, initialCard.card.userNotes);
    assert.equal(draft.card.strongEvidence[0].label, profile.projects[0].name, "native matching-card form also preserves literal delimiters");
    const repeat = await fetch(`${base}/api/profile`, { method: "POST", body: changedFields, redirect: "manual" });
    assert.equal(repeat.status, 303);
    assert.equal(listProfileVersions(db, saved.profileId).length, 2);
    assert.equal(listMatchingCards(db, saved.profileId).length, 2);
    const receipt = await fetch(`${base}/api/match-card/confirm`, { method: "POST", body: readForm(review, "/api/match-card/confirm"), redirect: "manual" });
    assert.equal(receipt.status, 303, await receipt.text());
    const newContext = getCandidateMatchingContext(db, saved.profileId, { includeResumeEvidence: true });
    assert.equal(newContext.profileVersionId, latest.id);
    assert.equal(newContext.matchingCardId, newCardId);
    assert.deepEqual(newContext.candidateProfile.projects, expected.projects);
    assert.equal(newContext.candidateProfile.source.resumeEvidenceText, oldContext.candidateProfile.source.resumeEvidenceText);
    assert(newContext.candidateProfile.source.resumeEvidenceText.length > 1000, "the actual source resume remains complete");
    assert.equal(getSearchPlanDependency(db, saved.planId).stale, true);
    assert.deepEqual(getSearchPlan(db, saved.planId), oldPlan);
    const planFields = readForm(await fetch(`${base}/plan?profileId=${saved.profileId}&planId=${saved.planId}`).then((r) => r.text()), "/api/plan");
    const savedPlan = await fetch(`${base}/api/plan`, { method: "POST", body: planFields, redirect: "manual" });
    assert.equal(savedPlan.status, 303, await savedPlan.text());
    assert.equal(getSearchPlan(db, saved.planId).profileVersionId, latest.id);
    assert.deepEqual(getSearchPlan(db, saved.planId).plan, { ...oldPlan.plan, source: "user-confirmed" }, "ordinary plan save rebinds the new version and retains all manual conditions");
    assert.equal(getSearchPlanDependency(db, saved.planId).stale, false);
    assert.throws(() => confirmMatchingCard(db, { profileId: saved.profileId, cardId: initialCard.id }), /历史卡/);
    assert.equal(getActiveMatchingCard(db, saved.profileId).id, newCardId);
    const snapshot = () => ["candidate_profiles", "profile_versions", "candidate_matching_cards"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const beforeInvalid = snapshot();
    for (const invalid of ['"未闭合 | 内容', "1|2|3|4|5|6|7|8|9"]) {
      const badFields = new URLSearchParams(changedFields); badFields.set("projects", invalid);
      const rejected = await fetch(`${base}/api/profile`, { method: "POST", body: badFields, redirect: "manual" });
      const rejectedHtml = await rejected.text();
      assert.equal(rejected.status, 400, rejectedHtml);
      assert.equal(readForm(rejectedHtml, "/api/profile").get("projects"), invalid, "validation failure retains the submitted fields for correction");
      assert.deepEqual(snapshot(), beforeInvalid, "invalid fields must not change any saved profile, version or card");
    }
    db.exec("CREATE TRIGGER fail_manual_draft BEFORE INSERT ON candidate_matching_cards BEGIN SELECT RAISE(ABORT, 'forced draft failure'); END");
    const failedProfile = structuredClone(expected); failedProfile.projects[0].results = ["事务故障检查"];
    assert.throws(() => updateCandidateProfile(db, { profileId: saved.profileId, profile: failedProfile }), /forced draft failure/);
    assert.deepEqual(snapshot(), beforeInvalid, "draft failure rolls the profile and version back atomically");
    db.exec("DROP TRIGGER fail_manual_draft");
    const repeatedCompany = structuredClone(profile);
    repeatedCompany.experiences = [
      { organization: "同一公司", role: "实习开发", highlights: ["实现页面、接口"], metadata: { source: "internship" } },
      { organization: "同一公司", role: "全职开发", highlights: ["负责设计、回归"], metadata: { source: "fulltime" } }
    ];
    const repeated = saveProfileAnalysis(db, { profile: repeatedCompany, document: { contentHash: "repeated-company", text: "同公司两段实际经历" } });
    const repeatedFields = readForm(await fetch(`${base}/profile?profileId=${repeated.profileId}`).then((r) => r.text()), "/api/profile");
    const experienceRows = parseFieldLines(repeatedFields.get("experiences"), { maxFields: 8, label: "工作经历" });
    repeatedFields.set("experiences", formatFieldLines(experienceRows.slice(1)));
    const deleted = await fetch(`${base}/api/profile`, { method: "POST", body: repeatedFields, redirect: "manual" });
    assert.equal(deleted.status, 303, await deleted.text());
    assert.deepEqual(getCandidateProfile(db, repeated.profileId).profile.experiences, repeatedCompany.experiences.slice(1), "deleting one role at a shared company must preserve the other role's sentence arrays and source metadata");
    const renamedFields = readForm(await fetch(`${base}/profile?profileId=${repeated.profileId}`).then((r) => r.text()), "/api/profile");
    const renamedRows = parseFieldLines(renamedFields.get("projects"), { maxFields: 8, label: "项目" });
    [renamedRows[0][0], renamedRows[1][0]] = [renamedRows[1][0], renamedRows[0][0]];
    renamedFields.set("projects", formatFieldLines(renamedRows));
    const renamed = await fetch(`${base}/api/profile`, { method: "POST", body: renamedFields, redirect: "manual" });
    assert.equal(renamed.status, 303, await renamed.text());
    const renamedExpected = structuredClone(repeatedCompany.projects);
    [renamedExpected[0].name, renamedExpected[1].name] = [renamedExpected[1].name, renamedExpected[0].name];
    assert.deepEqual(getCandidateProfile(db, repeated.profileId).profile.projects, renamedExpected, "name edits retain the matching content's original arrays and metadata");
    const other = saveProfileAnalysis(db, { profile: { candidate: { name: "另一个候选人" } }, document: { originalFileName: "other.txt", contentHash: "unrelated-hash", text: "另一人的简历" } });
    assert.throws(() => confirmMatchingCard(db, { profileId: other.profileId, cardId: newCardId }), /not found/);
    updateCandidateProfile(db, { profileId: other.profileId, profile: { candidate: { name: "另一个候选人", city: "北京" } } });
    assert.equal(listProfileVersions(db, other.profileId)[0].resumeDocumentId, other.resumeDocumentId);
    assert.equal(listMatchingCards(db, other.profileId)[0].resumeDocumentId, other.resumeDocumentId);
    console.log("profile edit matching smoke passed");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
