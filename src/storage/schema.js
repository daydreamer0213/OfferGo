function buildSchema({ COMMUNICATION_SCHEMA, WORKFLOW_SCHEMA, PLATFORM_SEARCH_CONTEXT_SCHEMA } = {}) {
  return `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  backup_path TEXT
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  keyword TEXT,
  started_at TEXT NOT NULL,
  note TEXT,
  profile_id INTEGER,
  search_plan_id INTEGER,
  filter_snapshot_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'partial', 'failed', 'interrupted')),
  finished_at TEXT,
  stop_code TEXT,
  stop_message TEXT
);

CREATE TABLE IF NOT EXISTS candidate_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  source_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  original_file_name TEXT NOT NULL,
  format TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  resume_text TEXT NOT NULL,
  text_truncated INTEGER NOT NULL DEFAULT 0,
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  stored_file_path TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);

CREATE TABLE IF NOT EXISTS resume_parse_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER,
  original_file_name TEXT NOT NULL,
  format TEXT,
  input_bytes INTEGER NOT NULL DEFAULT 0,
  extraction_method TEXT,
  char_count INTEGER NOT NULL DEFAULT 0,
  preview TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);

CREATE TABLE IF NOT EXISTS candidate_resume_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  resume_document_id INTEGER,
  version_key TEXT NOT NULL,
  name TEXT NOT NULL,
  target_roles_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  primary_projects_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  analysis_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, version_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(resume_document_id) REFERENCES resume_documents(id)
);

CREATE TABLE IF NOT EXISTS search_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  profile_version_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  keyword TEXT,
  title TEXT NOT NULL,
  company TEXT,
  client_company TEXT,
  location TEXT,
  salary TEXT,
  experience TEXT,
  education TEXT,
  boss_active_text TEXT,
  boss_active_days INTEGER,
  url TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  level TEXT,
  matches_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  quality_tags_json TEXT NOT NULL DEFAULT '[]',
  greeting TEXT,
  analysis_json TEXT NOT NULL DEFAULT '{}',

  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  batch_id INTEGER,
  UNIQUE(source, source_id)
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keyword_sources (
  keyword TEXT PRIMARY KEY,
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_filter_catalogs (
  site TEXT PRIMARY KEY,
  catalog_json TEXT NOT NULL,
  source TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  batch_id INTEGER NOT NULL,
  keyword TEXT,
  title TEXT NOT NULL,
  company TEXT,
  client_company TEXT,
  location TEXT,
  salary TEXT,
  experience TEXT,
  education TEXT,
  boss_active_text TEXT,
  boss_active_days INTEGER,
  url TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  level TEXT,
  matches_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  quality_tags_json TEXT NOT NULL DEFAULT '[]',
  greeting TEXT,
  analysis_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  content_hash_version INTEGER NOT NULL DEFAULT 1,
  seen_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(batch_id) REFERENCES batches(id),
  UNIQUE(batch_id, job_id)
);

CREATE TABLE IF NOT EXISTS candidate_job_states (
  profile_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  plan_id INTEGER,
  status TEXT NOT NULL,
  reason_code TEXT,
  note TEXT,
  review_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, job_id),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS candidate_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  plan_id INTEGER,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS profile_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  resume_document_id INTEGER,
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(resume_document_id) REFERENCES resume_documents(id)
);

CREATE TABLE IF NOT EXISTS candidate_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user_provided',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, fact_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);

CREATE TABLE IF NOT EXISTS model_cache (
  cache_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_target_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  target_key TEXT NOT NULL,
  city TEXT,
  keyword TEXT,
  lane_id TEXT,
  status TEXT NOT NULL,
  job_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  attempt_number INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  FOREIGN KEY(batch_id) REFERENCES batches(id)
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT 'scan',
  plan_id INTEGER,
  batch_id INTEGER,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'partial', 'failed', 'interrupted')),
  lease_owner TEXT,
  process_id INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  heartbeat_at TEXT,
  finished_at TEXT,
  stop_code TEXT,
  stop_message TEXT,
  process_exit_code INTEGER,
  process_signal TEXT,
  FOREIGN KEY(batch_id) REFERENCES batches(id)
);

CREATE TABLE IF NOT EXISTS site_runtime_states (
  site TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reason_code TEXT,
  message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_scan_leases (
  site TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  command TEXT NOT NULL,
  plan_id INTEGER,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_refresh_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  result TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  attempt_number INTEGER NOT NULL,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_job_observations_batch ON job_observations(batch_id, job_id);
CREATE INDEX IF NOT EXISTS idx_candidate_job_states_profile ON candidate_job_states(profile_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_candidate_job_events_profile_job ON candidate_job_events(profile_id, job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_profile_versions_profile ON profile_versions(profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_candidate_facts_profile ON candidate_facts(profile_id, fact_key);
CREATE INDEX IF NOT EXISTS idx_resume_parse_attempts_profile ON resume_parse_attempts(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_candidate_resume_versions_profile ON candidate_resume_versions(profile_id, is_active, updated_at);
CREATE INDEX IF NOT EXISTS idx_platform_filter_catalogs_updated ON platform_filter_catalogs(updated_at);
CREATE INDEX IF NOT EXISTS idx_scan_target_results_batch ON scan_target_results(batch_id, target_key, attempt_number);
CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_job_refresh_attempts_job ON job_refresh_attempts(job_id, created_at);
${COMMUNICATION_SCHEMA}
${WORKFLOW_SCHEMA}
${PLATFORM_SEARCH_CONTEXT_SCHEMA}
`;

}

