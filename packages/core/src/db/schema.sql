-- LifeOS Inbox — spine schema.
--
-- Week 1 runs against the JSONL store in `store.ts`; this is the shape that
-- store mirrors and the target for the Drizzle migration when a database is
-- actually needed. Three properties are load-bearing and must survive that
-- move:
--
--   1. raw_events is immutable and uniquely keyed, so any re-poll is a no-op.
--   2. classifications is append-only, so a re-run can never overwrite a
--      human correction.
--   3. every extraction stores the verbatim source span that proves it.
--
-- user_id is on every table from day one. It costs nothing now and is brutal
-- to retrofit; it is the whole of what "SaaS-ready" requires at this stage.

CREATE TABLE users (
  id          text PRIMARY KEY,
  email       text UNIQUE NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Kolkata',
  brief_hour  int  NOT NULL DEFAULT 7,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE source_kind   AS ENUM ('gmail', 'manual', 'upload');
CREATE TYPE source_status AS ENUM ('active', 'auth_expired', 'disabled');

CREATE TABLE source_accounts (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           source_kind   NOT NULL,
  identifier     text NOT NULL,
  -- AES-256-GCM at rest. A leaked refresh token is ongoing mailbox access.
  auth_token_enc bytea,
  status         source_status NOT NULL DEFAULT 'active',
  sync_cursor    text,
  last_sync_at   timestamptz,
  last_error     text,
  UNIQUE (user_id, kind, identifier)
);

-- The replay log. Never updated, never deleted: improving the classifier and
-- re-running history has to be a routine batch job, not a migration.
CREATE TABLE raw_events (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_account_id text NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  dedup_key         text NOT NULL,
  payload           jsonb NOT NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_account_id, dedup_key)   -- the idempotency anchor
);

CREATE TYPE signal_kind  AS ENUM ('email', 'manual_note', 'statement_row');
CREATE TYPE signal_state AS ENUM (
  'new', 'triaged', 'action_pending', 'waiting', 'snoozed', 'done', 'ignored', 'archived'
);
CREATE TYPE category AS ENUM (
  'bill', 'transaction', 'renewal', 'investment', 'support', 'bounce',
  'dev', 'career', 'security', 'promo', 'personal', 'other'
);
CREATE TYPE urgency    AS ENUM ('now', 'today', 'this_week', 'someday', 'none');
CREATE TYPE action     AS ENUM (
  'reply', 'pay', 'decide', 'follow_up', 'wait', 'convert_task', 'archive', 'needs_review'
);
CREATE TYPE confidence AS ENUM ('high', 'medium', 'low');
CREATE TYPE method     AS ENUM ('rule', 'llm', 'user');

CREATE TABLE signals (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  raw_event_id  text NOT NULL UNIQUE REFERENCES raw_events(id) ON DELETE CASCADE,
  kind          signal_kind NOT NULL,
  external_id   text NOT NULL,
  thread_key    text,
  sender_name   text,
  sender_addr   text NOT NULL,
  sender_domain text NOT NULL,
  title         text NOT NULL,
  snippet       text,
  body_ref      text,
  occurred_at   timestamptz NOT NULL,
  state         signal_state NOT NULL DEFAULT 'new',
  snoozed_until timestamptz,
  -- Denormalised effective classification, recomputed on every write below.
  -- Dashboard reads are plain indexed queries; no pipeline work at request time.
  eff_category  category,
  eff_urgency   urgency,
  eff_action    action
);
CREATE INDEX signals_triage_idx  ON signals (user_id, state, eff_urgency);
CREATE INDEX signals_thread_idx  ON signals (user_id, thread_key);
CREATE INDEX signals_sender_idx  ON signals (user_id, sender_domain);

