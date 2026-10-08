// Real configured model, synthetic cases, production services. Never an offline gate.
// Completed calls require a separate case-by-case content verdict.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const i = arg.indexOf('='); return [arg.slice(2, i < 0 ? undefined : i), i < 0 ? true : arg.slice(i + 1)];
}));
if (!options.live || !options['settings-root'] || !options.output) throw Error('Require --live --settings-root=... --output=fresh-D-file --phase=reply');
const output = path.resolve(options.output);
if (!/^D:[\\/]/i.test(output) || fs.existsSync(output)) throw Error('Use a fresh output file on D:');
fs.mkdirSync(path.dirname(output), { recursive: true });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fixtureFile = path.join(__dirname, 'fixtures/effect_acceptance/situations.json');
const cases = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
const personasFile = path.join(__dirname, 'fixtures/effect_acceptance/cases.json');
const persona = JSON.parse(fs.readFileSync(personasFile, 'utf8')).personas.find(p => p.id === 'backend-junior');
const settingsRoot = path.resolve(options['settings-root']);
const settingsFile = path.join(settingsRoot, '.runtime/settings/model.json');
const settings = require('../src/core/model_settings');
const config = settings.resolveRuntimeModelConfig({ root: settingsRoot, readOnly: true });
if (!settings.isModelReady(config) || config.modelConfig.provider === 'mock') throw Error('Require a ready real model');
const real = require('../src/adapters/models').createModelAdapter(config.modelConfig);
const firstEvidence = options['replay-first'] ? JSON.parse(fs.readFileSync(path.resolve(options['replay-first']), 'utf8')) : null;
if (firstEvidence && firstEvidence.casesHash !== hash(fs.readFileSync(fixtureFile))) throw Error('First question belongs to different cases');
const workspace = path.resolve(__dirname, '..');
const result = { startedAt: new Date().toISOString(), phase: options.phase || 'reply',
  evidenceType: 'real configured model, synthetic inputs, production services; manual outcome assessment required; no platform operations',
  source: { sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
    diffHash: hash(execFileSync('git', ['-c', 'core.safecrlf=false', 'diff', '--binary'], { cwd: workspace })),
    files: Object.fromEntries(['src/adapters/models/structured.js','src/core/message_reply_contract.js','src/core/message_reply_analyzer.js',
      'src/core/mock_interview.js','src/application/mock_interview/index.js'].map(p => [p,hash(fs.readFileSync(path.join(workspace,p)))])) },
  casesHash: hash(fs.readFileSync(fixtureFile)), personasHash: hash(fs.readFileSync(personasFile)),
  settingsHashBefore: hash(fs.readFileSync(settingsFile)), model: {provider: real.provider, model: real.model}, calls: [], cases: [] };
const save = () => fs.writeFileSync(output, JSON.stringify(result, null, 2));
const safeError = e => ({code:e.code || e.name,message:String(e.message || '').replace(/[A-Za-z0-9_-]{32,}/g,'[token]')});
const adapter = new Proxy(real,{get(target,key){const fn=target[key];if(typeof fn!=='function')return fn;
  return async (...args)=>{const call={method:key,input:structuredClone(args[0]),startedAt:new Date().toISOString()};result.calls.push(call);save();
    if(firstEvidence && key==='generateMockInterviewStep' && args[0].turns.length===0){
      const saved=firstEvidence.calls.find(c=>c.method===key && !c.input.turns.length && c.input.context.sessionKind===args[0].context.sessionKind);
      if(!saved?.output || JSON.stringify(saved.input.context.resumeEvidenceCatalog)!==JSON.stringify(args[0].context.resumeEvidenceCatalog))throw Error('No exact real first-question evidence');
      call.replayedFirstQuestion={file:path.resolve(options['replay-first']),hash:hash(JSON.stringify(saved.output))};
      call.output=structuredClone(saved.output);save();return call.output;
    }
    console.log(`START ${key}`);const at=Date.now();try{call.output=await fn.apply(target,args);return call.output;}
    catch(e){call.error=safeError(e);throw e;}finally{call.elapsedMs=Date.now()-at;save();console.log(`END ${key} ${call.elapsedMs}ms`);}};}});