const MATCHING_CARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidate_matching_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  profile_version_id INTEGER NOT NULL,
  resume_document_id INTEGER,
  resume_content_hash TEXT NOT NULL,
  card_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed', 'superseded')),
  source TEXT NOT NULL CHECK(source IN ('model', 'user', 'migration')),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(profile_version_id) REFERENCES profile_versions(id),
  FOREIGN KEY(resume_document_id) REFERENCES resume_documents(id)
);
CREATE INDEX IF NOT EXISTS idx_matching_cards_active
  ON candidate_matching_cards(profile_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_matching_cards_resume_hash
  ON candidate_matching_cards(profile_id, resume_content_hash, status);
`;

const CANDIDATE_PROGRESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidate_progress_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  recruiter_name TEXT NOT NULL DEFAULT '',
  thread_key TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  next_action TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT,
  last_event_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, job_id),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);
CREATE TABLE IF NOT EXISTS candidate_progress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_progress_cards_plan
  ON candidate_progress_cards(plan_id, stage, updated_at);
CREATE INDEX IF NOT EXISTS idx_candidate_progress_events_card
  ON candidate_progress_events(card_id, occurred_at);
`;

const MESSAGE_PREVIEW_STATES_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_preview_states (
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  preview_kind TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, platform, conversation_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);
`;

const MESSAGE_DISCOVERY_UNRESOLVED_ITEMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_discovery_unresolved_items (
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  preview_kind TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  position_title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  salary TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  identity_digest TEXT NOT NULL DEFAULT '',
  inbound_json TEXT NOT NULL DEFAULT '[]',
  source_job_id TEXT NOT NULL DEFAULT '',
  last_message_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(profile_id, platform, conversation_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);
`;

const MESSAGE_DISCOVERY_RUNTIME_STATES_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_discovery_runtime_states (
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  pacing_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, platform),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);
`;

const SHARED_SITE_PACING_STATES_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_discovery_runtime_states (
  platform TEXT PRIMARY KEY,
  pacing_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
`;