-- APPEND ONLY. Effective value = latest row with method='user' if any exists,
-- else the latest automated row with the highest classifier_version. A model
-- can never silently undo a human decision.
CREATE TABLE classifications (
  id                 bigserial PRIMARY KEY,
  user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_id          text NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  method             method NOT NULL,
  category           category NOT NULL,
  urgency            urgency NOT NULL,
  action             action NOT NULL,
  confidence         confidence,
  classifier_version text NOT NULL,
  rule_ids           text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX classifications_signal_idx ON classifications (signal_id, created_at DESC);

CREATE TYPE extract_kind AS ENUM (
  'amount', 'min_due', 'due_date', 'card_last4', 'merchant',
  'ticket_id', 'vpa', 'dead_address'
);

CREATE TABLE extractions (
  id                bigserial PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_id         text NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  kind              extract_kind NOT NULL,
  value_text        text,
  value_date        date,
  value_num         numeric(14,2),
  currency          text DEFAULT 'INR',
  -- Verbatim source span plus offset. If this string is not present in the
  -- source text the extraction is rejected upstream and never reaches here.
  evidence          text NOT NULL,
  evidence_offset   int  NOT NULL,
  method            method NOT NULL,
  extractor_version text NOT NULL
);
CREATE INDEX extractions_signal_idx ON extractions (signal_id);

CREATE TYPE obligation_kind   AS ENUM ('bill', 'renewal', 'deadline');
CREATE TYPE obligation_status AS ENUM (
  'predicted', 'upcoming', 'due_soon', 'paid', 'overdue', 'closed'
);
CREATE TYPE renewal_decision AS ENUM ('keep', 'cancel', 'undecided');
CREATE TYPE service_status   AS ENUM ('ok', 'payment_failed', 'suspended');

-- One table for bills, renewals and deadlines: same shape, different verb.
CREATE TABLE obligations (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           obligation_kind NOT NULL,
  counterparty   text NOT NULL,
  label          text NOT NULL,
  amount         numeric(14,2),
  currency       text NOT NULL DEFAULT 'INR',
  due_date       date,
  status         obligation_status NOT NULL DEFAULT 'upcoming',
  card_last4     text,
  decision       renewal_decision,   -- renewals only
  service_status service_status,     -- renewals only
  paid_at        timestamptz,
  -- Fields the user edited by hand; enrichment must skip these on re-run.
  fields_locked  text[] NOT NULL DEFAULT '{}',
  source_parser  text,
  UNIQUE (user_id, kind, counterparty, due_date)
);
CREATE INDEX obligations_due_idx ON obligations (user_id, status, due_date);

-- Lineage: which signals support this obligation. Three mails about one bill
-- collapse into one row plus three pieces of evidence, not three todos.
CREATE TABLE obligation_evidence (
  obligation_id text NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
  signal_id     text NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  PRIMARY KEY (obligation_id, signal_id)
);

CREATE TYPE follow_direction AS ENUM ('waiting_on_them', 'i_owe_reply');
CREATE TYPE follow_state     AS ENUM ('open', 'nudged', 'escalated', 'dead_channel', 'closed');

CREATE TABLE follow_ups (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_key       text NOT NULL,
  direction        follow_direction NOT NULL,
  counterparty     text NOT NULL,
  ticket_id        text,
  last_outbound_at timestamptz,
  expect_reply_by  timestamptz,
  follow_up_count  int NOT NULL DEFAULT 0,
  state            follow_state NOT NULL DEFAULT 'open',
  UNIQUE (user_id, thread_key, direction)
);
CREATE INDEX follow_ups_open_idx ON follow_ups (user_id, state, expect_reply_by);

-- Bounces, aggregated per dead address. Gmail showed him five of these one at
-- a time and he missed every one; persistence and a count is the feature.
CREATE TABLE dead_channels (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address       text NOT NULL,
  bounce_count  int NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  acknowledged  boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, address)
);

CREATE TYPE rule_origin AS ENUM ('seed', 'promoted', 'manual');

-- Learned rules. Three consistent corrections promote an LLM decision into a
-- deterministic rule, so the model's share of the pipeline shrinks every week.
CREATE TABLE rules (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  matcher     jsonb NOT NULL,
  outcome     jsonb NOT NULL,
  origin      rule_origin NOT NULL,
  priority    int NOT NULL DEFAULT 50,
  hits_30d    int NOT NULL DEFAULT 0,
  last_fired  timestamptz,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Every model decision, inspectable. Debugging tool, regression dataset and
-- correction-rate dashboard in one; retrofitting auditability is miserable.
CREATE TABLE ai_audit (
  id             bigserial PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_id      text REFERENCES signals(id) ON DELETE SET NULL,
  tier           int NOT NULL,
  model          text NOT NULL,
  prompt_version text NOT NULL,
  redacted_input text,
  raw_output     jsonb,
  parsed_output  jsonb,
  confidence     confidence,
  latency_ms     int,
  tokens_in      int,
  tokens_out     int,
  cost_usd       numeric(10,6),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_audit_signal_idx ON ai_audit (signal_id, created_at DESC);
