const { openDatabase } = require("../storage/database");
const {
  buildSchema,
  MATCHING_CARD_SCHEMA,
  CANDIDATE_PROGRESS_SCHEMA,
  MESSAGE_PREVIEW_STATES_SCHEMA,
  MESSAGE_DISCOVERY_UNRESOLVED_ITEMS_SCHEMA,
  MESSAGE_DISCOVERY_RUNTIME_STATES_SCHEMA,
  MESSAGE_INBOX_SCHEMA,
  MESSAGE_TIMELINE_SCHEMA,
  MESSAGE_ACTION_SCHEMA,
  SHARED_SITE_PACING_STATES_SCHEMA,
  ONBOARDING_RUN_SCHEMA,
  MESSAGE_REPLY_LEARNING_SCHEMA,
  MESSAGE_REPLY_SENDING_SCHEMA,
  JOB_SEARCH_FUNNEL_SCHEMA,
  FUNNEL_STRATEGY_ROUNDS_SCHEMA,
  RESUME_OPTIMIZATION_SCHEMA,
  MOCK_INTERVIEW_V1_SCHEMA
} = require("../storage/schema");
const { currentSchemaVersion } = require("../storage/migrations");
const candidateStore = require("../storage/candidate_store");
const jobStore = require("../storage/job_store");
const { nowIso, parseJson, OUTCOME_STATUSES, storageError, optionalInteger, optionalPositiveInteger, nullableText, validDate, immediateTransaction } = require("../storage/storage_shared");
const scanStore = require("../storage/scan_store");
const messageLearningStore = require("../storage/message_learning_store");
const messageReplySendStore = require("../storage/message_reply_send_store");
const funnelStore = require("../storage/funnel_store");
const resumeOptimizationStore = require("../storage/resume_optimization_store");
const mockInterviewStore = require("../storage/mock_interview_store");
const workspacePlatformStore = require("../storage/workspace_platform_store");
const messageTimelineStore = require("../storage/message_timeline_store");
const {
  recordMessageReplyDrafts,
  getMessageReplyDraft,
  listOpenMessageReplyDrafts,
  saveMessageReplyDraftEdit,
  completeMessageReplyDraft,
  listCandidateAnswerMemories,
  reviseCandidateAnswerMemory,
  withdrawCandidateAnswerMemory,
  listCandidateFactRevisions,
  deleteCandidateFact,
  closeOpenMessageReplyDraftsByIntent,
  closeMessageReplyDrafts
} = messageLearningStore;
const workflowStore = require("../storage/workflow_store");
const {
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowRunByCommunicationBatch,
  listWorkflowRuns,
  getActiveWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowScan,
  attachWorkflowScanRun,
  replaceWorkflowScanContext,
  attachWorkflowCommunication,
  requestWorkflowRunConfigurationPause,
  recordWorkflowScanWait,
  recordWorkflowPlatformAccess,
  workflowJobTaskRow,
  jobAnalysisAttemptRow,
  countWorkflowJobTasks,
  insertWorkflowJobTaskRow,
  reactivateWorkflowDetailRequiredTaskRow,
  selectReadyWorkflowJobEntries,
  isWorkflowJobTaskObservationReady,
  settleIncompleteWorkflowJobTaskRows,
  selectClaimableWorkflowJobTaskRow,
  claimWorkflowJobTaskRow,
  insertJobAnalysisAttemptRow,
  incrementWorkflowRunActivity,
  getWorkflowObservationJob,
  listWorkflowJobTaskRows,
  listJobAnalysisAttemptRows,
  getWorkflowJobTaskRow,
  getRunningJobAnalysisAttemptRow,
  finishJobAnalysisAttemptRow,
  failWorkflowJobTaskRow,
  incrementWorkflowTimeoutCounters,
  countWorkflowJobTaskStatuses,
  selectEarliestRetryAvailableAt,
  markWorkflowJobTasksStopped,
  selectExpiredLeaseWorkflowJobTaskRows,
  completeWorkflowJobTaskRow,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE
} = workflowStore;
const {
  saveProfileAnalysis,
  attachResumeDocumentFile,
  getResumeDocument,
  saveSearchPlan,
  getCandidateProfile,
  listCandidateProfiles,
  saveCandidateResumeVersion,
  listCandidateResumeVersions,
  listMatchingResumeVersions,
  recordResumeParseAttempt,
  listResumeParseAttempts,
  updateCandidateProfile,
  getSearchPlan,
  getActiveSearchPlan,
  listSearchPlans,
  listProfileVersions,
  getLatestProfileVersionId,
  getSearchPlanDependency,
  getMatchingCard,
  getActiveMatchingCard,
  listMatchingCards,
  createMatchingCardDraft,
  confirmMatchingCard,
  saveMatchingCardDraftEdit,
  saveConfirmedMatchingCardRevision,
  getCandidateMatchingContext,
  compareProfileVersions,
  saveCandidateFact,
  listCandidateFacts
} = candidateStore;
const { scoreJob, decisionState, parseWorkSchedule } = require("./scoring");
const { parseBossActivityText } = require("./activity_status");
const { mergeJobMetadata } = require("./job_metadata");
const { NEGATIVE_FEEDBACK_STATUSES, normalizeFeedbackReason } = require("./feedback");
const { buildAnalysisRevision, analysisStaleReasons } = require("./analysis_revision");
const { decisionHardBlockers } = require("./model_contract");
const { normalizeMatchingCard, matchingCardRevision, matchingCardFromProfile } = require("./matching_card");
const { PRODUCT_POLICY } = require("./product_policy");
const {
  RECOMMENDATION_SCHEMA_VERSION,
  normalizeRecommendationTier
} = require("./decision_policy");const { buildOutcomeAnalytics } = require("./outcome_analytics");


const VALID_CANDIDATE_STATUSES = new Set(OUTCOME_STATUSES);

const CANDIDATE_JOB_ARCHIVES_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidate_job_archives (
  profile_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  archived_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, job_id),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_job_archives_profile
  ON candidate_job_archives(profile_id, archived_at DESC, job_id);
`;

const PLATFORM_SEARCH_CONTEXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS search_plan_platform_contexts (
  plan_id INTEGER NOT NULL,
  site TEXT NOT NULL CHECK(site IN ('boss', 'zhaopin')),
  search_template_json TEXT NOT NULL,
  filter_summary_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(plan_id, site),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id)
);
`;

const WORKSPACE_PLATFORM_PREFERENCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_platform_preferences (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  platforms_json TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const COMMUNICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS communication_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL DEFAULT 'boss',
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  browser_mode TEXT NOT NULL CHECK(browser_mode IN ('edge', 'portable')),
  status TEXT NOT NULL CHECK(status IN ('confirmed','running','paused','stopping','completed','stopped','interrupted','failed')),
  policy_json TEXT NOT NULL DEFAULT '{}',
  runtime_json TEXT NOT NULL DEFAULT '{}',
  confirmed_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  stop_code TEXT,
  stop_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id)
);

