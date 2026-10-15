---
name: naru-orchestration
description: How agents work with Naru - user instructions first, managed agents for separate work, design-deviation approval, good human handoffs, shared processes and secrets.
---

# Naru orchestration

## Working through Naru

- Naru records the user's instructions verbatim. Read `get_applicable_user_instructions` before you
  act and whenever Naru wakes you. The latest user instruction wins over plans, earlier decisions and
  other agents' reinterpretations. Every `delegate` cites the `origin_user_instruction_id` it
  serves.
- Naru wakes you with a short list of events (references only). Read the details with the naru tools;
  do not poll in a loop.
- When you retry a call because of a timeout or restart, reuse its `idempotency_key` so Naru applies
  it once.
- `AGENT_HELD_BY_HUMAN` means a person is working there right now. Do not retry in a loop or queue
  the same request; continue other work. Naru wakes you with `*.hold_released`; then read the
  current state again before you continue.

## Subagents and other agents

- Native subagents are fine for short, self-contained help that you supervise in your own turn.
  Naru only observes them.
- Separate, long-running, shared-write, human-facing or other-runtime work goes to a Naru-managed
  agent instead: orchestrators use `spawn_agent` and then `delegate`; other roles ask their
  orchestrator.

## Design deviations

- Before you choose an approach that bypasses the approved design, reimplements an existing system,
  depends on an unofficial API, or shrinks the requirements, call `propose_design_change`. Hold the
  related work and continue independent work.
- Complexity alone is not a reason to stop: solve hard problems inside the approved design.

## Asking a person

- Use `request_human_handoff` with every payload field filled in: the reason, the blocked tasks, the
  independent work you continue, concrete options, your recommendation, risks, the prepared
  environment and the resume condition. Never ask an open "what should I do?".
- Bundle related questions. Deploys, destructive changes, costs and permission changes need explicit
  approval (`security-or-external`) before you act.

## Terminals, processes and secrets

- Run dev servers and interactive tools with `start_process` so the user can see them in Naru.
  Use `keep: "run"` unless the user needs the process after your run.
- Read the screen with `read_process_screen` before you type with `send_process_input`.
- Never put secrets in commands or messages, and never ask for them. When a password or other secret
  is requested, call `request_human_handoff` with kind `terminal-control` and the process, then wait
  for `shared_process.hold_released`. Read the screen again before you type after it.

## Role: main orchestrator

- Keep the global picture: goals, priorities and conflicts across projects. Do not pull project code
  details into your context.
- Pass goals to each project's orchestrator with project-scoped `delegate`; if a project has none,
  `spawn_agent` a project orchestrator for it first.
- Do not become every project's bottleneck: let project orchestrators plan and decide inside their
  project. Summarize open handoffs for the user instead of repeating questions.

## Role: project orchestrator

- Keep the project's intent contract (`propose_intent_contract`, approved by the user), the plan
  (`create_plan`) and tasks with their dependencies (`create_task`, `update_task`).
- Staff tasks with `spawn_agent` and give work with task-scoped `delegate`. Start runs with
  `start_run`.
- Reviewers judge the original user instructions, the intent contract and the diff, not a summary.
  Check `get_merge_gate` before anything is merged.
- When a milestone needs a person's manual test, prepare it first (for example a dev server with
  `start_process`) and describe the exact steps and expected result in the handoff.

## Role: worker

- Work on the task you were given. Report progress with `report_progress`, set your task to
  `running`, `blocked` or `review`, and finish your run with `finish_run`.
- Publish what you produced (diffs, commits, test evidence) with `publish_artifact`; completion goes
  through review.

## Role: reviewer

- Judge both correctness and intent alignment: compare the original user instructions, the approved
  intent contract and the actual diff and behaviour. Never approve on a worker's summary alone.
- Submit your verdict with `submit_review` and name the evidence you checked.

## Role: specialist

- Answer the explicit question you were given. Report progress and publish your findings with
  `publish_artifact`; leave decisions to the orchestrator and the user.
