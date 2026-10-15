import type Database from "better-sqlite3";
import {
  type Actor,
  type AgentEvent,
  type AgentEventType,
  type AgentSession,
  type AgentTask,
  type AgentWorktree,
  type Artifact,
  type Handoff,
  type Instruction,
  type InstructionScope,
  type IntentContract,
  type Plan,
  type Review,
  type Run,
  type SharedProcess,
  HandoffPayloadSchema,
  HandoffResolutionSchema,
  IntentContractBodySchema,
} from "@naru/contracts/naru-agent/v1";
import { z } from "zod";

/** SQL mapping for the v20 Agent Platform tables. Policy lives in AgentPlatformCore. */
export class AgentPlatformStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  transaction<T>(work: () => T): T {
    return this.#database.transaction(work)();
  }

  projectExists(projectId: string): boolean {
    return (
      this.#database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId) !== undefined
    );
  }

  // Instructions ---------------------------------------------------------------------------------

  insertInstruction(instruction: Instruction): void {
    const scope = scopeColumns(instruction.scope);
    this.#database
      .prepare(
        `INSERT INTO agent_instructions (
           id, scope_kind, project_id, task_id, agent_session_id, author_kind,
           author_agent_session_id, channel, origin_user_instruction_id, supersedes_id, verbatim,
           forgotten_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        instruction.id,
        scope.kind,
        scope.projectId,
        scope.taskId,
        scope.agentSessionId,
        instruction.author.kind,
        instruction.author.kind === "agent" ? instruction.author.agentSessionId : null,
        instruction.channel,
        instruction.originUserInstructionId,
        instruction.supersedesId,
        instruction.verbatim,
        instruction.createdAt,
      );
  }

  getInstruction(id: string): Instruction | null {
    const row = this.#database.prepare("SELECT * FROM agent_instructions WHERE id = ?").get(id) as
      InstructionRow | undefined;
    return row === undefined ? null : instructionFromRow(row);
  }

  /**
   * Human instructions that apply to a project, task or agent, oldest first, excluding ones that a
   * later instruction superseded. Global instructions always apply.
   */
  listApplicableHumanInstructions(target: {
    readonly projectId: string | null;
    readonly taskId: string | null;
    readonly agentSessionId: string | null;
  }): Instruction[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM agent_instructions AS i
         WHERE i.author_kind = 'human'
           AND (
             i.scope_kind = 'global'
             OR (i.scope_kind = 'project' AND i.project_id = @projectId)
             OR (i.scope_kind = 'task' AND i.task_id = @taskId)
             OR (i.scope_kind = 'agent' AND i.agent_session_id = @agentSessionId)
           )
           AND NOT EXISTS (
             SELECT 1 FROM agent_instructions AS later WHERE later.supersedes_id = i.id
           )
         ORDER BY i.created_at, i.rowid`,
      )
      .all(target) as InstructionRow[];
    return rows.map(instructionFromRow);
  }

  /** Instructions addressed to an agent or its tasks, by anyone, still in force (oldest first). */
  listAddressedInstructions(agentSessionId: string, limit: number): Instruction[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT i.*, i.rowid AS position FROM agent_instructions AS i
           WHERE (
               (i.scope_kind = 'agent' AND i.agent_session_id = @agentSessionId)
               OR (i.scope_kind = 'task' AND i.task_id IN (
                 SELECT id FROM agent_tasks WHERE assignee_agent_session_id = @agentSessionId
               ))
             )
             AND NOT EXISTS (
               SELECT 1 FROM agent_instructions AS later WHERE later.supersedes_id = i.id
             )
           ORDER BY i.created_at DESC, i.rowid DESC
           LIMIT @limit
         ) ORDER BY created_at, position`,
      )
      .all({ agentSessionId, limit }) as InstructionRow[];
    return rows.map(instructionFromRow);
  }

  forgetInstruction(id: string, forgottenAt: string): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE agent_instructions SET verbatim = NULL, forgotten_at = ?
           WHERE id = ? AND forgotten_at IS NULL`,
        )
        .run(forgottenAt, id).changes === 1
    );
  }

  // Intent contracts and plans -------------------------------------------------------------------

  nextIntentContractVersion(projectId: string): number {
    return nextVersion(this.#database, "agent_intent_contracts", projectId);
  }

  insertIntentContract(contract: IntentContract): void {
    this.#database
      .prepare(
        `INSERT INTO agent_intent_contracts (
           id, project_id, version, status, body_json, source_instruction_id,
           approved_by_handoff_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        contract.id,
        contract.projectId,
        contract.version,
        contract.status,
        JSON.stringify(contract.body),
        contract.sourceInstructionId,
        contract.approvedByHandoffId,
        contract.createdAt,
      );
  }

  getIntentContract(id: string): IntentContract | null {
    const row = this.#database
      .prepare("SELECT * FROM agent_intent_contracts WHERE id = ?")
      .get(id) as IntentContractRow | undefined;
    return row === undefined ? null : intentContractFromRow(row);
  }

  getApprovedIntentContract(projectId: string): IntentContract | null {
    const row = this.#database
      .prepare("SELECT * FROM agent_intent_contracts WHERE project_id = ? AND status = 'approved'")
      .get(projectId) as IntentContractRow | undefined;
    return row === undefined ? null : intentContractFromRow(row);
  }

  /** The newest proposal after the approved version: what still waits for the user. */
  getPendingIntentContract(projectId: string): IntentContract | null {
    const row = this.#database
      .prepare(
        `SELECT * FROM agent_intent_contracts
         WHERE project_id = ? AND status = 'proposed' AND version > COALESCE(
           (SELECT MAX(version) FROM agent_intent_contracts
            WHERE project_id = ? AND status = 'approved'), 0)
         ORDER BY version DESC LIMIT 1`,
      )
      .get(projectId, projectId) as IntentContractRow | undefined;
    return row === undefined ? null : intentContractFromRow(row);
  }

  approveIntentContract(id: string, projectId: string, handoffId: string | null): void {
    this.#database
      .prepare(
        `UPDATE agent_intent_contracts SET status = 'superseded'
         WHERE project_id = ? AND status = 'approved'`,
      )
      .run(projectId);
    this.#database
      .prepare(
        `UPDATE agent_intent_contracts SET status = 'approved', approved_by_handoff_id = ?
         WHERE id = ?`,
      )
      .run(handoffId, id);
  }

  nextPlanVersion(projectId: string): number {
    return nextVersion(this.#database, "agent_plans", projectId);
  }

  insertPlan(plan: Plan): void {
    if (plan.status === "active") {
      this.#database
        .prepare(
          "UPDATE agent_plans SET status = 'superseded' WHERE project_id = ? AND status = 'active'",
        )
        .run(plan.projectId);
    }
    this.#database
      .prepare(
        `INSERT INTO agent_plans (
           id, project_id, version, status, owner_agent_session_id, summary, intent_contract_id,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.projectId,
        plan.version,
        plan.status,
        plan.ownerAgentSessionId,
        plan.summary,
        plan.intentContractId,
        plan.createdAt,
      );
  }

  getActivePlan(projectId: string): Plan | null {
    const row = this.#database
      .prepare("SELECT * FROM agent_plans WHERE project_id = ? AND status = 'active'")
      .get(projectId) as PlanRow | undefined;
    return row === undefined ? null : planFromRow(row);
  }

  getPlan(id: string): Plan | null {
    const row = this.#database.prepare("SELECT * FROM agent_plans WHERE id = ?").get(id) as
      PlanRow | undefined;
    return row === undefined ? null : planFromRow(row);
  }

  // Tasks ----------------------------------------------------------------------------------------

  insertTask(task: AgentTask): void {
    this.#database
      .prepare(
        `INSERT INTO agent_tasks (
           id, project_id, plan_id, title, purpose, completion_criteria_json, status, priority,
           assignee_agent_session_id, origin_instruction_id, intent_contract_id, revision,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.projectId,
        task.planId,
        task.title,
        task.purpose,
        JSON.stringify(task.completionCriteria),
        task.status,
        task.priority,
        task.assigneeAgentSessionId,
        task.originInstructionId,
        task.intentContractId,
        task.revision,
        task.createdAt,
        task.updatedAt,
      );
    this.#replaceDependencies(task.id, task.dependsOn);
  }

  getTask(id: string): AgentTask | null {
    const row = this.#database.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(id) as
      TaskRow | undefined;
    return row === undefined ? null : this.#taskFromRow(row);
  }

  listTasks(projectId: string): AgentTask[] {
    const rows = this.#database
      .prepare("SELECT * FROM agent_tasks WHERE project_id = ? ORDER BY priority DESC, created_at")
      .all(projectId) as TaskRow[];
    return rows.map((row) => this.#taskFromRow(row));
  }

  /** Writes a whole task row only when the stored revision still matches. */
  updateTask(task: AgentTask, expectedRevision: number): boolean {
    const result = this.#database
      .prepare(
        `UPDATE agent_tasks SET
           plan_id = ?, title = ?, purpose = ?, completion_criteria_json = ?, status = ?,
           priority = ?, assignee_agent_session_id = ?, intent_contract_id = ?, revision = ?,
           updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        task.planId,
        task.title,
        task.purpose,
        JSON.stringify(task.completionCriteria),
        task.status,
        task.priority,
        task.assigneeAgentSessionId,
        task.intentContractId,
        task.revision,
        task.updatedAt,
        task.id,
        expectedRevision,
      );
    if (result.changes !== 1) return false;
    this.#replaceDependencies(task.id, task.dependsOn);
    return true;
  }

  /** Every task reachable through depends_on edges, starting from the given tasks. */
  dependencyClosure(taskIds: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const pending = [...taskIds];
    const next = this.#database.prepare(
      "SELECT depends_on_task_id FROM agent_task_dependencies WHERE task_id = ?",
    );
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const dependency of next.pluck().all(current) as string[]) pending.push(dependency);
    }
    return seen;
  }

  #replaceDependencies(taskId: string, dependsOn: readonly string[]): void {
    this.#database.prepare("DELETE FROM agent_task_dependencies WHERE task_id = ?").run(taskId);
    const insert = this.#database.prepare(
      "INSERT INTO agent_task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
    );
    for (const dependency of dependsOn) insert.run(taskId, dependency);
  }

  #taskFromRow(row: TaskRow): AgentTask {
    const dependsOn = this.#database
      .prepare(
        `SELECT depends_on_task_id FROM agent_task_dependencies WHERE task_id = ?
         ORDER BY depends_on_task_id`,
      )
      .pluck()
      .all(row.id) as string[];
    return {
      id: row.id,
      projectId: row.project_id,
      planId: row.plan_id,
      title: row.title,
      purpose: row.purpose,
      completionCriteria: StringListSchema.parse(JSON.parse(row.completion_criteria_json)),
      status: row.status,
      priority: row.priority,
      assigneeAgentSessionId: row.assignee_agent_session_id,
      originInstructionId: row.origin_instruction_id,
      intentContractId: row.intent_contract_id,
      dependsOn,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // Runs -----------------------------------------------------------------------------------------

  nextRunAttempt(taskId: string): number {
    const current = this.#database
      .prepare("SELECT COALESCE(MAX(attempt), 0) FROM agent_runs WHERE task_id = ?")
      .pluck()
      .get(taskId) as number;
    return current + 1;
  }

  insertRun(run: Run): void {
    this.#database
      .prepare(
        `INSERT INTO agent_runs (
           id, task_id, agent_session_id, runtime, model, status, attempt, error_class, summary,
           started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.agentSessionId,
        run.runtime,
        run.model,
        run.status,
        run.attempt,
        run.errorClass,
        run.summary,
        run.startedAt,
        run.finishedAt,
      );
  }

  getRun(id: string): Run | null {
    const row = this.#database.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as
      RunRow | undefined;
    return row === undefined ? null : runFromRow(row);
  }

  listRuns(taskId: string): Run[] {
    const rows = this.#database
      .prepare("SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at, rowid")
      .all(taskId) as RunRow[];
    return rows.map(runFromRow);
  }

  listRunsByStatus(statuses: readonly Run["status"][]): Run[] {
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(`SELECT * FROM agent_runs WHERE status IN (${placeholders}) ORDER BY started_at`)
      .all(...statuses) as RunRow[];
    return rows.map(runFromRow);
  }

  updateRun(run: Run): void {
    this.#database
      .prepare(
        `UPDATE agent_runs SET status = ?, error_class = ?, summary = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(run.status, run.errorClass, run.summary, run.finishedAt, run.id);
  }

  // Agent sessions -------------------------------------------------------------------------------

  insertAgentSession(session: AgentSession): void {
    this.#database
      .prepare(
        `INSERT INTO agent_sessions (
           id, project_id, role, runtime, runtime_session_ref, parent_agent_session_id, native,
           observation, conversation_writer, human_hold_since, status, pane_id, launch_mode,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.projectId,
        session.role,
        session.runtime,
        session.runtimeSessionRef,
        session.parentAgentSessionId,
        session.native ? 1 : 0,
        session.observation,
        session.conversationWriter,
        session.humanHoldSince,
        session.status,
        session.paneId,
        session.launchMode,
        session.createdAt,
        session.updatedAt,
      );
  }

  getAgentSession(id: string): AgentSession | null {
    const row = this.#database.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as
      AgentSessionRow | undefined;
    return row === undefined ? null : agentSessionFromRow(row);
  }

  /** Sessions of one project, or the global ones when projectId is null. */
  listAgentSessions(projectId: string | null): AgentSession[] {
    const rows = (
      projectId === null
        ? this.#database
            .prepare("SELECT * FROM agent_sessions WHERE project_id IS NULL ORDER BY created_at")
            .all()
        : this.#database
            .prepare("SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY created_at")
            .all(projectId)
    ) as AgentSessionRow[];
    return rows.map(agentSessionFromRow);
  }

  listAgentProjectIds(): string[] {
    return this.#database
      .prepare(
        `SELECT project_id FROM agent_sessions WHERE project_id IS NOT NULL
         UNION SELECT project_id FROM agent_tasks
         UNION SELECT project_id FROM agent_handoffs WHERE project_id IS NOT NULL
         ORDER BY project_id`,
      )
      .pluck()
      .all() as string[];
  }

  listLiveAgentSessions(): AgentSession[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM agent_sessions WHERE status IN ('starting', 'active', 'idle')
           ORDER BY created_at`,
        )
        .all() as AgentSessionRow[]
    ).map(agentSessionFromRow);
  }

  /** Agent session whose dash-less id starts with `prefix` (native session names, AP-D015). */
  findAgentSessionsByIdPrefix(prefix: string): AgentSession[] {
    const rows = this.#database
      .prepare("SELECT * FROM agent_sessions WHERE replace(id, '-', '') LIKE ? || '%'")
      .all(prefix) as AgentSessionRow[];
    return rows.map(agentSessionFromRow);
  }

  bindAgentPane(agentSessionId: string, paneId: string, updatedAt: string): void {
    this.#database
      .prepare("UPDATE agent_sessions SET pane_id = ?, updated_at = ? WHERE id = ?")
      .run(paneId, updatedAt, agentSessionId);
  }

  findAgentSessionByPane(paneId: string): AgentSession | null {
    const row = this.#database
      .prepare("SELECT * FROM agent_sessions WHERE pane_id = ?")
      .get(paneId) as AgentSessionRow | undefined;
    return row === undefined ? null : agentSessionFromRow(row);
  }

  updateAgentSession(session: AgentSession): void {
    this.#database
      .prepare(
        `UPDATE agent_sessions SET runtime_session_ref = ?, observation = ?,
           conversation_writer = ?, human_hold_since = ?, status = ?, launch_mode = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        session.runtimeSessionRef,
        session.observation,
        session.conversationWriter,
        session.humanHoldSince,
        session.status,
        session.launchMode,
        session.updatedAt,
        session.id,
      );
  }

  // Shared processes -----------------------------------------------------------------------------

  insertSharedProcess(process: SharedProcess): void {
    this.#database
      .prepare(
        `INSERT INTO agent_shared_processes (
           id, project_id, task_id, run_id, agent_session_id, purpose, command, ports_json, keep,
           pane_id, human_hold_since, status, exit_code, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        process.id,
        process.projectId,
        process.taskId,
        process.runId,
        process.agentSessionId,
        process.purpose,
        process.command,
        JSON.stringify(process.ports),
        process.keep,
        process.paneId,
        process.humanHoldSince,
        process.status,
        process.exitCode,
        process.createdAt,
        process.updatedAt,
      );
  }

  getSharedProcess(id: string): SharedProcess | null {
    const row = this.#database
      .prepare("SELECT * FROM agent_shared_processes WHERE id = ?")
      .get(id) as SharedProcessRow | undefined;
    return row === undefined ? null : sharedProcessFromRow(row);
  }

  findSharedProcessByPane(paneId: string): SharedProcess | null {
    const row = this.#database
      .prepare("SELECT * FROM agent_shared_processes WHERE pane_id = ?")
      .get(paneId) as SharedProcessRow | undefined;
    return row === undefined ? null : sharedProcessFromRow(row);
  }

  listSharedProcesses(filter: { projectId?: string; runId?: string }): SharedProcess[] {
    const rows = (
      filter.runId !== undefined
        ? this.#database
            .prepare("SELECT * FROM agent_shared_processes WHERE run_id = ? ORDER BY created_at")
            .all(filter.runId)
        : this.#database
            .prepare(
              "SELECT * FROM agent_shared_processes WHERE project_id = ? ORDER BY created_at",
            )
            .all(filter.projectId ?? "")
    ) as SharedProcessRow[];
    return rows.map(sharedProcessFromRow);
  }

  /** Agent sessions and shared processes a person holds now (AP-D005 auto-return). */
  listHumanHolds(): {
    kind: "agent" | "process";
    id: string;
    heldSince: string;
    paneId: string | null;
  }[] {
    return this.#database
      .prepare(
        `SELECT 'agent' AS kind, id, human_hold_since AS heldSince, pane_id AS paneId
           FROM agent_sessions WHERE human_hold_since IS NOT NULL
         UNION ALL
         SELECT 'process' AS kind, id, human_hold_since AS heldSince, pane_id AS paneId
           FROM agent_shared_processes WHERE human_hold_since IS NOT NULL`,
      )
      .all() as {
      kind: "agent" | "process";
      id: string;
      heldSince: string;
      paneId: string | null;
    }[];
  }

  /** Processes Naru still considers alive; checked against the Host after a restart. */
  listActiveSharedProcesses(): SharedProcess[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM agent_shared_processes WHERE status IN ('starting', 'running')
           ORDER BY created_at`,
        )
        .all() as SharedProcessRow[]
    ).map(sharedProcessFromRow);
  }

  updateSharedProcess(process: SharedProcess): void {
    this.#database
      .prepare(
        `UPDATE agent_shared_processes SET pane_id = ?, human_hold_since = ?, status = ?,
           exit_code = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        process.paneId,
        process.humanHoldSince,
        process.status,
        process.exitCode,
        process.updatedAt,
        process.id,
      );
  }

  insertSharedProcessInput(input: {
    readonly id: string;
    readonly processId: string;
    readonly agentSessionId: string;
    readonly verbatim: string;
    readonly createdAt: string;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO agent_shared_process_inputs (id, process_id, agent_session_id, verbatim, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.processId, input.agentSessionId, input.verbatim, input.createdAt);
  }

  listSharedProcessInputs(
    processId: string,
  ): { verbatim: string; agentSessionId: string | null }[] {
    return (
      this.#database
        .prepare(
          `SELECT verbatim, agent_session_id FROM agent_shared_process_inputs
           WHERE process_id = ? ORDER BY created_at, rowid`,
        )
        .all(processId) as { verbatim: string; agent_session_id: string | null }[]
    ).map((row) => ({ verbatim: row.verbatim, agentSessionId: row.agent_session_id }));
  }

  // Handoffs, reviews, artifacts -----------------------------------------------------------------

  insertHandoff(handoff: Handoff): void {
    this.#database
      .prepare(
        `INSERT INTO agent_handoffs (
           id, project_id, kind, status, requested_by_kind, requested_by_agent_session_id,
           payload_json, resolution_json, created_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handoff.id,
        handoff.projectId,
        handoff.kind,
        handoff.status,
        handoff.requestedBy.kind,
        handoff.requestedBy.kind === "agent" ? handoff.requestedBy.agentSessionId : null,
        JSON.stringify(handoff.payload),
        handoff.resolution === null ? null : JSON.stringify(handoff.resolution),
        handoff.createdAt,
        handoff.resolvedAt,
      );
  }

  getHandoff(id: string): Handoff | null {
    const row = this.#database.prepare("SELECT * FROM agent_handoffs WHERE id = ?").get(id) as
      HandoffRow | undefined;
    return row === undefined ? null : handoffFromRow(row);
  }

  listOpenHandoffs(projectId: string | null): Handoff[] {
    const rows = (
      projectId === null
        ? this.#database
            .prepare("SELECT * FROM agent_handoffs WHERE status = 'open' ORDER BY created_at")
            .all()
        : this.#database
            .prepare(
              `SELECT * FROM agent_handoffs WHERE status = 'open' AND project_id = ?
               ORDER BY created_at`,
            )
            .all(projectId)
    ) as HandoffRow[];
    return rows.map(handoffFromRow);
  }

  /** Resolves or cancels an open handoff exactly once. */
  closeHandoff(handoff: Handoff): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE agent_handoffs SET status = ?, resolution_json = ?, resolved_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(
          handoff.status,
          handoff.resolution === null ? null : JSON.stringify(handoff.resolution),
          handoff.resolvedAt,
          handoff.id,
        ).changes === 1
    );
  }

  insertReview(review: Review): void {
    this.#database
      .prepare(
        `INSERT INTO agent_reviews (
           id, task_id, run_id, reviewer_agent_session_id, kind, verdict, findings, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        review.id,
        review.taskId,
        review.runId,
        review.reviewerAgentSessionId,
        review.kind,
        review.verdict,
        review.findings,
        review.createdAt,
      );
  }

  listReviews(taskId: string): Review[] {
    const rows = this.#database
      .prepare("SELECT * FROM agent_reviews WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId) as ReviewRow[];
    return rows.map(reviewFromRow);
  }

  insertArtifact(artifact: Artifact): void {
    this.#database
      .prepare(
        `INSERT INTO agent_artifacts (
           id, task_id, run_id, kind, reference, summary, exit_code, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.taskId,
        artifact.runId,
        artifact.kind,
        artifact.reference,
        artifact.summary,
        artifact.exitCode,
        artifact.createdAt,
      );
  }

  listArtifacts(taskId: string): Artifact[] {
    const rows = this.#database
      .prepare("SELECT * FROM agent_artifacts WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId) as ArtifactRow[];
    return rows.map(artifactFromRow);
  }

  // Worktrees (AP-D016) --------------------------------------------------------------------------

  insertWorktree(worktree: AgentWorktree): void {
    this.#database
      .prepare(
        `INSERT INTO agent_worktrees (
           project_id, parent_project_id, task_id, branch, created_by_agent_session_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        worktree.projectId,
        worktree.parentProjectId,
        worktree.taskId,
        worktree.branch,
        worktree.createdByAgentSessionId,
        worktree.createdAt,
      );
  }

  getWorktree(projectId: string): AgentWorktree | null {
    const row = this.#database
      .prepare("SELECT * FROM agent_worktrees WHERE project_id = ?")
      .get(projectId) as WorktreeRow | undefined;
    return row === undefined ? null : worktreeFromRow(row);
  }

  findTaskWorktree(taskId: string, branch: string): AgentWorktree | null {
    const row = this.#database
      .prepare("SELECT * FROM agent_worktrees WHERE task_id = ? AND branch = ?")
      .get(taskId, branch) as WorktreeRow | undefined;
    return row === undefined ? null : worktreeFromRow(row);
  }

  // Native messages (AP-D015) -------------------------------------------------------------------

  insertNativeMessage(input: {
    readonly instructionId: string;
    readonly senderAgentSessionId: string;
    readonly recipientAgentSessionId: string;
    readonly bodyDigest: string;
    readonly senderPids: readonly number[];
    readonly createdAt: string;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO agent_native_messages (
           instruction_id, sender_agent_session_id, recipient_agent_session_id, body_digest,
           sender_pids_json, status, created_at, delivered_at
         ) VALUES (?, ?, ?, ?, ?, 'authorized', ?, NULL)`,
      )
      .run(
        input.instructionId,
        input.senderAgentSessionId,
        input.recipientAgentSessionId,
        input.bodyDigest,
        JSON.stringify(input.senderPids),
        input.createdAt,
      );
  }

  /** Oldest authorized, undelivered message to `recipient` with this body digest. */
  findPendingNativeMessages(
    recipientAgentSessionId: string,
    bodyDigest: string,
  ): { instructionId: string; senderAgentSessionId: string; senderPids: number[] }[] {
    const rows = this.#database
      .prepare(
        `SELECT instruction_id, sender_agent_session_id, sender_pids_json
         FROM agent_native_messages
         WHERE recipient_agent_session_id = ? AND body_digest = ? AND status = 'authorized'
         ORDER BY created_at, rowid`,
      )
      .all(recipientAgentSessionId, bodyDigest) as {
      instruction_id: string;
      sender_agent_session_id: string;
      sender_pids_json: string;
    }[];
    return rows.map((row) => ({
      instructionId: row.instruction_id,
      senderAgentSessionId: row.sender_agent_session_id,
      senderPids: z.array(z.number().int()).parse(JSON.parse(row.sender_pids_json)),
    }));
  }

  markNativeMessageDelivered(instructionId: string, deliveredAt: string): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE agent_native_messages SET status = 'delivered', delivered_at = ?
           WHERE instruction_id = ? AND status = 'authorized'`,
        )
        .run(deliveredAt, instructionId).changes === 1
    );
  }

  /** The latest active task assigned to an agent, used as provenance for its native messages. */
  findCurrentTaskForAgent(agentSessionId: string): AgentTask | null {
    const row = this.#database
      .prepare(
        `SELECT * FROM agent_tasks
         WHERE assignee_agent_session_id = ? AND status IN ('running', 'ready', 'review', 'blocked')
         ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 1`,
      )
      .get(agentSessionId) as TaskRow | undefined;
    return row === undefined ? null : this.#taskFromRow(row);
  }

  // Agent capabilities --------------------------------------------------------------------------

  /** Only a digest is stored; the bearer token exists in the agent process environment alone. */
  insertCapability(digest: string, agentSessionId: string, createdAt: string): void {
    this.#database
      .prepare(
        `INSERT INTO agent_capabilities (digest, agent_session_id, created_at, revoked_at)
         VALUES (?, ?, ?, NULL)`,
      )
      .run(digest, agentSessionId, createdAt);
  }

  findCapabilitySession(digest: string): string | null {
    return (
      (this.#database
        .prepare(
          "SELECT agent_session_id FROM agent_capabilities WHERE digest = ? AND revoked_at IS NULL",
        )
        .pluck()
        .get(digest) as string | undefined) ?? null
    );
  }

  revokeCapabilities(agentSessionId: string, revokedAt: string): number {
    return this.#database
      .prepare(
        `UPDATE agent_capabilities SET revoked_at = ?
         WHERE agent_session_id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, agentSessionId).changes;
  }

  // Runtime launches -----------------------------------------------------------------------------

  /** One live launch token per agent session; replacing it invalidates the previous runner. */
  replaceRuntimeLaunch(agentSessionId: string, tokenDigest: string, createdAt: string): void {
    this.#database
      .prepare(
        `INSERT INTO agent_runtime_launches (agent_session_id, token_digest, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_session_id) DO UPDATE SET token_digest = excluded.token_digest,
           created_at = excluded.created_at`,
      )
      .run(agentSessionId, tokenDigest, createdAt);
  }

  findRuntimeLaunch(tokenDigest: string): string | null {
    return (
      (this.#database
        .prepare("SELECT agent_session_id FROM agent_runtime_launches WHERE token_digest = ?")
        .pluck()
        .get(tokenDigest) as string | undefined) ?? null
    );
  }

  deleteRuntimeLaunch(agentSessionId: string): void {
    this.#database
      .prepare("DELETE FROM agent_runtime_launches WHERE agent_session_id = ?")
      .run(agentSessionId);
  }

  // Events and idempotency -----------------------------------------------------------------------

  appendEvent(event: Omit<AgentEvent, "seq">): AgentEvent {
    const result = this.#database
      .prepare(
        `INSERT INTO agent_events (
           id, type, project_id, actor_kind, actor_agent_session_id, subject_id, correlation_id,
           data_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        event.projectId,
        event.actor.kind,
        event.actor.kind === "agent" ? event.actor.agentSessionId : null,
        event.subjectId,
        event.correlationId,
        JSON.stringify(event.data),
        event.createdAt,
      );
    return { ...event, seq: Number(result.lastInsertRowid) };
  }

  /** Events after `afterSeq`; a project filter still includes global (null project) events. */
  readEvents(options: {
    readonly afterSeq: number;
    readonly projectId?: string;
    readonly limit: number;
    /** The newest `limit` matches instead of the oldest; the result stays ascending. */
    readonly latest?: boolean;
  }): AgentEvent[] {
    const order = options.latest === true ? "DESC" : "ASC";
    const rows = (
      options.projectId === undefined
        ? this.#database
            .prepare(`SELECT * FROM agent_events WHERE seq > ? ORDER BY seq ${order} LIMIT ?`)
            .all(options.afterSeq, options.limit)
        : this.#database
            .prepare(
              `SELECT * FROM agent_events
               WHERE seq > ? AND (project_id = ? OR project_id IS NULL)
               ORDER BY seq ${order} LIMIT ?`,
            )
            .all(options.afterSeq, options.projectId, options.limit)
    ) as EventRow[];
    if (options.latest === true) rows.reverse();
    return rows.map(eventFromRow);
  }

  getCursor(consumerId: string): number {
    return (
      (this.#database
        .prepare("SELECT last_seq FROM agent_event_cursors WHERE consumer_id = ?")
        .pluck()
        .get(consumerId) as number | undefined) ?? 0
    );
  }

  /** Cursors only move forward so a late acknowledgement cannot replay delivered events. */
  advanceCursor(consumerId: string, seq: number): void {
    this.#database
      .prepare(
        `INSERT INTO agent_event_cursors (consumer_id, last_seq) VALUES (?, ?)
         ON CONFLICT(consumer_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`,
      )
      .run(consumerId, seq);
  }

  findCommand(
    actorKey: string,
    idempotencyKey: string,
  ): { fingerprint: string; resultType: string; resultId: string } | null {
    const row = this.#database
      .prepare(
        `SELECT fingerprint, result_type, result_id FROM agent_commands
         WHERE actor_key = ? AND idempotency_key = ?`,
      )
      .get(actorKey, idempotencyKey) as
      { fingerprint: string; result_type: string; result_id: string } | undefined;
    return row === undefined
      ? null
      : { fingerprint: row.fingerprint, resultType: row.result_type, resultId: row.result_id };
  }

  recordCommand(input: {
    readonly actorKey: string;
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly resultType: string;
    readonly resultId: string;
    readonly createdAt: string;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO agent_commands (
           actor_key, idempotency_key, fingerprint, result_type, result_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.actorKey,
        input.idempotencyKey,
        input.fingerprint,
        input.resultType,
        input.resultId,
        input.createdAt,
      );
  }
}

const StringListSchema = z.array(z.string());

function nextVersion(database: Database.Database, table: string, projectId: string): number {
  const current = database
    .prepare(`SELECT COALESCE(MAX(version), 0) FROM ${table} WHERE project_id = ?`)
    .pluck()
    .get(projectId) as number;
  return current + 1;
}

function scopeColumns(scope: InstructionScope): {
  kind: InstructionScope["kind"];
  projectId: string | null;
  taskId: string | null;
  agentSessionId: string | null;
} {
  switch (scope.kind) {
    case "global":
      return { kind: "global", projectId: null, taskId: null, agentSessionId: null };
    case "project":
      return { kind: "project", projectId: scope.projectId, taskId: null, agentSessionId: null };
    case "task":
      return {
        kind: "task",
        projectId: scope.projectId,
        taskId: scope.taskId,
        agentSessionId: null,
      };
    case "agent":
      return {
        kind: "agent",
        projectId: scope.projectId,
        taskId: null,
        agentSessionId: scope.agentSessionId,
      };
  }
}

function actorFromColumns(kind: Actor["kind"], agentSessionId: string | null): Actor {
  if (kind === "agent") {
    if (agentSessionId === null) throw new Error("Agent actor row lost its session reference.");
    return { kind, agentSessionId };
  }
  return { kind };
}

interface InstructionRow {
  id: string;
  scope_kind: InstructionScope["kind"];
  project_id: string | null;
  task_id: string | null;
  agent_session_id: string | null;
  author_kind: Actor["kind"];
  author_agent_session_id: string | null;
  channel: Instruction["channel"];
  origin_user_instruction_id: string | null;
  supersedes_id: string | null;
  verbatim: string | null;
  forgotten_at: string | null;
  created_at: string;
}

function instructionFromRow(row: InstructionRow): Instruction {
  let scope: InstructionScope;
  switch (row.scope_kind) {
    case "global":
      scope = { kind: "global" };
      break;
    case "project":
      scope = { kind: "project", projectId: row.project_id! };
      break;
    case "task":
      scope = { kind: "task", projectId: row.project_id!, taskId: row.task_id! };
      break;
    case "agent":
      scope = { kind: "agent", projectId: row.project_id, agentSessionId: row.agent_session_id! };
      break;
  }
  return {
    id: row.id,
    scope,
    // A forgotten agent author keeps the "agent" kind only while its session row exists.
    author:
      row.author_kind === "agent" && row.author_agent_session_id === null
        ? { kind: "system" }
        : actorFromColumns(row.author_kind, row.author_agent_session_id),
    channel: row.channel,
    originUserInstructionId: row.origin_user_instruction_id,
    supersedesId: row.supersedes_id,
    verbatim: row.verbatim,
    forgottenAt: row.forgotten_at,
    createdAt: row.created_at,
  };
}

interface IntentContractRow {
  id: string;
  project_id: string;
  version: number;
  status: IntentContract["status"];
  body_json: string;
  source_instruction_id: string;
  approved_by_handoff_id: string | null;
  created_at: string;
}

function intentContractFromRow(row: IntentContractRow): IntentContract {
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    status: row.status,
    body: IntentContractBodySchema.parse(JSON.parse(row.body_json)),
    sourceInstructionId: row.source_instruction_id,
    approvedByHandoffId: row.approved_by_handoff_id,
    createdAt: row.created_at,
  };
}

interface PlanRow {
  id: string;
  project_id: string;
  version: number;
  status: Plan["status"];
  owner_agent_session_id: string | null;
  summary: string;
  intent_contract_id: string | null;
  created_at: string;
}

function planFromRow(row: PlanRow): Plan {
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    status: row.status,
    ownerAgentSessionId: row.owner_agent_session_id,
    summary: row.summary,
    intentContractId: row.intent_contract_id,
    createdAt: row.created_at,
  };
}

interface TaskRow {
  id: string;
  project_id: string;
  plan_id: string | null;
  title: string;
  purpose: string;
  completion_criteria_json: string;
  status: AgentTask["status"];
  priority: number;
  assignee_agent_session_id: string | null;
  origin_instruction_id: string;
  intent_contract_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  task_id: string;
  agent_session_id: string | null;
  runtime: Run["runtime"];
  model: string | null;
  status: Run["status"];
  attempt: number;
  error_class: string | null;
  summary: string | null;
  started_at: string;
  finished_at: string | null;
}

function runFromRow(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    agentSessionId: row.agent_session_id,
    runtime: row.runtime,
    model: row.model,
    status: row.status,
    attempt: row.attempt,
    errorClass: row.error_class,
    summary: row.summary,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

interface AgentSessionRow {
  id: string;
  project_id: string | null;
  role: AgentSession["role"];
  runtime: AgentSession["runtime"];
  runtime_session_ref: string | null;
  parent_agent_session_id: string | null;
  native: number;
  observation: AgentSession["observation"];
  conversation_writer: AgentSession["conversationWriter"];
  human_hold_since: string | null;
  status: AgentSession["status"];
  pane_id: string | null;
  launch_mode: AgentSession["launchMode"];
  created_at: string;
  updated_at: string;
}

function agentSessionFromRow(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    projectId: row.project_id,
    role: row.role,
    runtime: row.runtime,
    runtimeSessionRef: row.runtime_session_ref,
    parentAgentSessionId: row.parent_agent_session_id,
    native: row.native === 1,
    observation: row.observation,
    conversationWriter: row.conversation_writer,
    humanHoldSince: row.human_hold_since,
    status: row.status,
    paneId: row.pane_id,
    launchMode: row.launch_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface SharedProcessRow {
  id: string;
  project_id: string;
  task_id: string | null;
  run_id: string | null;
  agent_session_id: string | null;
  purpose: string;
  command: string;
  ports_json: string;
  keep: SharedProcess["keep"];
  pane_id: string | null;
  human_hold_since: string | null;
  status: SharedProcess["status"];
  exit_code: number | null;
  created_at: string;
  updated_at: string;
}

function sharedProcessFromRow(row: SharedProcessRow): SharedProcess {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    runId: row.run_id,
    agentSessionId: row.agent_session_id,
    purpose: row.purpose,
    command: row.command,
    ports: z.array(z.number().int()).parse(JSON.parse(row.ports_json)),
    keep: row.keep,
    paneId: row.pane_id,
    humanHoldSince: row.human_hold_since,
    status: row.status,
    exitCode: row.exit_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface HandoffRow {
  id: string;
  project_id: string | null;
  kind: Handoff["kind"];
  status: Handoff["status"];
  requested_by_kind: Actor["kind"];
  requested_by_agent_session_id: string | null;
  payload_json: string;
  resolution_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

function handoffFromRow(row: HandoffRow): Handoff {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    requestedBy:
      row.requested_by_kind === "agent" && row.requested_by_agent_session_id === null
        ? { kind: "system" }
        : actorFromColumns(row.requested_by_kind, row.requested_by_agent_session_id),
    payload: HandoffPayloadSchema.parse(JSON.parse(row.payload_json)),
    resolution:
      row.resolution_json === null
        ? null
        : HandoffResolutionSchema.parse(JSON.parse(row.resolution_json)),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

interface ReviewRow {
  id: string;
  task_id: string;
  run_id: string | null;
  reviewer_agent_session_id: string | null;
  kind: Review["kind"];
  verdict: Review["verdict"];
  findings: string;
  created_at: string;
}

function reviewFromRow(row: ReviewRow): Review {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    reviewerAgentSessionId: row.reviewer_agent_session_id,
    kind: row.kind,
    verdict: row.verdict,
    findings: row.findings,
    createdAt: row.created_at,
  };
}

interface WorktreeRow {
  project_id: string;
  parent_project_id: string;
  task_id: string | null;
  branch: string;
  created_by_agent_session_id: string | null;
  created_at: string;
}

function worktreeFromRow(row: WorktreeRow): AgentWorktree {
  return {
    projectId: row.project_id,
    parentProjectId: row.parent_project_id,
    taskId: row.task_id,
    branch: row.branch,
    createdByAgentSessionId: row.created_by_agent_session_id,
    createdAt: row.created_at,
  };
}

interface ArtifactRow {
  id: string;
  task_id: string;
  run_id: string | null;
  kind: Artifact["kind"];
  reference: string;
  summary: string | null;
  exit_code: number | null;
  created_at: string;
}

function artifactFromRow(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    reference: row.reference,
    summary: row.summary,
    exitCode: row.exit_code,
    createdAt: row.created_at,
  };
}

interface EventRow {
  seq: number;
  id: string;
  type: AgentEventType;
  project_id: string | null;
  actor_kind: Actor["kind"];
  actor_agent_session_id: string | null;
  subject_id: string;
  correlation_id: string | null;
  data_json: string;
  created_at: string;
}

const EventDataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

function eventFromRow(row: EventRow): AgentEvent {
  return {
    seq: row.seq,
    id: row.id,
    type: row.type,
    projectId: row.project_id,
    actor:
      row.actor_kind === "agent" && row.actor_agent_session_id === null
        ? { kind: "system" }
        : actorFromColumns(row.actor_kind, row.actor_agent_session_id),
    subjectId: row.subject_id,
    correlationId: row.correlation_id,
    data: EventDataSchema.parse(JSON.parse(row.data_json)),
    createdAt: row.created_at,
  };
}