const ONBOARDING_RUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS onboarding_runs (
  id TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL,
  resume_document_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
  stage TEXT NOT NULL CHECK(stage IN (
    'parsed','analyzing_profile','building_match_card','building_plan','ready'
  )),
  progress_revision INTEGER NOT NULL DEFAULT 0 CHECK(progress_revision >= 0),
  profile_version_id INTEGER,
  matching_card_id INTEGER,
  search_plan_id INTEGER,
  error_code TEXT,
  error_message TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(profile_id, resume_document_id),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(resume_document_id) REFERENCES resume_documents(id),
  FOREIGN KEY(profile_version_id) REFERENCES profile_versions(id) ON DELETE SET NULL,
  FOREIGN KEY(matching_card_id) REFERENCES candidate_matching_cards(id) ON DELETE SET NULL,
  FOREIGN KEY(search_plan_id) REFERENCES search_plans(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_onboarding_runs_status
  ON onboarding_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_onboarding_runs_profile
  ON onboarding_runs(profile_id, created_at);
`;

const MESSAGE_REPLY_LEARNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_reply_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  message_group_key TEXT NOT NULL,
  draft_index INTEGER NOT NULL CHECK(draft_index IN (0, 1)),
  question_summary TEXT NOT NULL DEFAULT '',
  message_intent TEXT NOT NULL DEFAULT '',
  message_category TEXT NOT NULL DEFAULT '',
  original_text TEXT NOT NULL,
  current_text TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, message_group_key, draft_index),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_message_reply_drafts_open
  ON message_reply_drafts(profile_id, closed_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_message_reply_drafts_card
  ON message_reply_drafts(profile_id, card_id, draft_index);

CREATE TABLE IF NOT EXISTS candidate_answer_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  draft_id INTEGER NOT NULL,
  final_digest TEXT NOT NULL,
  question_summary TEXT NOT NULL DEFAULT '',
  message_intent TEXT NOT NULL DEFAULT '',
  message_category TEXT NOT NULL DEFAULT '',
  original_text TEXT NOT NULL,
  final_text TEXT NOT NULL,
  changed_text TEXT NOT NULL DEFAULT '',
  scope_json TEXT NOT NULL DEFAULT '{"kind":"global","key":""}',
  source TEXT NOT NULL CHECK(source IN ('draft_adopted', 'user_edited_reply')),
  completion_kind TEXT NOT NULL CHECK(completion_kind IN ('copied', 'sent', 'profile_edit')),
  supersedes_memory_id INTEGER,
  withdrawn_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(draft_id, final_digest),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(draft_id) REFERENCES message_reply_drafts(id),
  FOREIGN KEY(supersedes_memory_id) REFERENCES candidate_answer_memories(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_answer_memories_active
  ON candidate_answer_memories(profile_id, source, withdrawn_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_candidate_answer_memories_draft
  ON candidate_answer_memories(draft_id, withdrawn_at, created_at);

CREATE TABLE IF NOT EXISTS candidate_fact_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL CHECK(operation IN ('set', 'delete')),
  source TEXT NOT NULL,
  answer_memory_id INTEGER,
  evidence_text TEXT NOT NULL DEFAULT '',
  withdrawn_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(answer_memory_id) REFERENCES candidate_answer_memories(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_fact_revisions_key
  ON candidate_fact_revisions(profile_id, fact_key, created_at, id);
CREATE INDEX IF NOT EXISTS idx_candidate_fact_revisions_memory
  ON candidate_fact_revisions(answer_memory_id, fact_key);
`;

const MESSAGE_REPLY_SENDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_inbound_contexts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  message_group_key TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  message_intent TEXT NOT NULL,
  message_category TEXT NOT NULL,
  display_json TEXT NOT NULL,
  manual_actions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, card_id, message_group_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id)
);
CREATE INDEX IF NOT EXISTS idx_message_inbound_contexts_profile
  ON message_inbound_contexts(profile_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS message_reply_send_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('confirmed','running','completed','stopped','interrupted')),
  stop_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);