CREATE TABLE IF NOT EXISTS communication_batch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  job_url TEXT NOT NULL,
  title_snapshot TEXT NOT NULL,
  company_snapshot TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending','opening','verified','click_dispatched','succeeded','already_communicated','job_unavailable','target_mismatch','action_unavailable','platform_rejected','transport_failed','ambiguous','stopped')),
  click_count INTEGER NOT NULL DEFAULT 0 CHECK(click_count BETWEEN 0 AND 1),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  clicked_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, job_id),
  FOREIGN KEY(batch_id) REFERENCES communication_batches(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_communication_batches_plan ON communication_batches(plan_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_communication_items_batch ON communication_batch_items(batch_id, position);
CREATE INDEX IF NOT EXISTS idx_communication_items_job ON communication_batch_items(job_id, status);
`;

const WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  site TEXT NOT NULL DEFAULT 'boss' CHECK(site IN ('boss', 'zhaopin')),
  local_day TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK(status IN ('created','scanning','analyzing','review_required','communicating','paused','completed','interrupted','failed','stopped')),
  target_success_count INTEGER NOT NULL CHECK(target_success_count >= 0),
  successful_count INTEGER NOT NULL DEFAULT 0 CHECK(successful_count >= 0),
  inventory_count INTEGER NOT NULL DEFAULT 0 CHECK(inventory_count >= 0),
  candidate_gap INTEGER NOT NULL DEFAULT 0 CHECK(candidate_gap >= 0),
  scan_needed INTEGER NOT NULL DEFAULT 1 CHECK(scan_needed IN (0, 1)),
  keywords_json TEXT NOT NULL DEFAULT '[]',
  budget_json TEXT NOT NULL DEFAULT '{}',
  planner_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  control_state TEXT NOT NULL DEFAULT 'none' CHECK(control_state IN ('none','pause_requested','stop_requested')),
  resume_phase TEXT CHECK(resume_phase IS NULL OR resume_phase IN ('scanning','analyzing')),
  recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK(recovery_generation >= 0),
  circuit_timeout_job_count INTEGER NOT NULL DEFAULT 0 CHECK(circuit_timeout_job_count >= 0),
  lifetime_timeout_job_count INTEGER NOT NULL DEFAULT 0 CHECK(lifetime_timeout_job_count >= 0),
  progress_revision INTEGER NOT NULL DEFAULT 0 CHECK(progress_revision >= 0),
  last_activity_at TEXT,
  model_config_revision TEXT,
  platform_access_started_at TEXT,
  scan_run_id TEXT,
  scan_batch_id INTEGER,
  communication_batch_id INTEGER,
  shortfall_code TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  review_ready_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, local_day, site, sequence),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id),
  FOREIGN KEY(scan_run_id) REFERENCES scan_runs(id),
  FOREIGN KEY(scan_batch_id) REFERENCES batches(id),
  FOREIGN KEY(communication_batch_id) REFERENCES communication_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_active
  ON workflow_runs(profile_id, plan_id, local_day, status, sequence);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_daily
  ON workflow_runs(profile_id, local_day, site, sequence);

`;

const WORKFLOW_TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_job_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  observation_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position > 0),
  status TEXT NOT NULL CHECK(status IN (
    'pending','running','retry_pending','succeeded','failed','skipped','stopped'
  )),
  recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK(recovery_generation >= 0),
  attempt_count_in_generation INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count_in_generation BETWEEN 0 AND 2),
  total_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(total_attempt_count >= 0),
  priority INTEGER NOT NULL DEFAULT 100,
  available_at TEXT,
  lease_owner TEXT,
  leased_at TEXT,
  lease_expires_at TEXT,
  model_config_revision TEXT,
  last_attempt_model_revision TEXT,
  last_error_code TEXT,
  last_error_stage TEXT,
  last_error_kind TEXT,
  total_latency_ms INTEGER NOT NULL DEFAULT 0 CHECK(total_latency_ms >= 0),
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workflow_run_id, job_id),
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY(batch_id) REFERENCES batches(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(observation_id) REFERENCES job_observations(id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_job_tasks_claim
  ON workflow_job_tasks(workflow_run_id, status, priority, position);
CREATE INDEX IF NOT EXISTS idx_workflow_job_tasks_lease
  ON workflow_job_tasks(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS job_analysis_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  recovery_generation INTEGER NOT NULL CHECK(recovery_generation >= 0),
  attempt_in_generation INTEGER NOT NULL CHECK(attempt_in_generation BETWEEN 1 AND 2),
  total_attempt_number INTEGER NOT NULL CHECK(total_attempt_number > 0),
  profile_kind TEXT NOT NULL CHECK(profile_kind = 'batch_screening'),
  model_config_revision TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_mode TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  backup_used INTEGER NOT NULL DEFAULT 0 CHECK(backup_used IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  error_code TEXT,
  error_stage TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
  model_call_count INTEGER NOT NULL DEFAULT 0 CHECK(model_call_count >= 0),
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK(prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK(completion_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, recovery_generation, attempt_in_generation),
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY(task_id) REFERENCES workflow_job_tasks(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_job_analysis_attempts_progress
  ON job_analysis_attempts(workflow_run_id, model_config_revision, finished_at);
CREATE INDEX IF NOT EXISTS idx_job_analysis_attempts_task
  ON job_analysis_attempts(task_id, recovery_generation, attempt_in_generation);
`;

const SCHEMA = buildSchema({ COMMUNICATION_SCHEMA, WORKFLOW_SCHEMA, PLATFORM_SEARCH_CONTEXT_SCHEMA });

const MIGRATIONS = [
  {
    version: 1,
    name: "stable_scan_runtime",
    apply(db) {
      db.exec(SCHEMA);
      migrateLegacySchema(db);
    }
  },
  {
    version: 2,
    name: "communication_batches_v1",
    apply(db) {
      db.exec(COMMUNICATION_SCHEMA);
    }
  },
  {
    version: 3,
    name: "workflow_runs_v1",
    apply(db) {
      db.exec(WORKFLOW_SCHEMA);
      backfillHistoricalCommunicationOutcomes(db);
    }
  },
  {
    version: 4,
    name: "workflow_runs_three_slots",
    apply(db) {
      migrateWorkflowRunSlots(db);
    }
  },
  {
    version: 5,
    name: "candidate_matching_cards_v1",
    apply(db) {
      db.exec(MATCHING_CARD_SCHEMA);
      backfillMigrationMatchingCards(db);
    }
  },
  {
    version: 6,
    name: "durable_workflow_progress_v1",
    apply(db) {
      migrateWorkflowRunDurability(db);
    }
  },
  {
    version: 7,
    name: "candidate_progress_v1",
    apply(db) {
      db.exec(CANDIDATE_PROGRESS_SCHEMA);
      backfillCandidateProgress(db);
    }
  },
  {
    version: 8,
    name: "candidate_progress_event_idempotency",
    apply(db) {
      const columns = db.prepare(
        "PRAGMA table_info(candidate_progress_events)"
      ).all();
      if (!columns.some((column) => column.name === "idempotency_key")) {
        db.exec(
          "ALTER TABLE candidate_progress_events ADD COLUMN idempotency_key TEXT"
        );
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_progress_events_idempotency
          ON candidate_progress_events(card_id, idempotency_key);
        CREATE TRIGGER IF NOT EXISTS candidate_progress_events_require_idempotency
        BEFORE INSERT ON candidate_progress_events
        WHEN NEW.idempotency_key IS NULL OR trim(NEW.idempotency_key) = ''
        BEGIN
          SELECT RAISE(ABORT, 'candidate progress event idempotency required');
        END;
      `);
    }
  },
  {
    version: 9,
    name: "message_preview_states_v1",
    apply(db) {
      db.exec(MESSAGE_PREVIEW_STATES_SCHEMA);
    }
  },
  {
    version: 10,
    name: "communication_outcome_statuses_v1",
    apply(db) {
      migrateCommunicationOutcomeStatuses(db);
    }
  },
  {
    version: 11,
    name: "message_discovery_unresolved_items_v1",
    apply(db) {
      db.exec(MESSAGE_DISCOVERY_UNRESOLVED_ITEMS_SCHEMA);
    }
  },
  {
    version: 12,
    name: "communication_runtime_binding_v1",
    apply(db) {
      const columns = db.prepare(
        "PRAGMA table_info(communication_batches)"
      ).all();
      if (!columns.some((column) => column.name === "runtime_json")) {
        db.exec(
          "ALTER TABLE communication_batches ADD COLUMN runtime_json TEXT NOT NULL DEFAULT '{}'"
        );
      }
    }
  },
  {
    version: 13,
    name: "message_discovery_safe_identity_v1",
    apply(db) {
      const columns = new Set(db.prepare(
        "PRAGMA table_info(message_discovery_unresolved_items)"
      ).all().map((column) => column.name));
      for (const [name, sql] of [
        ["position_title", "TEXT NOT NULL DEFAULT ''"],
        ["company", "TEXT NOT NULL DEFAULT ''"],
        ["salary", "TEXT NOT NULL DEFAULT ''"],
        ["city", "TEXT NOT NULL DEFAULT ''"],
        ["identity_digest", "TEXT NOT NULL DEFAULT ''"]
      ]) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE message_discovery_unresolved_items ADD COLUMN ${name} ${sql}`);
        }
      }
    }
  },
  {
    version: 14,
    name: "onboarding_runs_v1",
    apply(db) {
      const columns = new Set(db.prepare(
        "PRAGMA table_info(candidate_profiles)"
      ).all().map((column) => column.name));
      if (!columns.has("is_ready")) {
        db.exec(
          "ALTER TABLE candidate_profiles ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 1 CHECK(is_ready IN (0, 1))"
        );
      }
      db.exec(ONBOARDING_RUN_SCHEMA);
    }
  },
  {
    version: 15,
    name: "message_discovery_runtime_states_v1",
    apply(db) {
      db.exec(MESSAGE_DISCOVERY_RUNTIME_STATES_SCHEMA);
    }
  },
  {
    version: 16,
    name: "shared_boss_pacing_v1",
    apply(db) {
      migrateSharedSitePacingStates(db);
    }
  },
  {
    version: 17,
    name: "message_reply_learning_v1",
    apply(db) {
      db.exec(MESSAGE_REPLY_LEARNING_SCHEMA);
      backfillCandidateFactRevisions(db);
    }
  },
  {
    version: 18,
    name: "job_search_funnel_v1",
    apply(db) {
      db.exec(JOB_SEARCH_FUNNEL_SCHEMA);
    }
  },
  {
    version: 19,
    name: "resume_optimization_v1",
    apply(db) {
      db.exec(RESUME_OPTIMIZATION_SCHEMA);
    }
  },
  {
    version: 20,
    name: "mock_interview_v1",
    apply(db) {
      db.exec(MOCK_INTERVIEW_V1_SCHEMA);
    }
  },
  {
    version: 21,
    name: "mock_interview_plan_binding_v2",
    apply(db) {
      migrateMockInterviewPlanBinding(db);
    }
  },
  {
    version: 22,
    name: "message_reply_sending_v1",
    apply(db) {
      db.exec(MESSAGE_REPLY_SENDING_SCHEMA);
    }
  },
  {
    version: 23,
    name: "funnel_strategy_rounds_v2",
    apply(db) {
      migrateFunnelStrategyRounds(db);
    }
  },
  {
    version: 24,
    name: "resume_optimization_whole_draft_v2",
    apply(db) {
      migrateResumeOptimizationWholeDraft(db);
    }
  },
  {
    version: 25,
    name: "mock_interview_resume_general_v3",
    apply(db) {
      migrateMockInterviewResumeGeneral(db);
    }
  },
  {
    version: 26,
    name: "workflow_hard_boundary_classification_v1",
    apply(db) {
      migrateWorkflowHardBoundaryClassification(db);
    }
  },
  {
    version: 27,
    name: "candidate_job_archives_v1",
    apply(db) {
      db.exec(CANDIDATE_JOB_ARCHIVES_SCHEMA);
    }
  },
  {
    version: 28,
    name: "resume_optimization_plan_binding_v3",
    apply(db) {
      migrateResumeOptimizationPlanBinding(db);
    }
  },
  {
    version: 29,
    name: "platform_search_contexts_and_workflow_source_v1",
    apply(db) {
      migrateWorkflowRunPlatforms(db);
      migrateJobClientCompanies(db);
      db.exec(PLATFORM_SEARCH_CONTEXT_SCHEMA);
    }
  },
  {
    version: 30,
    name: "message_discovery_unresolved_inbound_v1",
    apply(db) {
      db.exec(MESSAGE_DISCOVERY_UNRESOLVED_ITEMS_SCHEMA);
      const columns = new Set(db.prepare("PRAGMA table_info(message_discovery_unresolved_items)").all().map((column) => column.name));
      for (const [name, definition] of [
        ["inbound_json", "TEXT NOT NULL DEFAULT '[]'"],
        ["source_job_id", "TEXT NOT NULL DEFAULT ''"],
        ["last_message_id", "TEXT NOT NULL DEFAULT ''"]
      ]) {
        if (!columns.has(name)) db.exec(`ALTER TABLE message_discovery_unresolved_items ADD COLUMN ${name} ${definition}`);
      }
    }
  },
  {
    version: 31,
    name: "workspace_platform_preferences_v1",
    apply(db) {
      db.exec(WORKSPACE_PLATFORM_PREFERENCES_SCHEMA);
      backfillWorkspacePlatformPreference(db);
    }
  },
  {
    version: 32,
    name: "message_inbox_v1",
    apply(db) {
      db.exec(MESSAGE_INBOX_SCHEMA);
    }
  },
  {
    version: 33,
    name: "message_timeline_v1",
    apply(db) {
      db.exec(MESSAGE_TIMELINE_SCHEMA);
    }
  },
  {
    version: 34,
    name: "message_reply_send_platform_v1",
    apply(db) {
      db.exec(MESSAGE_REPLY_LEARNING_SCHEMA);
      db.exec(MESSAGE_REPLY_SENDING_SCHEMA);
      const columns = new Set(db.prepare("PRAGMA table_info(message_reply_send_items)").all().map((column) => column.name));
      if (!columns.has("platform")) {
        db.exec("ALTER TABLE message_reply_send_items ADD COLUMN platform TEXT NOT NULL DEFAULT 'boss' CHECK(platform IN ('boss','zhaopin'))");
      }
      if (Number(db.prepare("SELECT COUNT(*) AS n FROM message_reply_send_items").get().n) > 0) {
        db.exec(`UPDATE message_reply_send_items
          SET platform = COALESCE((
            SELECT jobs.source FROM message_reply_drafts drafts
            JOIN candidate_progress_cards cards ON cards.id = drafts.card_id
            JOIN jobs ON jobs.id = drafts.job_id
            WHERE drafts.id = message_reply_send_items.draft_id
              AND cards.id = message_reply_send_items.card_id
              AND cards.job_id = message_reply_send_items.job_id
              AND cards.source = jobs.source
              AND jobs.source IN ('boss','zhaopin')
          ), '')`);
      }
      const invalid = db.prepare("SELECT id FROM message_reply_send_items WHERE platform NOT IN ('boss','zhaopin') LIMIT 1").get();
      if (invalid) throw storageError("MESSAGE_REPLY_SEND_SOURCE_MISMATCH", "reply send item source is inconsistent");
    }
  },
  {
    version: 35,
    name: "message_platform_actions_v1",
    apply(db) {
      db.exec(MESSAGE_ACTION_SCHEMA);
    }
  }
];

function backfillWorkspacePlatformPreference(db) {
  const hasPreference = db.prepare("SELECT 1 FROM workspace_platform_preferences WHERE id = 1").get();
  if (hasPreference) return;
  const hasSite = (site) => {
    for (const [table, column] of [
      ["batches", "site"],
      ["jobs", "source"],
      ["workflow_runs", "site"],
      ["search_plan_platform_contexts", "site"]
    ]) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!exists) continue;
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
      if (!columns.has(column)) continue;
      if (db.prepare(`SELECT 1 FROM ${table} WHERE lower(${column}) = ? LIMIT 1`).get(site)) return true;
    }
    return false;
  };
  const platforms = [];
  if (hasSite("boss")) platforms.push("boss");
  if (hasSite("zhaopin")) platforms.push("zhaopin");
  if (!platforms.length) {
    const hasProfilesTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'candidate_profiles'").get();
    const hasExistingProfile = hasProfilesTable
      ? db.prepare("SELECT 1 FROM candidate_profiles LIMIT 1").get()
      : null;
    if (hasExistingProfile) platforms.push("boss");
  }
  if (!platforms.length) return;
  const now = nowIso();
  db.prepare(`INSERT INTO workspace_platform_preferences(
      id, platforms_json, selected_at, updated_at
    ) VALUES (1, ?, ?, ?)`).run(JSON.stringify(platforms), now, now);
}

function migrateWorkflowRunPlatforms(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'").get();
  if (!exists) {
    db.exec(WORKFLOW_SCHEMA);
    return;
  }
  const columns = new Set(db.prepare("PRAGMA table_info(workflow_runs)").all().map((column) => column.name));
  if (columns.has("site")) return;
  const taskExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_job_tasks'").get();
  const attemptExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_analysis_attempts'").get();
  if (attemptExists) db.exec("CREATE TABLE job_analysis_attempts_platform_v29 AS SELECT * FROM job_analysis_attempts; DROP TABLE job_analysis_attempts;");
  if (taskExists) db.exec("CREATE TABLE workflow_job_tasks_platform_v29 AS SELECT * FROM workflow_job_tasks; DROP TABLE workflow_job_tasks;");
  db.exec("DROP INDEX IF EXISTS idx_workflow_runs_active; DROP INDEX IF EXISTS idx_workflow_runs_daily;");
  db.exec("ALTER TABLE workflow_runs RENAME TO workflow_runs_legacy_v29;");
  db.exec(WORKFLOW_SCHEMA);
  db.exec(`INSERT INTO workflow_runs(
    id, profile_id, plan_id, site, local_day, sequence, status,
    target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
    keywords_json, budget_json, planner_json, metrics_json, control_state, resume_phase,
    recovery_generation, circuit_timeout_job_count, lifetime_timeout_job_count, progress_revision,
    last_activity_at, model_config_revision, platform_access_started_at, scan_run_id, scan_batch_id,
    communication_batch_id, shortfall_code, error_code, error_message, created_at, started_at,
    review_ready_at, finished_at, updated_at
  ) SELECT
    id, profile_id, plan_id, 'boss', local_day, sequence, status,
    target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
    keywords_json, budget_json, planner_json, metrics_json, control_state, resume_phase,
    recovery_generation, circuit_timeout_job_count, lifetime_timeout_job_count, progress_revision,
    last_activity_at, model_config_revision, platform_access_started_at, scan_run_id, scan_batch_id,
    communication_batch_id, shortfall_code, error_code, error_message, created_at, started_at,
    review_ready_at, finished_at, updated_at
  FROM workflow_runs_legacy_v29; DROP TABLE workflow_runs_legacy_v29;`);
  if (taskExists) {
    const taskSchema = WORKFLOW_TASK_SCHEMA.split("CREATE INDEX IF NOT EXISTS idx_workflow_job_tasks_claim")[0];
    db.exec(taskSchema);
    copyTable(db, "workflow_job_tasks_platform_v29", "workflow_job_tasks");
    db.exec("DROP TABLE workflow_job_tasks_platform_v29;");
  }
  if (attemptExists) {
    const attemptSchema = WORKFLOW_TASK_SCHEMA
      .slice(WORKFLOW_TASK_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS job_analysis_attempts"))
      .split("CREATE INDEX IF NOT EXISTS idx_job_analysis_attempts_progress")[0];
    db.exec(attemptSchema);
    copyTable(db, "job_analysis_attempts_platform_v29", "job_analysis_attempts");
    db.exec("DROP TABLE job_analysis_attempts_platform_v29;");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_active ON workflow_runs(profile_id, plan_id, local_day, status, sequence);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_daily ON workflow_runs(profile_id, local_day, site, sequence);
    CREATE INDEX IF NOT EXISTS idx_workflow_job_tasks_claim ON workflow_job_tasks(workflow_run_id, status, priority, position);
    CREATE INDEX IF NOT EXISTS idx_workflow_job_tasks_lease ON workflow_job_tasks(status, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_job_analysis_attempts_progress ON job_analysis_attempts(workflow_run_id, model_config_revision, finished_at);
    CREATE INDEX IF NOT EXISTS idx_job_analysis_attempts_task ON job_analysis_attempts(task_id, recovery_generation, attempt_in_generation);`);
}

function copyTable(db, from, to) {
  const names = db.prepare(`PRAGMA table_info(${from})`).all().map((column) => column.name);
  db.exec(`INSERT INTO ${to}(${names.join(", ")}) SELECT ${names.join(", ")} FROM ${from};`);
}

function migrateJobClientCompanies(db) {
  for (const table of ["jobs", "job_observations"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    if (!columns.has("client_company")) db.exec(`ALTER TABLE ${table} ADD COLUMN client_company TEXT`);
  }
}

function migrateResumeOptimizationPlanBinding(db) {
  db.exec(RESUME_OPTIMIZATION_SCHEMA);
  const columns = new Set(db.prepare("PRAGMA table_info(resume_optimizations)")
    .all().map((column) => column.name));
  if (!columns.has("plan_id")) {
    db.exec("ALTER TABLE resume_optimizations ADD COLUMN plan_id INTEGER REFERENCES search_plans(id)");
  }
  const hasStrategyRounds = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'candidate_funnel_strategy_rounds'`).get();
  if (hasStrategyRounds) {
    db.exec(`UPDATE resume_optimizations
      SET plan_id = (
        SELECT rounds.plan_id FROM candidate_funnel_strategy_rounds rounds
        WHERE rounds.id = resume_optimizations.strategy_round_id
      )
      WHERE plan_id IS NULL AND strategy_round_id IS NOT NULL`);
  }
  const hasObservations = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'job_observations'`).get();
  const hasBatches = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'batches'`).get();
  if (hasObservations && hasBatches) {
    db.exec(`UPDATE resume_optimizations AS optimization
      SET plan_id = (
        SELECT MIN(batch.search_plan_id)
        FROM json_each(optimization.target_job_ids_json) target
        JOIN job_observations observation ON observation.job_id = CAST(target.value AS INTEGER)
        JOIN batches batch ON batch.id = observation.batch_id
        WHERE batch.profile_id = optimization.profile_id
          AND batch.search_plan_id IS NOT NULL
      )
      WHERE optimization.plan_id IS NULL
        AND 1 = (
          SELECT COUNT(DISTINCT batch.search_plan_id)
          FROM json_each(optimization.target_job_ids_json) target
          JOIN job_observations observation ON observation.job_id = CAST(target.value AS INTEGER)
          JOIN batches batch ON batch.id = observation.batch_id
          WHERE batch.profile_id = optimization.profile_id
            AND batch.search_plan_id IS NOT NULL
        )`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_resume_optimizations_plan
    ON resume_optimizations(profile_id, plan_id, status, updated_at DESC, id DESC)`);
}

function migrateWorkflowHardBoundaryClassification(db) {
  const hasWorkflowTasks = db.prepare(`SELECT 1
    FROM sqlite_master WHERE type = 'table' AND name = 'workflow_job_tasks'`).get();
  const hasObservations = db.prepare(`SELECT 1
    FROM sqlite_master WHERE type = 'table' AND name = 'job_observations'`).get();
  if (!hasWorkflowTasks || !hasObservations) return;
  db.exec(`
    UPDATE workflow_job_tasks AS t SET
      last_error_code = NULL,
      last_error_stage = NULL,
      last_error_kind = NULL
    WHERE t.status = 'skipped'
      AND t.last_error_code = 'DETAIL_REQUIRED'
      AND EXISTS (
        SELECT 1
        FROM job_observations o
        WHERE o.id = t.observation_id
          AND o.job_id = t.job_id
          AND o.batch_id = t.batch_id
          AND CASE
            WHEN json_valid(COALESCE(o.analysis_json, '{}')) THEN (
              json_extract(o.analysis_json, '$.decisionSource') = 'hard_boundary'
              OR json_extract(o.analysis_json, '$.semanticStatus') = 'blocked'
            )
            ELSE 0
          END
      );
  `);
}

function migrateMockInterviewResumeGeneral(db) {
  db.exec(MOCK_INTERVIEW_V1_SCHEMA);
  const sessionColumns = new Set(db.prepare("PRAGMA table_info(mock_interview_sessions)")
    .all().map((column) => column.name));
  if (!sessionColumns.has("session_kind")) {
    db.exec(`
      DROP INDEX IF EXISTS idx_mock_interview_sessions_profile;
      DROP INDEX IF EXISTS idx_mock_interview_sessions_plan;
      CREATE TABLE mock_interview_sessions_v25 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        plan_id INTEGER,
        session_kind TEXT NOT NULL CHECK(session_kind IN ('resume_general', 'job_specific')),
        job_id INTEGER,
        resume_version_id INTEGER NOT NULL,
        context_hash TEXT NOT NULL,
        context_json TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
        report_json TEXT,
        model_identity_json TEXT NOT NULL DEFAULT '{}',
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
        FOREIGN KEY(plan_id) REFERENCES search_plans(id),
        FOREIGN KEY(job_id) REFERENCES jobs(id),
        FOREIGN KEY(resume_version_id) REFERENCES candidate_resume_versions(id),
        CHECK(
          (session_kind = 'resume_general' AND job_id IS NULL) OR
          (session_kind = 'job_specific' AND job_id IS NOT NULL)
        )
      );
      INSERT INTO mock_interview_sessions_v25(
        id, profile_id, plan_id, session_kind, job_id, resume_version_id,
        context_hash, context_json, settings_json, status, report_json,
        model_identity_json, completed_at, created_at, updated_at
      )
      SELECT id, profile_id, plan_id, 'job_specific', job_id, resume_version_id,
        context_hash, context_json, settings_json, status, report_json,
        model_identity_json, completed_at, created_at, updated_at
      FROM mock_interview_sessions;
      DROP TABLE mock_interview_sessions;
      ALTER TABLE mock_interview_sessions_v25 RENAME TO mock_interview_sessions;
    `);
  }
  const turnColumns = new Set(db.prepare("PRAGMA table_info(mock_interview_turns)")
    .all().map((column) => column.name));
  if (!turnColumns.has("resume_evidence_ids_json")) {
    db.exec("ALTER TABLE mock_interview_turns ADD COLUMN resume_evidence_ids_json TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mock_interview_sessions_profile
    ON mock_interview_sessions(profile_id, status, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_mock_interview_sessions_plan
    ON mock_interview_sessions(profile_id, plan_id, status, updated_at DESC, id DESC)`);
}

function migrateResumeOptimizationWholeDraft(db) {
  db.exec(RESUME_OPTIMIZATION_SCHEMA);
  const columns = new Set(db.prepare("PRAGMA table_info(resume_optimizations)")
    .all().map((column) => column.name));
  const additions = [
    ["target_direction", "TEXT NOT NULL DEFAULT ''"],
    ["generated_text", "TEXT NOT NULL DEFAULT ''"],
    ["draft_format", "TEXT NOT NULL DEFAULT 'legacy_suggestions'"],
    ["user_edited_at", "TEXT"],
    ["strategy_round_id", "INTEGER REFERENCES candidate_funnel_strategy_rounds(id)"]
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE resume_optimizations ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`UPDATE resume_optimizations
    SET generated_text = final_text
    WHERE status = 'activated' AND generated_text = '' AND final_text <> ''`);
}

function migrateFunnelStrategyRounds(db) {
  db.exec(JOB_SEARCH_FUNNEL_SCHEMA);
  db.exec(FUNNEL_STRATEGY_ROUNDS_SCHEMA);
  const entryColumns = new Set(db.prepare("PRAGMA table_info(candidate_funnel_entries)")
    .all().map((column) => column.name));
  if (!entryColumns.has("strategy_round_id")) {
    db.exec(`ALTER TABLE candidate_funnel_entries
      ADD COLUMN strategy_round_id INTEGER REFERENCES candidate_funnel_strategy_rounds(id)`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_candidate_funnel_entries_strategy_round
    ON candidate_funnel_entries(profile_id, plan_id, strategy_round_id, mature_at, id)`);

  const owners = db.prepare(`SELECT DISTINCT profile_id, plan_id
    FROM candidate_funnel_entries
    WHERE plan_id IS NOT NULL
    ORDER BY profile_id, plan_id`).all();
  for (const owner of owners) backfillFunnelStrategyRounds(db, Number(owner.profile_id), Number(owner.plan_id));
}

function backfillFunnelStrategyRounds(db, profileId, planId) {
  const existing = db.prepare(`SELECT count(*) AS count FROM candidate_funnel_strategy_rounds
    WHERE profile_id = ? AND plan_id = ?`).get(profileId, planId);
  if (Number(existing.count)) return;

  const plan = db.prepare("SELECT plan_json FROM search_plans WHERE id = ? AND profile_id = ?")
    .get(planId, profileId);
  if (!plan) return;
  const planJson = parseJson(plan.plan_json, {});
  const snapshot = JSON.stringify({
    planId,
    directions: Array.isArray(planJson.directions) ? planJson.directions : [],
    resumeVersionId: null
  });
  const insert = db.prepare(`INSERT INTO candidate_funnel_strategy_rounds(
    profile_id, plan_id, sequence_number, status, source_key,
    strategy_snapshot_json, change_kinds_json, change_note, resume_version_id,
    preliminary_sample_target, comparable_sample_target, formal_sample_target,
    legacy_uncertain, started_at, closed_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?)`);
  const attachCohort = db.prepare(`UPDATE candidate_funnel_entries
    SET strategy_round_id = ?
    WHERE profile_id = ? AND plan_id = ? AND cohort_id = ? AND strategy_round_id IS NULL`);
  let sequence = 0;
  const cohorts = db.prepare(`SELECT cohort.id, cohort.preliminary_sample_target,
      cohort.comparable_sample_target, cohort.formal_sample_target,
      cohort.started_at, cohort.frozen_at
    FROM candidate_funnel_cohorts cohort
    WHERE cohort.profile_id = ? AND EXISTS (
      SELECT 1 FROM candidate_funnel_entries entry
      WHERE entry.profile_id = ? AND entry.plan_id = ? AND entry.cohort_id = cohort.id
    )
    ORDER BY cohort.started_at, cohort.id`).all(profileId, profileId, planId);
  for (const cohort of cohorts) {
    sequence += 1;
    const createdAt = String(cohort.frozen_at || cohort.started_at);
    const result = insert.run(
      profileId,
      planId,
      sequence,
      "closed",
      `legacy:cohort:${Number(cohort.id)}`,
      snapshot,
      JSON.stringify(["initial"]),
      "历史批次，策略边界无法完整还原",
      Number(cohort.preliminary_sample_target),
      Number(cohort.comparable_sample_target),
      Number(cohort.formal_sample_target),
      String(cohort.started_at),
      String(cohort.frozen_at),
      createdAt,
      createdAt
    );
    attachCohort.run(Number(result.lastInsertRowid), profileId, planId, Number(cohort.id));
  }

  const open = db.prepare(`SELECT MIN(started_at) AS started_at, MAX(updated_at) AS updated_at,
      COUNT(*) AS count
    FROM candidate_funnel_entries
    WHERE profile_id = ? AND plan_id = ? AND cohort_id IS NULL AND strategy_round_id IS NULL`)
    .get(profileId, planId);
  if (!Number(open.count)) return;
  const policy = db.prepare(`SELECT preliminary_sample_target, comparable_sample_target, formal_sample_target
    FROM candidate_funnel_policies WHERE profile_id = ?`).get(profileId) || {
    preliminary_sample_target: 30,
    comparable_sample_target: 50,
    formal_sample_target: 70
  };
  sequence += 1;
  const startedAt = String(open.started_at);
  const updatedAt = String(open.updated_at || startedAt);
  const result = insert.run(
    profileId,
    planId,
    sequence,
    "active",
    "legacy:open",
    snapshot,
    JSON.stringify(["initial"]),
    "历史未冻结样本，策略边界无法完整还原",
    Number(policy.preliminary_sample_target),
    Number(policy.comparable_sample_target),
    Number(policy.formal_sample_target),
    startedAt,
    null,
    startedAt,
    updatedAt
  );
  db.prepare(`UPDATE candidate_funnel_entries SET strategy_round_id = ?
    WHERE profile_id = ? AND plan_id = ? AND cohort_id IS NULL AND strategy_round_id IS NULL`)
    .run(Number(result.lastInsertRowid), profileId, planId);
}

function migrateMockInterviewPlanBinding(db) {
  db.exec(MOCK_INTERVIEW_V1_SCHEMA);
  const sessionColumns = new Set(db.prepare("PRAGMA table_info(mock_interview_sessions)")
    .all().map((column) => column.name));
  if (!sessionColumns.has("plan_id")) {
    db.exec("ALTER TABLE mock_interview_sessions ADD COLUMN plan_id INTEGER REFERENCES search_plans(id)");
  }
  db.exec(`UPDATE mock_interview_sessions AS session
    SET plan_id = (
      SELECT MIN(batch.search_plan_id)
      FROM job_observations AS observation
      JOIN batches AS batch ON batch.id = observation.batch_id
      WHERE observation.job_id = session.job_id
        AND batch.profile_id = session.profile_id
        AND batch.search_plan_id IS NOT NULL
    )
    WHERE session.plan_id IS NULL
      AND 1 = (
        SELECT COUNT(DISTINCT batch.search_plan_id)
        FROM job_observations AS observation
        JOIN batches AS batch ON batch.id = observation.batch_id
        WHERE observation.job_id = session.job_id
          AND batch.profile_id = session.profile_id
          AND batch.search_plan_id IS NOT NULL
      )`);
  const turnColumns = new Set(db.prepare("PRAGMA table_info(mock_interview_turns)")
    .all().map((column) => column.name));
  if (!turnColumns.has("answer_evidence")) {
    db.exec("ALTER TABLE mock_interview_turns ADD COLUMN answer_evidence TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mock_interview_sessions_plan
    ON mock_interview_sessions(profile_id, plan_id, status, updated_at DESC, id DESC)`);
}

function backfillCandidateFactRevisions(db) {
  db.exec(`INSERT INTO candidate_fact_revisions(
    profile_id, fact_key, fact_value, operation, source,
    answer_memory_id, evidence_text, withdrawn_at, created_at
  )
  SELECT profile_id, fact_key, fact_value, 'set', source,
    NULL, '', NULL, updated_at
  FROM candidate_facts
  WHERE NOT EXISTS (
    SELECT 1 FROM candidate_fact_revisions r
    WHERE r.profile_id = candidate_facts.profile_id
      AND r.fact_key = candidate_facts.fact_key
  )`);
}

function migrateSharedSitePacingStates(db) {
  const bySite = new Map();
  const add = (siteValue, pacingValue, updatedAtValue) => {
    const site = String(siteValue || "").trim().toLowerCase();
    const pacing = scanStore.normalizeBossPacing(pacingValue);
    if (!site || !pacing) return;
    const entries = bySite.get(site) || [];
    entries.push(pacing);
    bySite.set(site, entries);
    const timestamp = String(updatedAtValue || "");
    if (Number.isFinite(Date.parse(timestamp))) {
      const previous = bySite.get(`${site}:updatedAt`) || "";
      if (!previous || Date.parse(timestamp) > Date.parse(previous)) bySite.set(`${site}:updatedAt`, timestamp);
    }
  };
  for (const row of db.prepare(`SELECT platform, pacing_json, updated_at
    FROM message_discovery_runtime_states`).all()) {
    add(row.platform, parseJson(row.pacing_json, null), row.updated_at);
  }
  for (const row of db.prepare(`SELECT site, filter_snapshot_json, COALESCE(finished_at, started_at) AS updated_at
    FROM batches WHERE lower(site) = 'boss'`).all()) {
    add(row.site, parseJson(row.filter_snapshot_json, {})?.runtime?.bossPacing, row.updated_at);
  }
  db.exec(`
    ALTER TABLE message_discovery_runtime_states RENAME TO message_discovery_runtime_states_v15;
    ${SHARED_SITE_PACING_STATES_SCHEMA}
  `);
  const insert = db.prepare(`INSERT INTO message_discovery_runtime_states(platform, pacing_json, updated_at)
    VALUES (?, ?, ?)`);
  for (const [site, states] of bySite) {
    if (site.endsWith(":updatedAt")) continue;
    const pacing = scanStore.mergeBossPacingStates(...states);
    if (pacing) insert.run(site, JSON.stringify(pacing), bySite.get(`${site}:updatedAt`) || nowIso());
  }
  db.exec("DROP TABLE message_discovery_runtime_states_v15");
}
const SCHEMA_VERSION = currentSchemaVersion(MIGRATIONS);

function openDb(dbPath) {
  return openDatabase(dbPath, { schemaVersion: SCHEMA_VERSION, migrations: MIGRATIONS, nowIso });
}

function migrateCommunicationOutcomeStatuses(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'communication_batch_items'").get();
  if (!table) {
    db.exec(COMMUNICATION_SCHEMA);
    return;
  }
  const sql = String(table.sql || "");
  if (sql.includes("platform_rejected") && sql.includes("transport_failed")) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_communication_items_batch;
    DROP INDEX IF EXISTS idx_communication_items_job;
    ALTER TABLE communication_batch_items RENAME TO communication_batch_items_v9;
  `);
  db.exec(COMMUNICATION_SCHEMA);
  db.exec(`
    INSERT INTO communication_batch_items(
      id, batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
      status, click_count, evidence_json, error_code, error_message,
      started_at, clicked_at, finished_at, updated_at
    ) SELECT
      id, batch_id, job_id, position, job_url, title_snapshot, company_snapshot,
      status, click_count, evidence_json, error_code, error_message,
      started_at, clicked_at, finished_at, updated_at
    FROM communication_batch_items_v9;
    DROP TABLE communication_batch_items_v9;
  `);
}

function migrateWorkflowRunSlots(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'").get();
  if (!table) {
    db.exec(WORKFLOW_SCHEMA);
    return;
  }
  if (/sequence\s+BETWEEN\s+1\s+AND\s+3/i.test(String(table.sql || ""))) return;

  db.exec(`
    DROP INDEX IF EXISTS idx_workflow_runs_active;
    DROP INDEX IF EXISTS idx_workflow_runs_daily;
    ALTER TABLE workflow_runs RENAME TO workflow_runs_two_slots;
  `);
  db.exec(WORKFLOW_SCHEMA);
  db.exec(`
    INSERT INTO workflow_runs(
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      scan_run_id, scan_batch_id, communication_batch_id,
      shortfall_code, error_code, error_message,
      created_at, started_at, review_ready_at, finished_at, updated_at
    )
    SELECT
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      scan_run_id, scan_batch_id, communication_batch_id,
      shortfall_code, error_code, error_message,
      created_at, started_at, review_ready_at, finished_at, updated_at
    FROM workflow_runs_two_slots;
    DROP TABLE workflow_runs_two_slots;
  `);
}

function migrateWorkflowRunDurability(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'").get();
  if (!table) {
    db.exec(WORKFLOW_SCHEMA);
    db.exec(WORKFLOW_TASK_SCHEMA);
    return;
  }
  if (/control_state/i.test(String(table.sql || ""))) {
    db.exec(WORKFLOW_TASK_SCHEMA);
    backfillWorkflowAnalysisTasks(db);
    return;
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_workflow_runs_active;
    DROP INDEX IF EXISTS idx_workflow_runs_daily;
    ALTER TABLE workflow_runs RENAME TO workflow_runs_v5;
  `);
  db.exec(WORKFLOW_SCHEMA);
  db.exec(`
    INSERT INTO workflow_runs(
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      scan_run_id, scan_batch_id, communication_batch_id,
      shortfall_code, error_code, error_message,
      created_at, started_at, review_ready_at, finished_at, updated_at
    )
    SELECT
      id, profile_id, plan_id, local_day, sequence, status,
      target_success_count, successful_count, inventory_count, candidate_gap, scan_needed,
      keywords_json, budget_json, planner_json, metrics_json,
      scan_run_id, scan_batch_id, communication_batch_id,
      shortfall_code, error_code, error_message,
      created_at, started_at, review_ready_at, finished_at, updated_at
    FROM workflow_runs_v5;
    DROP TABLE workflow_runs_v5;
  `);
  db.exec(WORKFLOW_TASK_SCHEMA);
  backfillWorkflowAnalysisTasks(db);
}

// 旧工作流补建任务：不调用模型、网络或真实平台。只按已有 observation 的分析状态保守推断，
// 不把旧规则结果伪装成新模型成功，也不写入任何 job_analysis_attempts 历史。
function backfillWorkflowAnalysisTasks(db) {
  const workflows = db.prepare(`
    SELECT id, scan_batch_id
    FROM workflow_runs
    WHERE scan_batch_id IS NOT NULL
    ORDER BY created_at, id
  `).all();
  for (const workflow of workflows) {
    const rows = db.prepare(`
      SELECT o.id AS observation_id, o.job_id AS job_id, o.analysis_json AS analysis_json
      FROM job_observations o
      WHERE o.batch_id = ?
      ORDER BY o.seen_at, o.id
    `).all(workflow.scan_batch_id);
    const insertTask = db.prepare(`
      INSERT OR IGNORE INTO workflow_job_tasks(
        workflow_run_id, batch_id, job_id, observation_id, position, status,
        recovery_generation, attempt_count_in_generation, total_attempt_count, priority,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 100, ?, ?)
    `);
    let position = 0;
    for (const row of rows) {
      const analysis = parseJson(row.analysis_json, {});
      const semantic = String(analysis.semanticStatus || "");
      const source = String(analysis.decisionSource || "");
      let status = "pending";
      if (semantic === "complete" && source === "model") status = "succeeded";
      else if (source === "local_rules" || semantic === "rule_only") status = "skipped";
      position += 1;
      const now = nowIso();
      insertTask.run(
        workflow.id,
        workflow.scan_batch_id,
        row.job_id,
        row.observation_id,
        position,
        status,
        now,
        now
      );
    }
  }
}

// 旧数据补卡：不调用模型、网络或真实平台，只为尚无任何 draft/confirmed 卡的候选人，
// 从其最新画像版本与关联简历文档生成 source="migration" 的草稿卡。
function backfillMigrationMatchingCards(db) {
  const candidates = db.prepare("SELECT id, source_hash FROM candidate_profiles").all();
  const existingCard = db.prepare(`SELECT id FROM candidate_matching_cards
    WHERE profile_id = ? AND status IN ('draft', 'confirmed') LIMIT 1`);
  const latestVersion = db.prepare(`SELECT pv.id AS profile_version_id, pv.profile_json, pv.resume_document_id,
      rd.content_hash AS resume_content_hash
    FROM profile_versions pv
    LEFT JOIN resume_documents rd ON rd.id = pv.resume_document_id
    WHERE pv.profile_id = ?
    ORDER BY pv.created_at DESC, pv.id DESC LIMIT 1`);
  const insert = db.prepare(`INSERT INTO candidate_matching_cards(
    profile_id, profile_version_id, resume_document_id, resume_content_hash,
    card_json, status, source, confirmed_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'draft', 'migration', NULL, ?, ?)`);
  for (const candidate of candidates) {
    if (existingCard.get(Number(candidate.id))) continue;
    const version = latestVersion.get(Number(candidate.id));
    if (!version) continue;
    const card = normalizeMatchingCard(matchingCardFromProfile(parseJson(version.profile_json, {})), { source: "migration" });
    const now = nowIso();
    insert.run(
      Number(candidate.id),
      Number(version.profile_version_id),
      version.resume_document_id || null,

      String(version.resume_content_hash || candidate.source_hash || ""),
      JSON.stringify(card),
      now,
      now
    );
  }
}

function migrateLegacySchema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
  if (!columns.has("analysis_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN analysis_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns.has("quality_tags_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN quality_tags_json TEXT NOT NULL DEFAULT '[]'");
  }
  const batchColumns = new Set(db.prepare("PRAGMA table_info(batches)").all().map((column) => column.name));
  const migratedLegacyBatchStatus = !batchColumns.has("status");
  if (!batchColumns.has("profile_id")) db.exec("ALTER TABLE batches ADD COLUMN profile_id INTEGER");
  if (!batchColumns.has("search_plan_id")) db.exec("ALTER TABLE batches ADD COLUMN search_plan_id INTEGER");
  if (!batchColumns.has("filter_snapshot_json")) db.exec("ALTER TABLE batches ADD COLUMN filter_snapshot_json TEXT NOT NULL DEFAULT '{}'");
  if (!batchColumns.has("status")) db.exec("ALTER TABLE batches ADD COLUMN status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'partial', 'failed', 'interrupted'))");
  if (!batchColumns.has("finished_at")) db.exec("ALTER TABLE batches ADD COLUMN finished_at TEXT");
  if (!batchColumns.has("stop_code")) db.exec("ALTER TABLE batches ADD COLUMN stop_code TEXT");
  if (!batchColumns.has("stop_message")) db.exec("ALTER TABLE batches ADD COLUMN stop_message TEXT");
  const resumeColumns = new Set(db.prepare("PRAGMA table_info(resume_documents)").all().map((column) => column.name));
  if (!resumeColumns.has("diagnostics_json")) db.exec("ALTER TABLE resume_documents ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}'");
  if (!resumeColumns.has("stored_file_path")) db.exec("ALTER TABLE resume_documents ADD COLUMN stored_file_path TEXT");
  const resumeVersionColumns = new Set(db.prepare("PRAGMA table_info(candidate_resume_versions)").all().map((column) => column.name));
  if (!resumeVersionColumns.has("analysis_json")) db.exec("ALTER TABLE candidate_resume_versions ADD COLUMN analysis_json TEXT NOT NULL DEFAULT '{}'");
  const planColumns = new Set(db.prepare("PRAGMA table_info(search_plans)").all().map((column) => column.name));
  if (!planColumns.has("profile_version_id")) db.exec("ALTER TABLE search_plans ADD COLUMN profile_version_id INTEGER");
  const observationColumns = new Set(db.prepare("PRAGMA table_info(job_observations)").all().map((column) => column.name));
  if (!observationColumns.has("content_hash_version")) db.exec("ALTER TABLE job_observations ADD COLUMN content_hash_version INTEGER NOT NULL DEFAULT 0");
  const scanTargetColumns = new Set(db.prepare("PRAGMA table_info(scan_target_results)").all().map((column) => column.name));
  if (!scanTargetColumns.has("details_json")) db.exec("ALTER TABLE scan_target_results ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}'");
  db.exec(`
    INSERT OR IGNORE INTO job_observations(
      job_id, batch_id, keyword, title, company, location, salary, experience, education,
      boss_active_text, boss_active_days, url, tags_json, description, score, level,
      matches_json, risks_json, quality_tags_json, greeting, analysis_json, content_hash, content_hash_version, seen_at
    )
    SELECT id, batch_id, keyword, title, company, location, salary, experience, education,
      boss_active_text, boss_active_days, url, tags_json, description, score, level,
      matches_json, risks_json, quality_tags_json, greeting, analysis_json, 'legacy:' || id, 0, last_seen_at
    FROM jobs WHERE batch_id IS NOT NULL
  `);
  db.exec(`
    UPDATE candidate_resume_versions
    SET analysis_json = COALESCE((SELECT profile_json FROM candidate_profiles WHERE id = candidate_resume_versions.profile_id), '{}')
    WHERE analysis_json IS NULL OR analysis_json = '{}'
  `);
  db.exec(`
    UPDATE search_plans
    SET profile_version_id = (SELECT id FROM profile_versions WHERE profile_id = search_plans.profile_id ORDER BY created_at DESC, id DESC LIMIT 1)
    WHERE profile_version_id IS NULL
  `);
  db.exec(`
    INSERT OR IGNORE INTO candidate_job_states(profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at)
    SELECT batches.profile_id, jobs.id, batches.search_plan_id, applications.status, NULL, applications.note, NULL, applications.updated_at
    FROM applications
    JOIN jobs ON jobs.id = applications.job_id
    JOIN batches ON batches.id = jobs.batch_id
    WHERE batches.profile_id IS NOT NULL
      AND applications.id = (SELECT id FROM applications a2 WHERE a2.job_id = applications.job_id ORDER BY a2.updated_at DESC, a2.id DESC LIMIT 1)
  `);
  db.exec(`
    INSERT INTO profile_versions(profile_id, resume_document_id, profile_json, created_at)
    SELECT candidate_profiles.id, NULL, candidate_profiles.profile_json, candidate_profiles.updated_at
    FROM candidate_profiles
    WHERE NOT EXISTS (SELECT 1 FROM profile_versions pv WHERE pv.profile_id = candidate_profiles.id)
  `);
  db.exec(`
    INSERT OR IGNORE INTO candidate_resume_versions(
      profile_id, resume_document_id, version_key, name, target_roles_json, keywords_json,
      primary_projects_json, summary, is_active, created_at, updated_at
    )
    SELECT rd.profile_id, rd.id, 'document_' || rd.id, rd.original_file_name, '[]', '[]', '[]', '', 1, rd.created_at, rd.created_at
    FROM resume_documents rd
    WHERE NOT EXISTS (SELECT 1 FROM candidate_resume_versions rv WHERE rv.resume_document_id = rd.id)
  `);
  backfillObservationContentHashes(db);
  backfillWorkSchedules(db);
  if (migratedLegacyBatchStatus) backfillLegacyBatchStatuses(db);
}

function backfillLegacyBatchStatuses(db) {
  const batches = db.prepare("SELECT id, started_at FROM batches ORDER BY id").all();
  const targetFinished = db.prepare("SELECT MAX(finished_at) AS value FROM scan_target_results WHERE batch_id = ?");
  const observationFinished = db.prepare("SELECT MAX(seen_at) AS value FROM job_observations WHERE batch_id = ?");
  const update = db.prepare(`UPDATE batches
    SET status = ?, finished_at = ?, stop_code = ?, stop_message = ?
    WHERE id = ?`);
  for (const batch of batches) {
    const summary = scanStore.summarizeScanTargets(db, batch.id);
    const status = summary.total ? summary.status : "completed";
    const finishedAt = targetFinished.get(batch.id)?.value
      || observationFinished.get(batch.id)?.value
      || batch.started_at;
    const stopCode = status === "completed" ? "LEGACY_STATUS_INFERRED" : "LEGACY_TARGET_STATUS_INFERRED";
    const stopMessage = summary.total
      ? `Migrated from ${summary.total} legacy target checkpoint(s).`
      : "Migrated without legacy target checkpoints; completion was inferred from saved observations.";
    update.run(status, finishedAt, stopCode, stopMessage, batch.id);
  }
}

function backfillObservationContentHashes(db) {
  const rows = db.prepare(`
    SELECT id, title, company, location, salary, experience, education, tags_json, description
    FROM job_observations
    WHERE content_hash_version < 1
  `).all();
  const update = db.prepare("UPDATE job_observations SET content_hash = ?, content_hash_version = 1 WHERE id = ?");
  for (const row of rows) update.run(jobStore.sourceContentHash({ ...row, tags: parseJson(row.tags_json, []) }), row.id);
}

function backfillWorkSchedules(db) {
  const rows = db.prepare(`
    SELECT id, description, quality_tags_json, analysis_json
    FROM job_observations
    WHERE quality_tags_json NOT LIKE '%work_schedule_%'
  `).all();
  const update = db.prepare("UPDATE job_observations SET quality_tags_json = ?, analysis_json = ? WHERE id = ?");
  for (const row of rows) {
    const schedule = parseWorkSchedule(row.description || "");
    const qualityTags = (parseJson(row.quality_tags_json, []) || []).filter((tag) => !String(tag).startsWith("work_schedule_"));
    qualityTags.push(workScheduleQualityTag(schedule.kind));
    const analysis = {
      ...parseJson(row.analysis_json, {}),
      workSchedule: schedule.kind,
      workScheduleEvidence: schedule.evidence
    };
    update.run(JSON.stringify([...new Set(qualityTags)]), JSON.stringify(analysis), row.id);
  }
}

function workScheduleQualityTag(kind) {
  return {
    double_weekend: "work_schedule_double",
    alternating_weekend: "work_schedule_alternating",
    single_weekend: "work_schedule_single",
    unknown: "work_schedule_unknown"
  }[kind] || "work_schedule_unknown";
}

function backfillHistoricalCommunicationOutcomes(db) {
  const result = db.prepare(`WITH ranked AS (
      SELECT batches.profile_id, batches.plan_id, items.job_id, items.status, items.updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY batches.profile_id, items.job_id
          ORDER BY CASE items.status
            WHEN 'succeeded' THEN 0
            WHEN 'already_communicated' THEN 0
            WHEN 'job_unavailable' THEN 1
            WHEN 'target_mismatch' THEN 2
            WHEN 'action_unavailable' THEN 3
            ELSE 9 END,
            items.updated_at DESC, items.id DESC
        ) AS rank
      FROM communication_batch_items items
      JOIN communication_batches batches ON batches.id = items.batch_id
      WHERE items.status IN ('succeeded','already_communicated','job_unavailable','target_mismatch','action_unavailable')
    )
    INSERT OR IGNORE INTO candidate_job_states(
      profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at
    )

    SELECT profile_id, job_id, plan_id,
      CASE status
        WHEN 'succeeded' THEN 'applied'
        WHEN 'already_communicated' THEN 'applied'
        WHEN 'job_unavailable' THEN 'invalid'
        WHEN 'target_mismatch' THEN 'review'
        WHEN 'action_unavailable' THEN 'later'
      END,
      status,
      'RoleFlow v3 communication outcome backfill',
      CASE WHEN status = 'action_unavailable'
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+1 day') ELSE NULL END,
      updated_at
    FROM ranked WHERE rank = 1`).run();
  return Number(result.changes || 0);
}

function backfillCandidateProgress(db) {
  db.exec(`
    INSERT OR IGNORE INTO candidate_progress_cards(
      profile_id, plan_id, job_id, source, stage, next_action,
      last_event_at, created_at, updated_at
    )
    SELECT states.profile_id, states.plan_id, states.job_id, jobs.source,
      'waiting_reply', 'Wait for recruiter reply',
      states.updated_at, states.updated_at, states.updated_at
    FROM candidate_job_states states
    JOIN jobs ON jobs.id = states.job_id
    JOIN search_plans plans
      ON plans.id = states.plan_id
      AND plans.profile_id = states.profile_id
    WHERE states.reason_code IN ('communication_succeeded', 'succeeded', 'already_communicated')
  `);
  db.exec(`
    INSERT INTO candidate_progress_events(
      card_id, idempotency_key, type, actor, summary,
      metadata_json, occurred_at, created_at
    )
    SELECT cards.id,
      'migration:communication:' || states.profile_id || ':' || states.job_id || ':' || states.reason_code,
      CASE states.reason_code
        WHEN 'already_communicated' THEN 'contact_already_exists'
        ELSE 'contact_started'
      END,
      'system',
      CASE states.reason_code
        WHEN 'already_communicated' THEN 'Historical platform contact preserved'
        ELSE 'Historical verified contact preserved'
      END,
      json_object('source', 'migration', 'outcome', states.reason_code),
      states.updated_at,
      states.updated_at
    FROM candidate_job_states states
    JOIN candidate_progress_cards cards
      ON cards.profile_id = states.profile_id
      AND cards.job_id = states.job_id
    WHERE states.reason_code IN ('communication_succeeded', 'succeeded', 'already_communicated')
      AND NOT EXISTS (
        SELECT 1 FROM candidate_progress_events events
        WHERE events.card_id = cards.id
          AND events.idempotency_key =
            'migration:communication:' || states.profile_id || ':' || states.job_id || ':' || states.reason_code
      )
  `);
}

function getWorkflowHealthSnapshot(db, options = {}) {
  const planId = optionalPositiveInteger(options.planId, "planId");
  if (!planId) throw new Error("planId is required");
  const plan = getSearchPlan(db, planId);
  if (!plan) throw new Error("search plan not found");
  const profileId = optionalPositiveInteger(options.profileId || plan.profileId, "profileId");
  if (Number(plan.profileId) !== profileId) {
    throw new Error("search plan does not belong to the selected profile");
  }

  const generatedAt = validDate(options.now || nowIso(), "now");
  const jobLimit = boundedHealthLimit(options.jobLimit, 1000, 9999);
  const workflowLimit = boundedHealthLimit(options.workflowLimit, 100, 499);
  const eventLimit = boundedHealthLimit(options.eventLimit, 100, 199);
  const jobs = jobStore.listReportJobs(db, { profileId, planId, limit: jobLimit + 1 });
  const workflowRuns = workflowStore.listWorkflowRuns(db, { profileId, planId, limit: workflowLimit + 1 });
  const candidateEvents = jobStore.listCandidateJobEvents(db, { profileId, planId, limit: eventLimit + 1 });
  const selectedWorkflowRuns = workflowRuns.slice(0, workflowLimit);
  const selectedWorkflowIds = selectedWorkflowRuns.map((workflow) => workflow.id);
  const linkIssues = workflowStore.listWorkflowLinkIssues(db, selectedWorkflowIds);
  const stateIssues = workflowStore.listWorkflowStateInvariantViolations(db, selectedWorkflowIds);

  return Object.freeze({
    generatedAt, profileId, planId,
    jobs: Object.freeze(jobs.slice(0, jobLimit)),
    workflowRuns: Object.freeze(selectedWorkflowRuns),
    candidateEvents: Object.freeze(candidateEvents.slice(0, eventLimit)),
    linkIssues: Object.freeze([...linkIssues, ...stateIssues]),
    truncated: Object.freeze({
      jobs: jobs.length > jobLimit,
      workflowRuns: workflowRuns.length > workflowLimit,
      candidateEvents: candidateEvents.length > eventLimit
    })
  });
}

function boundedHealthLimit(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

module.exports = {
  SCHEMA,
  SCHEMA_VERSION,
  OUTCOME_STATUSES,
  SCAN_RUN_STATUSES: scanStore.SCAN_RUN_STATUSES,
  WORKFLOW_RUN_STATUSES,
  openDb,
  getWorkspacePlatformPreference: workspacePlatformStore.getWorkspacePlatformPreference,
  saveWorkspacePlatformPreference: workspacePlatformStore.saveWorkspacePlatformPreference,
  upsertMessageEvents: messageTimelineStore.upsertMessageEvents,
  listMessageEvents: messageTimelineStore.listMessageEvents,
  latestMessageEvent: messageTimelineStore.latestMessageEvent,
  immediateTransaction,
  recordMessageReplyDrafts,
  getMessageReplyDraft,
  listOpenMessageReplyDrafts,
  saveMessageReplyDraftEdit,
  completeMessageReplyDraft,
  listCandidateAnswerMemories,
  reviseCandidateAnswerMemory,
  withdrawCandidateAnswerMemory,
  listCandidateFactRevisions,
  deleteCandidateFact,
  closeOpenMessageReplyDraftsByIntent,
  closeMessageReplyDrafts,
  saveMessageInboundContext: messageReplySendStore.saveMessageInboundContext,
  getMessageInboundContext: messageReplySendStore.getMessageInboundContext,
  listMessageInboundContexts: messageReplySendStore.listMessageInboundContexts,
  deleteMessageInboundContext: messageReplySendStore.deleteMessageInboundContext,
  createMessageReplySendBatch: messageReplySendStore.createMessageReplySendBatch,
  getMessageReplySendBatch: messageReplySendStore.getMessageReplySendBatch,
  listMessageReplySendItems: messageReplySendStore.listMessageReplySendItems,
  transitionMessageReplySendBatch: messageReplySendStore.transitionMessageReplySendBatch,
  transitionMessageReplySendItem: messageReplySendStore.transitionMessageReplySendItem,
  stopPendingMessageReplySendItems: messageReplySendStore.stopPendingMessageReplySendItems,
  getFunnelPolicy: funnelStore.getFunnelPolicy,
  saveFunnelPolicy: funnelStore.saveFunnelPolicy,
  getActiveFunnelStrategyRound: funnelStore.getActiveFunnelStrategyRound,
  getFunnelStrategyRound: funnelStore.getFunnelStrategyRound,
  listFunnelStrategyRounds: funnelStore.listFunnelStrategyRounds,
  ensureActiveFunnelStrategyRound: funnelStore.ensureActiveFunnelStrategyRound,
  startFunnelStrategyRound: funnelStore.startFunnelStrategyRound,
  ensureFunnelEntry: funnelStore.ensureFunnelEntry,
  getFunnelEntry: funnelStore.getFunnelEntry,
  listFunnelEntries: funnelStore.listFunnelEntries,
  freezeReadyFunnelCohort: funnelStore.freezeReadyFunnelCohort,
  listFunnelCohorts: funnelStore.listFunnelCohorts,
  getFunnelCohort: funnelStore.getFunnelCohort,
  listFunnelProgressEvents: funnelStore.listFunnelProgressEvents,
  createResumeOptimization: resumeOptimizationStore.createResumeOptimization,
  getResumeOptimization: resumeOptimizationStore.getResumeOptimization,
  listResumeOptimizations: resumeOptimizationStore.listResumeOptimizations,
  saveResumeOptimizationDraft: resumeOptimizationStore.saveResumeOptimizationDraft,
  activateResumeOptimization: resumeOptimizationStore.activateResumeOptimization,
  createMockInterviewSession: mockInterviewStore.createMockInterviewSession,
  getMockInterviewSession: mockInterviewStore.getMockInterviewSession,
  listMockInterviewSessions: mockInterviewStore.listMockInterviewSessions,
  appendMockInterviewQuestion: mockInterviewStore.appendMockInterviewQuestion,
  answerMockInterviewTurn: mockInterviewStore.answerMockInterviewTurn,
  completeMockInterviewSession: mockInterviewStore.completeMockInterviewSession,
  recordMockInterviewRetry: mockInterviewStore.recordMockInterviewRetry,
  workflowJobTaskRow,
  jobAnalysisAttemptRow,
  countWorkflowJobTasks,
  insertWorkflowJobTaskRow,
  reactivateWorkflowDetailRequiredTaskRow,
  selectReadyWorkflowJobEntries,
  isWorkflowJobTaskObservationReady,
  settleIncompleteWorkflowJobTaskRows,
  selectClaimableWorkflowJobTaskRow,
  claimWorkflowJobTaskRow,
  insertJobAnalysisAttemptRow,
  incrementWorkflowRunActivity,
  getWorkflowObservationJob,
  listWorkflowJobTaskRows,
  listJobAnalysisAttemptRows,
  getWorkflowJobTaskRow,
  getRunningJobAnalysisAttemptRow,
  finishJobAnalysisAttemptRow,
  failWorkflowJobTaskRow,
  incrementWorkflowTimeoutCounters,
  WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE,
  countWorkflowJobTaskStatuses,
  selectEarliestRetryAvailableAt,
  markWorkflowJobTasksStopped,
  requestWorkflowRunConfigurationPause,
  recordWorkflowScanWait,
  recordWorkflowPlatformAccess,
  selectExpiredLeaseWorkflowJobTaskRows,
  completeWorkflowJobTaskRow,
  backfillHistoricalCommunicationOutcomes,
  createMatchingCardDraft,
  getMatchingCard,
  getActiveMatchingCard,
  listMatchingCards,
  saveMatchingCardDraftEdit,
  confirmMatchingCard,
  saveConfirmedMatchingCardRevision,
  getCandidateMatchingContext,
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowRunByCommunicationBatch,
  listWorkflowRuns,
  getActiveWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowScan,
  attachWorkflowScanRun,
  replaceWorkflowScanContext,
  attachWorkflowCommunication,
  createBatch: scanStore.createBatch,

  createAndBindScanBatch: scanStore.createAndBindScanBatch,
  getBatch: scanStore.getBatch,
  getLatestResumableBatch: scanStore.getLatestResumableBatch,
  createScanRun: scanStore.createScanRun,
  getScanRun: scanStore.getScanRun,
  getLatestScanRun: scanStore.getLatestScanRun,
  beginScanRun: scanStore.beginScanRun,
  claimScanRun: scanStore.claimScanRun,
  heartbeatScanRun: scanStore.heartbeatScanRun,
  finishScanRun: scanStore.finishScanRun,
  recordScanRunProcessExit: scanStore.recordScanRunProcessExit,
  interruptOrphanedScanRuns: scanStore.interruptOrphanedScanRuns,
  checkpointScanProgress: scanStore.checkpointScanProgress,
  getSitePacingState: scanStore.getSitePacingState,
  setSitePacingState: scanStore.setSitePacingState,
  mergeBossPacingStates: scanStore.mergeBossPacingStates,
  checkpointScanTarget: scanStore.checkpointScanTarget,
  recordScanTargetResult: scanStore.recordScanTargetResult,
  listScanTargetResults: scanStore.listScanTargetResults,
  listLatestScanTargetResults: scanStore.listLatestScanTargetResults,
  summarizeScanTargets: scanStore.summarizeScanTargets,
  getSiteRuntimeState: scanStore.getSiteRuntimeState,
  setSiteRuntimeState: scanStore.setSiteRuntimeState,
  clearSiteRuntimeState: scanStore.clearSiteRuntimeState,
  recordSiteAccessEvent: scanStore.recordSiteAccessEvent,
  listSiteAccessEvents: scanStore.listSiteAccessEvents,
  acquireSiteScanLease: scanStore.acquireSiteScanLease,
  renewSiteScanLease: scanStore.renewSiteScanLease,
  releaseSiteScanLease: scanStore.releaseSiteScanLease,
  getSiteScanLease: scanStore.getSiteScanLease,
  listReusableJobDetails: scanStore.listReusableJobDetails,
  recordJobRefreshAttempt: scanStore.recordJobRefreshAttempt,
  listJobRefreshAttempts: scanStore.listJobRefreshAttempts,
  getLatestJobRefreshAttempt: scanStore.getLatestJobRefreshAttempt,
  getPlatformFilterCatalog: scanStore.getPlatformFilterCatalog,
  savePlatformFilterCatalog: scanStore.savePlatformFilterCatalog,
  upsertKeywordSource: jobStore.upsertKeywordSource,
  upsertJob: jobStore.upsertJob,
  listReportJobs: jobStore.listReportJobs,
  markApplication: jobStore.markApplication,
  bindBatchToPlan: jobStore.bindBatchToPlan,
  rescorePlanObservations: jobStore.rescorePlanObservations,
  reassessBatchObservations: jobStore.reassessBatchObservations,
  addFollowUpNote: jobStore.addFollowUpNote,
  recordCandidateJobEvent: jobStore.recordCandidateJobEvent,
  listCandidateJobEvents: jobStore.listCandidateJobEvents,
  recordRecommendationFeedback: jobStore.recordRecommendationFeedback,
  saveCandidateFact,
  listCandidateFacts,
  markCandidateJob: jobStore.markCandidateJob,
  buildFeedbackSummary: jobStore.buildFeedbackSummary,
  buildBatchSummary: jobStore.buildBatchSummary,
  getWorkflowHealthSnapshot,
  getLatestBatchId: jobStore.getLatestBatchId,
  getLatestMainScanBatchId: jobStore.getLatestMainScanBatchId,
  saveProfileAnalysis,
  attachResumeDocumentFile,
  getResumeDocument,
  updateCandidateProfile,
  saveCandidateResumeVersion,
  listCandidateResumeVersions,
  listMatchingResumeVersions,
  recordResumeParseAttempt,
  listResumeParseAttempts,
  saveSearchPlan,
  getCandidateProfile,
  listCandidateProfiles,
  getSearchPlan,
  getActiveSearchPlan,
  listSearchPlans,
  listProfileVersions,
  compareProfileVersions,
  getLatestProfileVersionId,
  getSearchPlanDependency,
  listDecisionPool: jobStore.listDecisionPool,
  getOutcomeAnalyticsSnapshot: jobStore.getOutcomeAnalyticsSnapshot,
  listDecisionQueue: jobStore.listDecisionQueue,
  archiveCandidateJob: jobStore.archiveCandidateJob,
  restoreCandidateJob: jobStore.restoreCandidateJob,
  isCandidateJobArchived: jobStore.isCandidateJobArchived,
  isJobAwaitingAction: jobStore.isJobAwaitingAction,
  decisionBucket: jobStore.decisionBucket,
  applyJobQualityGovernance: jobStore.applyJobQualityGovernance,
  isActivityProbeDue: jobStore.isActivityProbeDue,
  sourceContentHash: jobStore.sourceContentHash,
  getModelCache: jobStore.getModelCache,
  saveModelCache: jobStore.saveModelCache
};
