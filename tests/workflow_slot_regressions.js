const assert = require('node:assert/strict');
const test = require('node:test');
const storage = require('../src/core/storage');
const { buildWorkflowDashboardState } = require('../src/dashboard/server');
const { startWorkflow, resumeWorkflow, controlWorkflow } = require('../src/application/workflow');
const { buildTodayViewModel } = require('../src/dashboard/view_models/today');
const { requestWorkflowStop, resumeWorkflowRun } = require('../src/core/workflow_control');
const { appError } = require('../src/core/observability');

const day = '2030-01-02';
function fixture() {
  const db = storage.openDb(':memory:');
  const at = `${day}T00:00:00.000Z`;
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at)
    VALUES ('序号测试','{}',?,?)`).run(at, at).lastInsertRowid);
  const plans = ['A', 'B'].map(name => {
    const plan = { keywords: [{ word: `工程师${name}`, priority: 'A' }] };
    const id = Number(db.prepare(`INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at)
      VALUES (?,?,?,1,?,?)`).run(profileId, name, JSON.stringify(plan), at, at).lastInsertRowid);
    return { id, profileId, plan };
  });
  return { db, profileId, plans };
}
function seed(f, plan, sequence, { site = 'boss', accessed = false } = {}) {
  const run = storage.createWorkflowRun(f.db, { profileId: f.profileId, planId: plan.id, site, localDay: day,
    sequence, scanNeeded: true, budget: { maxDetailTotal: 120, browserPageBudget: 20 }, createdAt: `${day}T00:00:00.000Z` });
  return storage.transitionWorkflowRun(f.db, { id: run.id, status: 'stopped',
    platformAccessStartedAt: accessed ? `${day}T00:01:00.000Z` : null,
    metrics: { access: { details: accessed ? 1 : 0, pages: accessed ? 1 : 0, scrolls: 0 } } });
}
function deps(f) {
  return { appError, getSearchPlan: (_, id) => f.plans.find(plan => plan.id === id), getCandidateProfile: () => ({}),
    getCandidateMatchingContext: () => ({}), getSearchPlanDependency: () => null, assertSearchPlanReady() {},
    getActiveWorkflow: (db, plan, site) => storage.getActiveWorkflowRun(db, { profileId: plan.profileId, planId: plan.id, site }),
    buildDashboardState: (db, plan, _now, options) => buildWorkflowDashboardState(db, plan, new Date(`${day}T12:00:00.000Z`), options),
    workflowBlockedMessage: code => code, resolveNewWorkflowBrowser: () => ({ browserMode: 'edge', cdpPort: null }),
    acquisitionContextResolver: async ({ site }) => ({ site }), assertAcquisitionContext() {}, acquisitionModeOf: () => 'generated',
    freezeWorkflowPlan: () => ({}), preparePlanForNewWorkflow: async () => {}, scanAvailability() {},
    workflowModelProfilesSnapshot: () => ({ batch_screening: { revision: 'test' } }),
    createWorkflowRun: storage.createWorkflowRun, transitionWorkflowRun: storage.transitionWorkflowRun,
    spawnScan() {}, settleFailedWorkflowLaunch() {}, logger: { info() {} } };
}

test('same-day plan change shares used slots and can start the remaining slot', async () => {
  const f = fixture();
  try {
    seed(f, f.plans[0], 1, { accessed: true });
    seed(f, f.plans[0], 2, { accessed: true });
    const state = buildWorkflowDashboardState(f.db, f.plans[1], new Date(`${day}T12:00:00.000Z`));
    assert.equal(state.slotsUsed, 2);
    const result = await startWorkflow({ db: f.db, input: { planId: f.plans[1].id, modelReady: true, scanRuns: new Map() }, deps: deps(f) });
    assert.equal(result.workflow.sequence, 3);
    assert.equal(result.workflow.planId, f.plans[1].id);
  } finally { f.db.close(); }
});

test('three stops before platform access do not make the fourth start an invalid sequence', async () => {
  const f = fixture();
  try {
    const prior = [1, 2, 3].map(sequence => seed(f, f.plans[0], sequence));
    const state = buildWorkflowDashboardState(f.db, f.plans[0], new Date(`${day}T12:00:00.000Z`));
    assert.equal(state.slotsUsed, 0);
    const result = await startWorkflow({ db: f.db, input: { planId: f.plans[0].id, modelReady: true, scanRuns: new Map() }, deps: deps(f) });
    assert.equal(result.workflow.sequence, 1);
    for (const old of prior) assert.equal(storage.getWorkflowRun(f.db, old.id).status, 'stopped', 'cancelled attempt remains retrievable');
  } finally { f.db.close(); }
});

test('three accessed slots stay capped after changing plan while another platform remains separate', async () => {
  const f = fixture();
  try {
    for (const sequence of [1, 2, 3]) seed(f, f.plans[0], sequence, { accessed: true });
    await assert.rejects(startWorkflow({ db: f.db, input: { planId: f.plans[1].id, modelReady: true, scanRuns: new Map() }, deps: deps(f) }),
      error => error.code === 'WORKFLOW_DAILY_RUN_LIMIT');
    const result = await startWorkflow({ db: f.db, input: { planId: f.plans[1].id, site: 'zhaopin', modelReady: true, scanRuns: new Map() }, deps: deps(f) });
    assert.equal(result.workflow.sequence, 1);
  } finally { f.db.close(); }
});

test('released attempt keeps a complete audit snapshot and old requests cannot operate the new UUID', async () => {
  const f = fixture();
  try {
    const prior = [1, 2, 3].map(sequence => seed(f, f.plans[0], sequence));
    const before = f.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(prior[0].id);
    const current = storage.createWorkflowRun(f.db, { profileId: f.profileId, planId: f.plans[1].id, site: 'boss', localDay: day, allocateSlot: true });
    assert.notEqual(current.id, prior[0].id);
    const event = f.db.prepare("SELECT payload_json FROM events WHERE event_type = 'workflow_empty_slot_released'").get();
    assert.deepEqual(JSON.parse(event.payload_json).row, { ...before });
    assert.equal(storage.getWorkflowRun(f.db, prior[0].id).archived, true);
    assert(!storage.listWorkflowRuns(f.db, { profileId: f.profileId, localDay: day }).some(run => run.id === prior[0].id));
    const earlyDeps = { appError, getWorkflowRun: storage.getWorkflowRun };
    await assert.rejects(resumeWorkflow({ db: f.db, input: { workflowRunId: prior[0].id }, deps: earlyDeps }), error => error.code === 'WORKFLOW_RUN_TERMINAL');
    await assert.rejects(controlWorkflow({ db: f.db, input: { workflowRunId: prior[0].id, action: 'stop' }, deps: earlyDeps }), error => error.code === 'WORKFLOW_RUN_TERMINAL');
    assert.throws(() => storage.transitionWorkflowRun(f.db, { id: prior[0].id, status: 'scanning' }), error => error.code === 'WORKFLOW_RUN_TERMINAL');
    assert.throws(() => requestWorkflowStop(f.db, { workflowRunId: prior[0].id, confirmStop: true, now: `${day}T12:00:00.000Z` }), error => error.code === 'WORKFLOW_RUN_TERMINAL');
    assert.throws(() => resumeWorkflowRun(f.db, { workflowRunId: prior[0].id, now: `${day}T12:00:00.000Z` }), error => error.code === 'WORKFLOW_RUN_TERMINAL');
    assert.throws(() => storage.createWorkflowRun(f.db, { id: prior[0].id, profileId: f.profileId, planId: f.plans[0].id,
      localDay: '2030-01-03', sequence: 1 }), error => error.code === 'WORKFLOW_RUN_ID_EXISTS');
    assert.equal(storage.getWorkflowRun(f.db, current.id).status, 'created');
  } finally { f.db.close(); }
});

test('active run recovery uses its loaded archive flag without reading history again', () => {
  const f = fixture();
  try {
    const run = storage.createWorkflowRun(f.db, { profileId: f.profileId, planId: f.plans[0].id, localDay: day, sequence: 1 });
    storage.transitionWorkflowRun(f.db, { id: run.id, status: 'scanning' });
    storage.transitionWorkflowRun(f.db, { id: run.id, status: 'analyzing' });
    const prepare = f.db.prepare.bind(f.db);
    const executed = [];
    f.db.prepare = sql => {
      const statement = prepare(sql);
      return new Proxy(statement, { get(target, property) {
        const value = Reflect.get(target, property);
        if (!['get', 'all', 'run'].includes(property)) return typeof value === 'function' ? value.bind(target) : value;
        return (...args) => { executed.push(String(sql)); return value.apply(target, args); };
      } });
    };
    let recovered;
    try {
      recovered = storage.transitionWorkflowRun(f.db, { id: run.id, status: 'interrupted', errorCode: 'FIXTURE_STALE' });
    } finally { f.db.prepare = prepare; }
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.errorCode, 'FIXTURE_STALE');
    assert.equal(executed.length, 3, 'load, transition and readback must not add another archive read');
    assert(!executed.some(sql => /\b(?:FROM|JOIN)\s+events\b/i.test(sql)), 'active recovery must not read historical events');
  } finally { f.db.close(); }
});

test('archive and new attempt insertion roll back together if the new insertion fails', () => {
  const f = fixture();
  try {
    const prior = [1, 2, 3].map(sequence => seed(f, f.plans[0], sequence));
    const rows = f.db.prepare('SELECT * FROM workflow_runs ORDER BY sequence').all();
    assert.throws(() => storage.createWorkflowRun(f.db, { id: prior[1].id, profileId: f.profileId, planId: f.plans[1].id,
      site: 'boss', localDay: day, allocateSlot: true }));
    assert.deepEqual(f.db.prepare('SELECT * FROM workflow_runs ORDER BY sequence').all(), rows);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM events WHERE event_type = 'workflow_empty_slot_released'").get().n, 0);
    const exec = f.db.exec.bind(f.db);
    f.db.exec = sql => { if (sql === 'COMMIT') throw new Error('injected slot commit failure'); return exec(sql); };
    assert.throws(() => storage.createWorkflowRun(f.db, { profileId: f.profileId, planId: f.plans[1].id,
      site: 'boss', localDay: day, allocateSlot: true }), /injected slot commit failure/);
    f.db.exec = exec;
    assert.deepEqual(f.db.prepare('SELECT * FROM workflow_runs ORDER BY sequence').all(), rows);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM events WHERE event_type = 'workflow_empty_slot_released'").get().n, 0);
  } finally { f.db.close(); }
});

test('browser access, cached analysis and communication output are never recycled as empty attempts', () => {
  for (const kind of ['access_event', 'inventory', 'task', 'communication', 'live_child', 'scan_batch_output']) {
    const f = fixture();
    try {
      const runs = [1, 2, 3].map(sequence => seed(f, f.plans[0], sequence));
      for (const run of runs) {
        if (kind === 'inventory') f.db.prepare('UPDATE workflow_runs SET inventory_count = 1 WHERE id = ?').run(run.id);
        if (kind === 'communication') f.db.prepare('UPDATE workflow_runs SET review_ready_at = ? WHERE id = ?').run(`${day}T01:00:00.000Z`, run.id);
        if (kind === 'access_event' || kind === 'live_child' || kind === 'scan_batch_output') {
          const batchId = kind === 'scan_batch_output'
            ? storage.createBatch(f.db, 'boss', '工程师', '先写输出后未完成工作流绑定', { profileId: f.profileId, searchPlanId: f.plans[0].id }) : null;
          const scan = storage.createScanRun(f.db, { planId: f.plans[0].id, site: 'boss', batchId });
          f.db.prepare('UPDATE scan_runs SET status = ? WHERE id = ?').run(kind === 'live_child' ? 'running' : 'interrupted', scan.id);
          f.db.prepare('UPDATE workflow_runs SET scan_run_id = ? WHERE id = ?').run(scan.id, run.id);
          if (kind === 'access_event') storage.recordSiteAccessEvent(f.db, { site: 'boss', action: 'list_navigation', runId: scan.id });
          if (kind === 'scan_batch_output') storage.upsertJob(f.db, { source: 'boss', sourceId: run.id, title: '工程师', company: '本地输出' }, batchId);
        }
        if (kind === 'task') {
          const batchId = storage.createBatch(f.db, 'boss', '工程师', '已生成本地输出', { profileId: f.profileId, searchPlanId: f.plans[0].id });
          const jobId = storage.upsertJob(f.db, { source: 'boss', sourceId: run.id, title: '工程师', company: '测试公司' }, batchId);
          const observation = f.db.prepare('SELECT id FROM job_observations WHERE job_id = ? AND batch_id = ?').get(jobId, batchId);
          f.db.prepare(`INSERT INTO workflow_job_tasks(workflow_run_id,batch_id,job_id,observation_id,position,status,created_at,updated_at)
            VALUES (?,?,?,?,1,'pending',?,?)`).run(run.id, batchId, jobId, observation.id, `${day}T01:00:00.000Z`, `${day}T01:00:00.000Z`);
        }
      }
      assert.throws(() => storage.createWorkflowRun(f.db, { profileId: f.profileId, planId: f.plans[1].id,
        site: 'boss', localDay: day, allocateSlot: true }), error => error.code === 'WORKFLOW_RUN_SLOT_UNAVAILABLE', kind);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM events WHERE event_type = 'workflow_empty_slot_released'").get().n, 0);
      assert.equal(storage.listWorkflowRuns(f.db, { profileId: f.profileId }).length, 3);
    } finally { f.db.close(); }
  }
});

test('another plan active run continues through its original UUID instead of a new plan request', () => {
  const f = fixture();
  try {
    const run = storage.createWorkflowRun(f.db, { profileId: f.profileId, planId: f.plans[0].id, localDay: day, sequence: 1 });
    const state = buildWorkflowDashboardState(f.db, f.plans[1], new Date(`${day}T12:00:00.000Z`));
    assert.equal(state.activeRun?.id, run.id);
    const vm = buildTodayViewModel({ profile: { id: f.profileId }, planRecord: f.plans[1], plan: f.plans[1].plan,
      workflowState: state, validation: { valid: true, errors: [], warnings: [] } });
    assert.equal(vm.primary.href, `/workflow?runId=${run.id}`);
    assert.equal(vm.primary.type, 'link');
  } finally { f.db.close(); }
});