async function sample(id,input,expected,action){const row={id,input:structuredClone(input),expected,status:'running'};result.cases.push(row);save();
  try{row.output=await action();row.status='completed';}catch(e){row.error=safeError(e);row.status='failed';}save();console.log(`CASE ${id} ${row.status}`);return row.output;}
async function replies(){
  const analyze=require('../src/core/message_reply_analyzer').createMessageReplyAnalyzer({adapter});
  for(const item of cases.reply){if(options.case && !options.case.split(',').includes(item.id))continue;
    const input={profile:{candidate:{targetTitles:persona.target},projects:[{name:'订单后台',canSay:[persona.resume]}]},
      currentResume:{text:persona.resume},job:{id:1,title:persona.jobs[0].title,company:'验收合成公司',description:persona.jobs[0].jd},
      platform:'zhaopin',now:cases.now,messages:[{text:item.text}],requestedActions:item.requestedActions||[],facts:[
        {key:'availability_date',value:'办理交接后两周可到岗',updatedAt:cases.now,source:'user_confirmed'},
        ...(item.availability ? [{key:'interview_availability',value:item.availability,updatedAt:cases.now,source:'user_confirmed'}] : [])]};
    await sample(item.id,input,item.expected,()=>analyze(input));
  }
}
async function interviews(){
  const storage=require('../src/core/storage');const db=storage.openDb(':memory:');
  const profile={candidate:{name:persona.name,targetTitles:persona.target},projects:[{name:'订单后台',canSay:[persona.resume]}]};
  const owner=storage.saveProfileAnalysis(db,{profile,document:{text:persona.resume,contentHash:hash(persona.resume),format:'text',originalFileName:'synthetic.txt'},
    searchPlan:{name:'隔离情境验收',directions:persona.target}});
  const batch=storage.createBatch(db,'boss',persona.jobs[0].title,'effect',{profileId:owner.profileId,searchPlanId:owner.planId});
  const jobId=storage.upsertJob(db,{source:'boss',sourceId:'synthetic-situations',title:persona.jobs[0].title,company:'验收合成公司',
    description:persona.jobs[0].jd,analysis:{semanticStatus:'complete',recommendation:'apply',coreResponsibilities:[persona.jobs[0].jd]}},batch);
  const service=require('../src/application/mock_interview').createMockInterviewService({db,adapter});
  const identity={profileId:owner.profileId,planId:owner.planId,resumeVersionId:owner.resumeVersionId};
  try{for(const sessionKind of ['resume_general','job_specific']){
    if(options.mode && options.mode!==sessionKind)continue;
    const start={...identity,sessionKind,settings:{plannedQuestions:3,type:'mixed',difficulty:'standard'},...(sessionKind==='job_specific'?{jobId}:{})};
    const initial=await sample(`${sessionKind}/first`,start,'A natural ability question with a grounded reason; no HR registration questions.',()=>service.startSession(start));
    if(!initial)continue;
    const question=initial.turns[0];
    for(const item of cases.interviewAnswers){
      if(options.case && !options.case.split(',').includes(item.id))continue;
      // Fork the unchanged real first question, context and settings via the business store.
      // This isolates answer-dependent behavior; it is not a UI end-to-end claim.
      const branch=require('../src/storage/mock_interview_store').createMockInterviewSession(db,{...identity,sessionKind,jobId:initial.jobId,
        context:initial.context,settings:initial.settings,initialQuestion:{text:question.questionText,focus:question.questionFocus,
          resumeEvidenceIds:question.resumeEvidenceIds,questionKind:'topic_transition',basedOnTurnNumber:null,answerEvidence:''},modelIdentity:initial.modelIdentity});
      const answer={...identity,sessionId:branch.id,turnNumber:1,answerText:item.answer};
      const answered=await sample(`${sessionKind}/${item.id}`,{...answer,question:question.questionText,
        boundary:'controlled saved-state fork of the real first question'},item.expected,()=>service.answerTurn(answer));
      if(!answered || item.id!=='vague')continue;
      // Continue one normal conversation to its report and real retry comparison.
      let session=answered;
      for(let number=2;number<=3;number++){
        const turn=session.turns.find(t=>t.turnNumber===number);if(!turn)break;
        const answerText=cases.interviewAnswers.find(a=>a.id=== (number===2?'complete':'qualitative')).answer;
        session=await sample(`${sessionKind}/sequence-${number}`,{question:turn.questionText,answerText},
          'Feedback must respond to this answer and preserve its actual scope.',()=>service.answerTurn({...identity,sessionId:branch.id,turnNumber:number,answerText}));
        if(!session)break;
      }
      if(!session)continue;
      const report=await sample(`${sessionKind}/report`,{sessionId:branch.id},'Specific, non-contradictory improvements grounded in actual questions and answers.',
        ()=>service.finishSession({...identity,sessionId:branch.id}));
      if(!report)continue;
      for(const [id,answerText,expected] of [
        ['retry-complete',cases.interviewAnswers.find(a=>a.id==='complete').answer,'Recognize substantive improvement over vague original; do not invent experience.'],
        ['retry-offtopic','我喜欢看电影和旅游，也喜欢参加各种活动，和大家交流，平时非常努力，希望能有更好的发展。'.repeat(4),'Do not mark a longer irrelevant answer as improvement.']])
        await sample(`${sessionKind}/${id}`,{question:question.questionText,answerText},expected,()=>service.retryTurn({...identity,sessionId:branch.id,turnNumber:1,answerText}));
    }
  }}finally{db.close();}
}
async function recordedInterviewInputs(){
  const core=require('../src/core/mock_interview');
  const evidenceFile=path.resolve(options.evidence||'');
  const evidence=JSON.parse(fs.readFileSync(evidenceFile,'utf8'));
  if(evidence.casesHash!==result.casesHash)throw Error('Recorded input belongs to different cases');
  result.recordedInput={file:evidenceFile,hash:hash(fs.readFileSync(evidenceFile)),boundary:'exact synthetic model inputs; fresh model outputs through production validators; not UI/service persistence'};
  const step=evidence.calls.find(c=>c.method==='generateMockInterviewStep'&&c.input.turns.at(-1)?.question.includes('前端或云环境'));
  const report=evidence.calls.find(c=>c.method==='reviewMockInterview'&&c.input.turns.some(t=>t.question.includes('前端或云环境')));
  if(!step?.input||!report?.input)throw Error('Original optional-scope inputs not found');
  await sample('original-or-question',step.input,'Accept the actual frontend example; do not demand cloud work.',async()=>{
    const input=structuredClone(step.input);
    const raw=await adapter.generateMockInterviewStep(input);
    return core.validateInterviewStep(raw,{...input.context,turns:input.turns});
  });
  await sample('original-or-report',report.input,'Report and outlines retain the chosen frontend scope.',async()=>{
    const input=structuredClone(report.input);
    return core.validateInterviewReport(await adapter.reviewMockInterview(input),{turns:input.turns});
  });
  if(options['report-evidence']){
    const file=path.resolve(options['report-evidence']);const source=JSON.parse(fs.readFileSync(file,'utf8'));
    if(source.casesHash!==result.casesHash)throw Error('Report input belongs to different cases');
    result.secondRecordedInput={file,hash:hash(fs.readFileSync(file))};
    const call=source.calls.find(c=>c.method==='reviewMockInterview'&&c.input.context.sessionKind==='job_specific');
    if(!call?.input)throw Error('Specific report input not found');
    await sample('chosen-date-validation-report',call.input,'Deepen the chosen date validation example; do not require every suggested example.',async()=>{
      const input=structuredClone(call.input);
      return core.validateInterviewReport(await adapter.reviewMockInterview(input),{turns:input.turns});
    });
  }
}
async function main(){save();if(result.phase==='reply')await replies();else if(result.phase==='interview')await interviews();else if(result.phase==='recorded-interview')await recordedInterviewInputs();else throw Error('Phase not implemented');
  result.settingsHashAfter=hash(fs.readFileSync(settingsFile));if(result.settingsHashAfter!==result.settingsHashBefore)throw Error('Settings changed');
  result.finishedAt=new Date().toISOString();save();}
main().catch(e=>{result.fatal=safeError(e);save();console.error(result.fatal);process.exitCode=1;});
