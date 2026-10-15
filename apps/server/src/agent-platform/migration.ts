import type { DatabaseMigration } from "../database.js";

/**
 * v20: Agent Platform domain tables (docs/agent-platform-v0/ARCHITECTURE.md §2). Additive only; no
 * existing Project, Pane or Session row changes. Verbatim text lives only in agent_instructions and
 * handoff resolutions (AP-D002); events carry references and enums.
 */
export const AGENT_PLATFORM_MIGRATION: DatabaseMigration = {
  version: 20,
  migrate(database) {
    database.exec(`
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (
          role IN ('main-orchestrator', 'project-orchestrator', 'worker', 'reviewer', 'specialist')
        ),
        runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'claude', 'opencode')),
        runtime_session_ref TEXT,
        parent_agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        native INTEGER NOT NULL CHECK (native IN (0, 1)),
        observation TEXT NOT NULL CHECK (observation IN ('none', 'lifecycle', 'transcript', 'pty')),
        conversation_writer TEXT NOT NULL CHECK (
          conversation_writer IN ('none', 'gui', 'tui', 'orchestrator')
        ),
        human_hold_since TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('starting', 'active', 'idle', 'stopped', 'failed', 'unknown')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (role = 'main-orchestrator' OR project_id IS NOT NULL)
      );

      CREATE TABLE agent_instructions (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'task', 'agent')),
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES agent_tasks(id) ON DELETE CASCADE,
        agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
        author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent', 'system')),
        author_agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        channel TEXT NOT NULL CHECK (channel IN ('naru-ui', 'tui', 'mcp', 'native-message')),
        origin_user_instruction_id TEXT REFERENCES agent_instructions(id),
        supersedes_id TEXT REFERENCES agent_instructions(id),
        verbatim TEXT,
        forgotten_at TEXT,
        created_at TEXT NOT NULL,
        CHECK ((verbatim IS NULL) = (forgotten_at IS NOT NULL)),
        CHECK (author_kind <> 'agent' OR origin_user_instruction_id IS NOT NULL),
        CHECK (scope_kind <> 'global' OR project_id IS NULL),
        CHECK (scope_kind NOT IN ('project', 'task') OR project_id IS NOT NULL),
        CHECK ((scope_kind = 'task') = (task_id IS NOT NULL)),
        CHECK ((scope_kind = 'agent') = (agent_session_id IS NOT NULL))
      );
      CREATE INDEX agent_instructions_scope
        ON agent_instructions(project_id, scope_kind, created_at);

      CREATE TABLE agent_intent_contracts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'superseded')),
        body_json TEXT NOT NULL,
        source_instruction_id TEXT NOT NULL REFERENCES agent_instructions(id),
        approved_by_handoff_id TEXT REFERENCES agent_handoffs(id),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, version)
      );
      CREATE UNIQUE INDEX agent_intent_contracts_one_approved
        ON agent_intent_contracts(project_id) WHERE status = 'approved';

      CREATE TABLE agent_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
        owner_agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        summary TEXT NOT NULL,
        intent_contract_id TEXT REFERENCES agent_intent_contracts(id),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, version)
      );
      CREATE UNIQUE INDEX agent_plans_one_active ON agent_plans(project_id) WHERE status = 'active';

      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        plan_id TEXT REFERENCES agent_plans(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        purpose TEXT NOT NULL,
        completion_criteria_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'ready', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled')
        ),
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 1000),
        assignee_agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        origin_instruction_id TEXT NOT NULL REFERENCES agent_instructions(id),
        intent_contract_id TEXT REFERENCES agent_intent_contracts(id),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX agent_tasks_project ON agent_tasks(project_id, status);

      CREATE TABLE agent_task_dependencies (
        task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_task_id),
        CHECK (task_id <> depends_on_task_id)
      );

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'claude', 'opencode')),
        model TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('starting', 'running', 'succeeded', 'failed', 'cancelled', 'unknown')
        ),
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        error_class TEXT,
        summary TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (task_id, attempt)
      );

      CREATE TABLE agent_handoffs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (
          kind IN (
            'design-deviation', 'product-decision', 'manual-test', 'terminal-control',
            'security-or-external'
          )
        ),
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'cancelled')),
        requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('human', 'agent', 'system')),
        requested_by_agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL,
        resolution_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK ((status = 'resolved') = (resolution_json IS NOT NULL)),
        CHECK ((status = 'open') = (resolved_at IS NULL))
      );
      CREATE INDEX agent_handoffs_open ON agent_handoffs(project_id, status);

      CREATE TABLE agent_reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        reviewer_agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('correctness', 'intent')),
        verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'needs-changes', 'fail')),
        findings TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE agent_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (
          kind IN ('commit', 'branch', 'file', 'test-result', 'document', 'url', 'report')
        ),
        reference TEXT NOT NULL,
        summary TEXT,
        exit_code INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE agent_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
        actor_agent_session_id TEXT,
        subject_id TEXT NOT NULL,
        correlation_id TEXT,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX agent_events_project ON agent_events(project_id, seq);

      CREATE TABLE agent_event_cursors (
        consumer_id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL CHECK (last_seq >= 0)
      );

      CREATE TABLE agent_capabilities (
        digest TEXT PRIMARY KEY,
        agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX agent_capabilities_session ON agent_capabilities(agent_session_id);

      CREATE TABLE agent_native_messages (
        instruction_id TEXT PRIMARY KEY REFERENCES agent_instructions(id) ON DELETE CASCADE,
        sender_agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        recipient_agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        body_digest TEXT NOT NULL,
        sender_pids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('authorized', 'delivered')),
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX agent_native_messages_pending
        ON agent_native_messages(recipient_agent_session_id, status);

      CREATE TABLE agent_commands (
        actor_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result_type TEXT NOT NULL,
        result_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (actor_key, idempotency_key)
      );
    `);
  },
};
