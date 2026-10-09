// Fresh configured model output, checked by production validators. Human
// semantic review is required; this deliberate live run is not an offline test.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const opts = Object.fromEntries(process.argv.slice(2).map(arg => {
  const split = arg.indexOf('=');
  return [arg.slice(2, split < 0 ? undefined : split), split < 0 ? true : arg.slice(split + 1)];
}));
if (!opts.live || !opts['settings-root'] || !opts.output) throw Error('Require --live --settings-root=... --output=fresh-D-file');
const output = path.resolve(opts.output);
if (!/^D:[\\/]/i.test(output) || fs.existsSync(output)) throw Error('Use a fresh D: output');
fs.mkdirSync(path.dirname(output), { recursive: true });
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const fixturePath = path.join(__dirname, 'fixtures/effect_acceptance/natural_expression.json');
const fixtureBytes = fs.readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes);
const selectedIds = opts.case ? opts.case.split(',') : fixture.cases.map(item => item.id);
if (!selectedIds.length || selectedIds.some(id => !fixture.cases.some(item => item.id === id))) throw Error('Unknown or empty case selection');
const supportedMethods = new Set(['draftMessageGroup', 'generateResumeOptimization', 'generateMockInterviewStep', 'reviewMockInterview', 'reviewMockInterviewRetry']);
if (fixture.cases.some(item => !supportedMethods.has(item.method))) throw Error('Unsupported fixture method');
const settings = require('../src/core/model_settings');
const settingsFile = path.join(path.resolve(opts['settings-root']), '.runtime/settings/model.json');
const loaded = settings.resolveRuntimeModelConfig({ root: path.resolve(opts['settings-root']), readOnly: true });
if (!settings.isModelReady(loaded) || loaded.modelConfig.provider === 'mock') throw Error('A ready real model is required');
const adapter = require('../src/adapters/models').createModelAdapter(loaded.modelConfig);
const resume = require('../src/core/resume_optimization');
const interview = require('../src/core/mock_interview');
const analyze = require('../src/core/message_reply_analyzer').createMessageReplyAnalyzer({ adapter });
const workspace = path.resolve(__dirname, '..');
const result = { startedAt: new Date().toISOString(), fixtureHash: digest(fixtureBytes),
  evidenceType: 'fresh real generation and production validators; synthetic inputs; manual content verdict required; no platform writes',
  source: { sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
    diffHash: digest(execFileSync('git', ['-c', 'core.safecrlf=false', 'diff', '--binary'], { cwd: workspace })),
    adapterHash: digest(fs.readFileSync(path.join(workspace, 'src/adapters/models/structured.js'))) },
  model: { provider: adapter.provider, model: adapter.model }, settingsHashBefore: digest(fs.readFileSync(settingsFile)), cases: [] };
const save = () => fs.writeFileSync(output, JSON.stringify(result, null, 2));
const safeError = error => ({ code: error.code || error.name,
  message: String(error.message || '').replace(/[A-Za-z0-9_-]{32,}/g, '[token]') });
async function main() {
  for (const item of fixture.cases) {
    if (!selectedIds.includes(item.id)) continue;
    const input = structuredClone(item.input);
    const row = { id: item.id, method: item.method, inputHash: digest(JSON.stringify(input)), expected: item.expected, status: 'running' };
    result.cases.push(row); save(); console.log(`START ${item.id}`);
    const started = Date.now();
    try {
      if (item.method === 'draftMessageGroup') row.output = await analyze(input);
      else {
        row.raw = await adapter[item.method](input);
        if (item.method === 'generateResumeOptimization') {
          row.output = resume.validateResumeOptimizationDraft(row.raw, { sourceText: input.sourceResume.text, evidenceCatalog: input.evidenceCatalog });
          row.finalText = resume.renderOptimizedResume(input.sourceResume.text, row.output.suggestions);
          row.activation = resume.validateResumeActivationText({ sourceText: input.sourceResume.text,
            generatedText: row.finalText, finalText: row.finalText, suggestions: row.output.suggestions });
          if (!row.activation.valid) throw Error(JSON.stringify(row.activation.errors));
        } else if (item.method === 'generateMockInterviewStep') row.output = interview.validateInterviewStep(row.raw, { ...input.context, turns: input.turns });
        else if (item.method === 'reviewMockInterviewRetry') row.output = interview.validateRetryReview(row.raw, { turnNumber: input.turn.turnNumber });
        else row.output = interview.validateInterviewReport(row.raw, { turns: input.turns });
      }
      row.status = 'completed';
    } catch (error) { row.status = 'failed'; row.error = safeError(error); process.exitCode = 1; }
    row.elapsedMs = Date.now() - started; save(); console.log(`END ${item.id} ${row.status}`);
  }
}
main().catch(error => { result.fatal = safeError(error); process.exitCode = 1; }).finally(() => {
  result.settingsHashAfter = digest(fs.readFileSync(settingsFile));
  result.settingsUnchanged = result.settingsHashBefore === result.settingsHashAfter;
  if (!result.settingsUnchanged) process.exitCode = 1;
  result.finishedAt = new Date().toISOString(); save(); console.log('FINISHED; MANUAL VERDICT REQUIRED');
});
