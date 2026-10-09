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

test('moving a proven personal contribution to a line after employment dates remains activatable', () => {
  const originalText = '在5人团队参与订单后台开发，个人完成订单状态与发票导出接口。';
  const sourceText = `${base}工作经历\n后端开发工程师｜2024.07—2026.09\n${originalText}`;
  const validated = draft(sourceText, originalText, '个人完成订单状态与发票导出接口；在5人团队参与订单后台开发。');
  const generatedText = renderOptimizedResume(sourceText, validated.suggestions);
  const result = validateResumeActivationText({sourceText,generatedText,finalText:generatedText,suggestions:validated.suggestions});
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('a proven personal subtask can be stated directly without repeating teammate boundaries', () => {
  const originalText = '个人完成订单状态和发票导出接口，前端与云环境由其他同事负责。';
  const proposedText = '完成订单状态和发票导出接口。';
  const sourceText = `${base}${originalText}`;
  const validated = draft(sourceText, originalText, proposedText);
  const generatedText = renderOptimizedResume(sourceText, validated.suggestions);
  assert.equal(generatedText, `${base}${proposedText}`);
  const result = validateResumeActivationText({ sourceText, generatedText, finalText: generatedText,
    suggestions: validated.suggestions });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('personal page changes can accompany observed campaign conversion without an attribution disclaimer', () => {
  const originalText = '活动期本人调整商品详情页按钮位置与文案，期间转化率从2.1%提升至2.5%。';
  const proposedText = '调整商品详情页按钮位置与文案，活动期转化率从2.1%提升至2.5%。';
  const sourceText = `${base}${originalText}`;
  const validated = draft(sourceText, originalText, proposedText);
  const generatedText = renderOptimizedResume(sourceText, validated.suggestions);
  assert.equal(generatedText, `${base}${proposedText}`);
  const result = validateResumeActivationText({ sourceText, generatedText, finalText: generatedText,
    suggestions: validated.suggestions });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('a proven personal subtask cannot become independent ownership of the entire project', () => {
  const originalText = '参与订单后台项目，个人完成订单状态和发票导出接口，前端与云环境由其他同事负责。';
  const sourceText = `${base}${originalText}`;
  const proposedText = '独立负责订单后台项目，完成订单状态和发票导出接口、前端和云环境。';
  assert.throws(() => draft(sourceText, originalText, proposedText), /职责边界/);
  const generatedText = sourceText;
  const result = validateResumeActivationText({ sourceText, generatedText, finalText: `${base}${proposedText}`,
    suggestions: [] });
  assert.equal(result.valid, false);
  assert(result.errors.some(item => item.code === 'RESUME_FACT_UNSUPPORTED'));
});

test('already clear resumes can produce a complete unchanged draft with no suggestions', () => {
  const sourceText = `${base}课程项目：整理访谈反馈形成需求表，绘制Figma页面原型并完成课程展示。`;
  const validated = validateResumeOptimizationDraft({ headline: '现稿已清楚，无需修改', suggestions: [] },
    { sourceText, evidenceCatalog: buildResumeEvidenceCatalog({ sourceText }) });
  assert.deepEqual(validated.suggestions, []);
  assert.equal(renderOptimizedResume(sourceText, validated.suggestions), sourceText);
  assert.equal(integrity(sourceText).valid, true);
});

test('punctuation formatting does not turn an existing team size into a new personal achievement', () => {
  const originalText = '在5人团队参与订单后台开发，个人完成订单状态与发票导出接口。';
  const sourceText = `${base}${originalText}`;
  const validated = draft(sourceText, originalText, '在5人团队参与订单后台开发,个人完成订单状态与发票导出接口。');
  const generatedText = renderOptimizedResume(sourceText, validated.suggestions);
  const result = validateResumeActivationText({ sourceText, generatedText, finalText: generatedText, suggestions: validated.suggestions });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('model-escaped line separators become actual resume lines without changing technical escape examples', () => {
  const originalText = '个人负责商品上架、详情页信息整理与活动数据日报。';
  const sourceText = `${base}${originalText}`;
  const validated = draft(sourceText, originalText, '个人负责商品上架。\\n整理详情页信息，并维护活动数据日报。');
  const text = renderOptimizedResume(sourceText, validated.suggestions);
  assert(text.includes('个人负责商品上架。\n整理详情页信息'));
  assert.equal(text.includes('\\n'), false);
  const technical = '做文本解析时用字符串“\\n”表示换行。';
  const technicalDraft = draft(`${base}${technical}`, technical, '文本解析：用字符串“\\n”表示换行。');
  assert.equal(technicalDraft.suggestions[0].proposedText, '文本解析：用字符串“\\n”表示换行。');
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

test('removing a complete side note without its terminator does not leave duplicate sentence endings', () => {
  const source = '制作分步骤操作说明，并根据卡住的步骤修改说明。没有统计续费率或转化率变化，不负责定价与销售谈判。\n技能\nExcel透视表。';
  const suggestion = { id: 'S1', operation: 'remove', originalText: '没有统计续费率或转化率变化，不负责定价与销售谈判', proposedText: '', decision: 'accepted' };
  assert.equal(renderOptimizedResume(source, [suggestion]), '制作分步骤操作说明，并根据卡住的步骤修改说明。\n技能\nExcel透视表。');
  assert.equal(renderOptimizedResume('完成记录。未做统计。后续复查。', [{ ...suggestion, originalText: '未做统计' }]), '完成记录。后续复查。');
  assert.equal(renderOptimizedResume('完成记录。后续复查。', []), '完成记录。后续复查。');
  const following = { id: 'S2', operation: 'replace', originalText: '。后续复查。', proposedText: '进行后续复查。', decision: 'accepted' };
  const remove = { ...suggestion, originalText: '未做统计' };
  for (const operations of [[remove, following], [following, remove]]) {
    assert.equal(renderOptimizedResume('完成记录。未做统计。后续复查。', operations), '完成记录。进行后续复查。');
  }
});