CREATE INDEX IF NOT EXISTS idx_message_reply_send_batches_profile
  ON message_reply_send_batches(profile_id, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS message_reply_send_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  platform TEXT NOT NULL DEFAULT 'boss' CHECK(platform IN ('boss','zhaopin')),
  position INTEGER NOT NULL,
  draft_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  conversation_key TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  expected_last_message_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  reply_text TEXT NOT NULL,
  reply_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','selecting','verified','filled','click_dispatched','succeeded','target_mismatch','platform_rejected','ambiguous','stopped')),
  click_count INTEGER NOT NULL DEFAULT 0 CHECK(click_count IN (0,1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, position),
  UNIQUE(batch_id, draft_id),
  FOREIGN KEY(batch_id) REFERENCES message_reply_send_batches(id),
  FOREIGN KEY(draft_id) REFERENCES message_reply_drafts(id),
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_message_reply_send_items_batch
  ON message_reply_send_items(batch_id, position, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reply_send_items_open_draft
  ON message_reply_send_items(draft_id)
  WHERE status IN ('pending','selecting','verified','filled','click_dispatched','ambiguous');
`;

const JOB_SEARCH_FUNNEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidate_funnel_policies (
  profile_id INTEGER PRIMARY KEY,
  preliminary_sample_target INTEGER NOT NULL CHECK(preliminary_sample_target BETWEEN 10 AND 500),
  comparable_sample_target INTEGER NOT NULL CHECK(comparable_sample_target BETWEEN 10 AND 500),
  formal_sample_target INTEGER NOT NULL CHECK(formal_sample_target BETWEEN 10 AND 500),
  updated_at TEXT NOT NULL,
  CHECK(preliminary_sample_target < comparable_sample_target),
  CHECK(comparable_sample_target < formal_sample_target),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);

CREATE TABLE IF NOT EXISTS candidate_funnel_cohorts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  preliminary_sample_target INTEGER NOT NULL CHECK(preliminary_sample_target BETWEEN 10 AND 500),
  comparable_sample_target INTEGER NOT NULL CHECK(comparable_sample_target BETWEEN 10 AND 500),
  formal_sample_target INTEGER NOT NULL CHECK(formal_sample_target BETWEEN 10 AND 500),
  sample_count INTEGER NOT NULL CHECK(sample_count > 0),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(preliminary_sample_target < comparable_sample_target),
  CHECK(comparable_sample_target < formal_sample_target),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_funnel_cohorts_profile
  ON candidate_funnel_cohorts(profile_id, frozen_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS candidate_funnel_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  card_id INTEGER,
  cohort_id INTEGER,
  plan_id INTEGER,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('applied', 'communication', 'reply_sent')),
  started_at TEXT NOT NULL,
  mature_at TEXT NOT NULL,
  direction_key TEXT NOT NULL DEFAULT '',
  decision_bucket TEXT NOT NULL DEFAULT '',
  resume_version_id INTEGER,
  greeting_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, job_id),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id),
  FOREIGN KEY(cohort_id) REFERENCES candidate_funnel_cohorts(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id),
  FOREIGN KEY(resume_version_id) REFERENCES candidate_resume_versions(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_funnel_entries_pool
  ON candidate_funnel_entries(profile_id, cohort_id, mature_at, id);
CREATE INDEX IF NOT EXISTS idx_candidate_funnel_entries_cohort
  ON candidate_funnel_entries(cohort_id, started_at, id);
`;

const FUNNEL_STRATEGY_ROUNDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidate_funnel_strategy_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  sequence_number INTEGER NOT NULL CHECK(sequence_number > 0),
  status TEXT NOT NULL CHECK(status IN ('active','closed')),
  source_key TEXT NOT NULL,
  strategy_snapshot_json TEXT NOT NULL DEFAULT '{}',
  change_kinds_json TEXT NOT NULL DEFAULT '[]',
  change_note TEXT NOT NULL DEFAULT '',
  resume_version_id INTEGER,
  preliminary_sample_target INTEGER NOT NULL,
  comparable_sample_target INTEGER NOT NULL,
  formal_sample_target INTEGER NOT NULL,
  legacy_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(legacy_uncertain IN (0,1)),
  started_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, plan_id, sequence_number),
  UNIQUE(profile_id, plan_id, source_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id),
  FOREIGN KEY(resume_version_id) REFERENCES candidate_resume_versions(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_strategy_round_active
  ON candidate_funnel_strategy_rounds(profile_id, plan_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_funnel_strategy_round_history
  ON candidate_funnel_strategy_rounds(profile_id, plan_id, sequence_number DESC, id DESC);
`;

const RESUME_OPTIMIZATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS resume_optimizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  plan_id INTEGER,
  source_resume_version_id INTEGER NOT NULL,
  source_resume_document_id INTEGER NOT NULL,
  source_content_hash TEXT NOT NULL,
  source_text TEXT NOT NULL,
  target_direction TEXT NOT NULL DEFAULT '',
  target_job_ids_json TEXT NOT NULL DEFAULT '[]',
  context_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  headline TEXT NOT NULL DEFAULT '',
  suggestions_json TEXT NOT NULL DEFAULT '[]',
  generated_text TEXT NOT NULL DEFAULT '',
  final_text TEXT NOT NULL DEFAULT '',
  draft_format TEXT NOT NULL DEFAULT 'legacy_suggestions',
  user_edited_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft', 'activated')),
  result_resume_document_id INTEGER,
  result_resume_version_id INTEGER,
  model_identity_json TEXT NOT NULL DEFAULT '{}',
  strategy_round_id INTEGER,
  activated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id),
  FOREIGN KEY(source_resume_version_id) REFERENCES candidate_resume_versions(id),
  FOREIGN KEY(source_resume_document_id) REFERENCES resume_documents(id),
  FOREIGN KEY(result_resume_document_id) REFERENCES resume_documents(id),
  FOREIGN KEY(result_resume_version_id) REFERENCES candidate_resume_versions(id),
  FOREIGN KEY(strategy_round_id) REFERENCES candidate_funnel_strategy_rounds(id)
);
CREATE INDEX IF NOT EXISTS idx_resume_optimizations_profile
  ON resume_optimizations(profile_id, status, updated_at DESC, id DESC);
`;

const MOCK_INTERVIEW_V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS mock_interview_sessions (
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
CREATE INDEX IF NOT EXISTS idx_mock_interview_sessions_profile
  ON mock_interview_sessions(profile_id, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS mock_interview_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  turn_number INTEGER NOT NULL CHECK(turn_number > 0),
  question_text TEXT NOT NULL,
  question_focus TEXT NOT NULL,
  resume_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  based_on_turn_number INTEGER,
  answer_evidence TEXT NOT NULL DEFAULT '',
  answer_text TEXT NOT NULL DEFAULT '',
  answer_review_json TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, turn_number),
  FOREIGN KEY(session_id) REFERENCES mock_interview_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_mock_interview_turns_session
  ON mock_interview_turns(session_id, turn_number, id);

CREATE TABLE IF NOT EXISTS mock_interview_retries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  turn_id INTEGER NOT NULL,
  retry_index INTEGER NOT NULL CHECK(retry_index > 0),
  answer_text TEXT NOT NULL,
  review_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, turn_id, retry_index),
  FOREIGN KEY(session_id) REFERENCES mock_interview_sessions(id),
  FOREIGN KEY(turn_id) REFERENCES mock_interview_turns(id)
);
CREATE INDEX IF NOT EXISTS idx_mock_interview_retries_turn
  ON mock_interview_retries(session_id, turn_id, retry_index, id);
`;

const MESSAGE_INBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_inbox_items (
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('boss','zhaopin')),
  conversation_key TEXT NOT NULL,
  source_job_id TEXT NOT NULL DEFAULT '',
  job_id INTEGER,
  card_id INTEGER,
  last_message_id TEXT NOT NULL DEFAULT '',
  last_activity_at TEXT NOT NULL,
  last_direction TEXT NOT NULL CHECK(last_direction IN ('friend','myself','platform','unknown')),
  unread INTEGER NOT NULL DEFAULT 0 CHECK(unread IN (0,1)),
  position_title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  latest_excerpt TEXT NOT NULL DEFAULT '',
  action_group TEXT NOT NULL CHECK(action_group IN ('needs_action','waiting','needs_review','done')),
  action_code TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL DEFAULT '',
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(profile_id, platform, conversation_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  FOREIGN KEY(card_id) REFERENCES candidate_progress_cards(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_message_inbox_items_action
  ON message_inbox_items(profile_id, action_group, last_activity_at DESC, conversation_key);

CREATE TABLE IF NOT EXISTS message_inbox_sync_states (
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('boss','zhaopin')),
  last_attempted_at TEXT NOT NULL,
  last_successful_at TEXT,
  coverage_start_at TEXT,
  coverage_complete INTEGER NOT NULL DEFAULT 0 CHECK(coverage_complete IN (0,1)),
  watermark_at TEXT,
  stop_code TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(profile_id, platform),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id) ON DELETE CASCADE
);
`;

const MESSAGE_TIMELINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('boss','zhaopin')),
  conversation_key TEXT NOT NULL,
  message_key TEXT NOT NULL,
  platform_message_id TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK(direction IN ('friend','myself','platform','unknown')),
  kind TEXT NOT NULL CHECK(kind IN (
    'text','platform_notice','resume_request','interview_invitation',
    'contact_exchange','media_ignored','unknown_card'
  )),
  text TEXT NOT NULL DEFAULT '',
  occurred_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  UNIQUE(profile_id, platform, conversation_key, message_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_message_events_timeline
  ON message_events(profile_id, platform, conversation_key, occurred_at, id);
`;

module.exports = {
  buildSchema,
  MATCHING_CARD_SCHEMA,
  CANDIDATE_PROGRESS_SCHEMA,
  MESSAGE_PREVIEW_STATES_SCHEMA,
  MESSAGE_DISCOVERY_UNRESOLVED_ITEMS_SCHEMA,
  MESSAGE_DISCOVERY_RUNTIME_STATES_SCHEMA,
  MESSAGE_INBOX_SCHEMA,
  MESSAGE_TIMELINE_SCHEMA,
  SHARED_SITE_PACING_STATES_SCHEMA,
  ONBOARDING_RUN_SCHEMA,
  MESSAGE_REPLY_LEARNING_SCHEMA,
  MESSAGE_REPLY_SENDING_SCHEMA,
  JOB_SEARCH_FUNNEL_SCHEMA,
  FUNNEL_STRATEGY_ROUNDS_SCHEMA,
  RESUME_OPTIMIZATION_SCHEMA,
  MOCK_INTERVIEW_V1_SCHEMA
};
