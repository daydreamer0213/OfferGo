const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildResumeEvidenceCatalog, validateResumeOptimizationDraft,
  validateResumeActivationText, renderOptimizedResume
} = require('../src/core/resume_optimization');

const base = '候选人甲\n手机号13800138000\n邮箱candidate@example.com\n教育经历：信息管理本科\n';
function draft(sourceText, originalText, proposedText, extra = {}) {
  const evidenceCatalog = buildResumeEvidenceCatalog({ sourceText, ...extra });
  return validateResumeOptimizationDraft({ suggestions: [{
    id: 'S1', operation: 'replace', originalText, proposedText,
    reason: '整理真实经历', editingPrinciple: 'contribution_clarity',
    evidenceIds: evidenceCatalog.map(item => item.id)
  }] }, { sourceText, evidenceCatalog });
}
function integrity(sourceText, finalText = sourceText) {
  return validateResumeActivationText({ sourceText, generatedText: sourceText, finalText, suggestions: [] });
}

test('already clear resumes can produce a complete unchanged draft with no suggestions', () => {
  const sourceText = `${base}课程项目：整理访谈反馈形成需求表，绘制Figma页面原型并完成课程展示。`;
  const validated = validateResumeOptimizationDraft({ headline: '现稿已清楚，无需修改', suggestions: [] },
    { sourceText, evidenceCatalog: buildResumeEvidenceCatalog({ sourceText }) });
  assert.deepEqual(validated.suggestions, []);
  assert.equal(renderOptimizedResume(sourceText, validated.suggestions), sourceText);
  assert.equal(integrity(sourceText).valid, true);
});

test('pending supplement and confirmation are legitimate workflow states rather than template blanks', () => {
  for (const detail of [
    '与开发核对“处理中”和“待补充”的边界，根据反馈修改Figma页面原型。',
    '梳理待确认工单的处理流程，核对状态变化并整理验收记录。',
    '完成工单状态核对与页面原型调整，整理验收记录。\n工单状态：待确认'
  ]) {
    const result = integrity(`${base}课程项目：${detail}`);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }
});

test('actual standalone and field template blanks still prevent activation', () => {
  for (const placeholder of ['待补充', '项目成果：待补充', '待填写手机号', '邮箱：待确认', '[待补充]']) {
    const result = integrity(`${base}课程项目：完成需求表及页面原型，提交课程展示。\n${placeholder}`);
    assert(result.errors.some(item => item.code === 'RESUME_PLACEHOLDER_PRESENT'), placeholder);
  }
});

test('education cannot be relabeled as relevant work experience', () => {
  assert.throws(() => draft(`${base}课程项目：完成需求表。`, '教育经历：信息管理本科',
    '相关经历：信息管理本科'), /教育/);
});

test('education headings can be normalized without destroying their category', () => {
  const validated = draft(`${base}课程项目：完成需求表。`, '教育经历：信息管理本科',
    '教育背景：信息管理专业，本科');
  assert.equal(validated.suggestions[0].proposedText, '教育背景：信息管理专业，本科');
});

test('a JD-only named skill cannot become a candidate proficiency', () => {
  const sourceText = `${base}参与需求调研，使用Figma完成页面原型。`;
  assert.throws(() => draft(sourceText, '参与需求调研，使用Figma完成页面原型。',
    '参与需求调研，使用Figma完成页面原型；熟练SQL。',
    { jobs: [{ title: '产品经理', description: '熟练SQL，负责需求调研' }] }), /技能|证据/);
});

test('participating in an entire project cannot become responsible for that project from a JD', () => {
  const sourceText = `${base}参与订单接口开发。`;
  assert.throws(() => draft(sourceText, '参与订单接口开发。', '负责订单接口开发。',
    { jobs: [{ title: '后端工程师', description: '负责订单接口开发' }] }), /职责边界/);
});

test('role boundary checks handle technical names containing punctuation', () => {
  const sourceText = `${base}参与C++接口开发。`;
  assert.throws(() => draft(sourceText, '参与C++接口开发。', '负责C++接口开发。'), /职责边界/);
});

test('a skill name embedded in another technology does not support a new skill', () => {
  const sourceText = `${base}课程项目使用MongoDB存储记录。\n技能：MongoDB`;
  assert.throws(() => draft(sourceText, '技能：MongoDB', '技能：MongoDB、Go',
    { jobs: [{ title: '后端工程师', description: '熟悉Go' }] }), /技能|证据/);
});

test('confirmed ownership of a subtask remains allowed while participating in a broader project', () => {
  for (const originalText of [
    '参与订单接口开发，负责参数校验与异常响应。',
    '参与订单接口开发，本人完成参数校验与异常响应。'
  ]) {
    const sourceText = `${base}${originalText}`;
    const validated = draft(sourceText, originalText, '参与订单接口开发；负责参数校验和异常响应处理。');
    assert.equal(validated.suggestions.length, 1);
  }
});

test('proven named skills can be reorganized without attaching them to another project', () => {
  const sourceText = `${base}个人项目：使用Java和MySQL完成图书借还记录。\n技能：Java、MySQL`;
  const validated = draft(sourceText, '技能：Java、MySQL', '技能：Java；数据库：MySQL');
  assert.equal(validated.suggestions[0].proposedText, '技能：Java；数据库：MySQL');
});

test('removing a trailing clause leaves a complete sentence rather than a dangling separator', () => {
  const source = '用FastAPI与SQLite制作基础记账接口并写单元测试，仅在本机运行，没有生产部署。\n技能\nPython/FastAPI基础。';
  const suggestion = { id: 'S1', operation: 'remove', originalText: '仅在本机运行，没有生产部署。', proposedText: '', decision: 'accepted' };
  assert.equal(renderOptimizedResume(source, [suggestion]), '用FastAPI与SQLite制作基础记账接口并写单元测试。\n技能\nPython/FastAPI基础。');
  const prefix = '用FastAPI与SQLite制作基础记账接口并写单元测试，';
  const rewrite = { id: 'S2', operation: 'replace', originalText: prefix, proposedText: '使用FastAPI与SQLite编写记账接口及单元测试，', decision: 'accepted' };
  assert.equal(renderOptimizedResume(source, [rewrite, suggestion]), '使用FastAPI与SQLite编写记账接口及单元测试。\n技能\nPython/FastAPI基础。');
  const middle = '完成接口校验，未做页面开发，参与接口联调。';
  assert.equal(renderOptimizedResume(middle, [{ ...suggestion, originalText: '未做页面开发，' }]), '完成接口校验，参与接口联调。');
});
