const assert = require('node:assert/strict');
const { applyRuleGuard } = require('../src/core/job_analysis');
const complete = () => ({ semanticStatus: 'complete', roleAlignment: 'insufficient_evidence',
  requirementMatches: [{ requirement: '生产集群治理', state: 'missing', central: true, foundation: true,
    jdEvidence: 'JD：掌握生产集群治理', resumeEvidence: '简历：不了解云平台部署。' }],
  responsibilityMatches: [
    { id: 'D1', state: 'missing', jdEvidence: 'JD：独立负责生产云平台产品', resumeEvidence: '简历：没有软件系统开发工作经历。' },
    { id: 'D2', state: 'missing', jdEvidence: 'JD：生产集群治理与容灾', resumeEvidence: '简历：不了解云平台部署。' },
    { id: 'D3', state: 'unknown', jdEvidence: 'JD：跨团队战略', resumeEvidence: '' }
  ], evidence: { jd: ['生产集群治理'], resume: ['不了解云平台部署'] } });
const decide = value => applyRuleGuard(value, { qualityTags: [] });
assert.equal(decide(complete()).recommendation, 'not_recommended', 'confirmed primary gaps should finish the decision even with other unknown facts');
for (const mutate of [
  x => { x.responsibilityMatches.forEach(row => { row.state = 'unknown'; row.resumeEvidence = ''; }); },
  x => { x.responsibilityMatches[1].state = 'unknown'; },
  x => { x.responsibilityMatches[0].state = 'transferable'; },
  x => { x.requirementMatches[0].central = false; },
  x => { x.requirementMatches[0].foundation = false; },
  x => { x.requirementMatches[0].state = 'unknown'; },
  x => { x.requirementMatches[0].resumeEvidence = ''; },
  x => { x.requirementMatches[0].resumeEvidence = '简历：未提及该工具'; },
  x => { x.requirementMatches.push({ requirement: '产品需求梳理', central: true, state: 'matched', jdEvidence: 'JD：需求梳理', resumeEvidence: '简历：完成状态图与需求说明' }); },
  x => { x.requirementMatches.push({ requirement: '接口开发', foundation: true, state: 'transferable', jdEvidence: 'JD：接口开发', resumeEvidence: '简历：使用另一技术栈完成接口' }); },
  x => { x.semanticStatus = 'failed'; },
  x => { x.semanticStatus = 'stale'; },
  x => { x.semanticStatus = 'partial'; }
]) {
  const value = complete(); mutate(value);
  assert.notEqual(decide(value).recommendation, 'not_recommended', JSON.stringify(value));
}
console.log('confirmed_primary_gap_regressions ok (positive and 13 controls)');
