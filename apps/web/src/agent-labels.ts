import type {
  Actor,
  AgentEvent,
  AgentSession,
  AgentTask,
  Artifact,
  Handoff,
  Instruction,
  Review,
  Run,
  SharedProcess,
} from "@naru/contracts/naru-agent/v1";

/** Korean labels and tones for Agent Platform records (AP-T17). Unknown values stay generic. */

export function agentTitle(agent: AgentSession): string {
  const runtime =
    agent.runtime === "codex" ? "Codex" : agent.runtime === "claude" ? "Claude" : "OpenCode";
  return `${roleName(agent.role)} · ${runtime}`;
}

export function roleName(role: AgentSession["role"]): string {
  switch (role) {
    case "main-orchestrator":
      return "메인 오케스트레이터";
    case "project-orchestrator":
      return "프로젝트 오케스트레이터";
    case "worker":
      return "작업자";
    case "reviewer":
      return "리뷰어";
    case "specialist":
      return "전문가";
  }
}

export function statusLabel(status: AgentSession["status"]): string {
  switch (status) {
    case "starting":
      return "시작 중";
    case "active":
      return "작업 중";
    case "idle":
      return "대기";
    case "stopped":
      return "정지됨";
    case "failed":
      return "실패";
    case "unknown":
      return "확인 필요";
  }
}

export function writerLabel(agent: AgentSession): string {
  if (agent.humanHoldSince !== null) {
    return agent.conversationWriter === "tui" ? "사람 (TUI)" : "사람 (Chat)";
  }
  return agent.conversationWriter === "orchestrator" ? "오케스트레이터" : "사람";
}

export function agentTone(agent: AgentSession): string {
  if (agent.humanHoldSince !== null) return "held";
  if (agent.status === "failed" || agent.status === "unknown") return "attention";
  if (agent.status === "active") return "working";
  return "quiet";
}

export function processStatusLabel(status: SharedProcess["status"]): string {
  switch (status) {
    case "starting":
      return "시작 중";
    case "running":
      return "실행 중";
    case "exited":
      return "종료됨";
    case "failed":
      return "실패";
    case "stopped":
      return "정지됨";
    case "unknown":
      return "확인 필요";
  }
}

export function processTone(process: SharedProcess): string {
  if (process.status === "failed" || process.status === "unknown") return "attention";
  return process.status === "running" ? "working" : "quiet";
}

export function handoffKindLabel(kind: Handoff["kind"]): string {
  switch (kind) {
    case "design-deviation":
      return "설계 변경 승인 요청";
    case "product-decision":
      return "제품 결정 요청";
    case "manual-test":
      return "직접 테스트 요청";
    case "terminal-control":
      return "터미널 입력 요청";
    case "security-or-external":
      return "보안·외부 작업 승인 요청";
  }
}

export function approvalKindLabel(kind: string): string {
  switch (kind) {
    case "command":
      return "명령 실행";
    case "file":
      return "파일 변경";
    case "tool":
      return "도구 사용";
    case "permission":
      return "권한";
    default:
      return "확인";
  }
}

export function taskStatusLabel(status: AgentTask["status"]): string {
  switch (status) {
    case "pending":
      return "대기";
    case "ready":
      return "시작 가능";
    case "running":
      return "진행 중";
    case "blocked":
      return "막힘";
    case "review":
      return "리뷰 중";
    case "done":
      return "완료";
    case "failed":
      return "실패";
    case "cancelled":
      return "취소됨";
  }
}

export function taskTone(status: AgentTask["status"]): string {
  switch (status) {
    case "running":
    case "review":
      return "working";
    case "blocked":
    case "failed":
      return "attention";
    case "done":
      return "done";
    default:
      return "quiet";
  }
}

export function runStatusLabel(status: Run["status"]): string {
  switch (status) {
    case "starting":
      return "시작 중";
    case "running":
      return "실행 중";
    case "succeeded":
      return "성공";
    case "failed":
      return "실패";
    case "cancelled":
      return "취소됨";
    case "unknown":
      return "확인 필요";
  }
}

export function reviewKindLabel(kind: Review["kind"]): string {
  return kind === "correctness" ? "정확성 리뷰" : "의도 리뷰";
}

export function reviewVerdictLabel(verdict: Review["verdict"]): string {
  switch (verdict) {
    case "pass":
      return "통과";
    case "needs-changes":
      return "수정 필요";
    case "fail":
      return "실패";
  }
}

export function artifactKindLabel(kind: Artifact["kind"]): string {
  switch (kind) {
    case "commit":
      return "커밋";
    case "branch":
      return "브랜치";
    case "file":
      return "파일";
    case "test-result":
      return "테스트 결과";
    case "document":
      return "문서";
    case "url":
      return "URL";
    case "report":
      return "보고서";
  }
}

/** Core's merge gate reasons (`missing-intent-review`, `open-handoff-manual-test`, …). */
export function mergeReasonLabel(reason: string): string {
  const missing = /^missing-(correctness|intent)-review$/u.exec(reason);
  if (missing !== null) {
    return `${reviewKindLabel(missing[1] as Review["kind"])}가 아직 없습니다`;
  }
  const verdict = /^(correctness|intent)-review-(needs-changes|fail)$/u.exec(reason);
  if (verdict !== null) {
    return `${reviewKindLabel(verdict[1] as Review["kind"])}: ${reviewVerdictLabel(verdict[2] as Review["verdict"])}`;
  }
  const handoff = /^open-handoff-(.+)$/u.exec(reason);
  if (handoff !== null) {
    const kinds: readonly Handoff["kind"][] = [
      "design-deviation",
      "product-decision",
      "manual-test",
      "terminal-control",
      "security-or-external",
    ];
    const kind = kinds.find((candidate) => candidate === handoff[1]);
    return kind === undefined ? "열린 사람 확인이 있습니다" : `${handoffKindLabel(kind)} 대기`;
  }
  return reason;
}

export function channelLabel(channel: Instruction["channel"]): string {
  switch (channel) {
    case "naru-ui":
      return "Naru";
    case "tui":
      return "TUI";
    case "mcp":
      return "에이전트 위임";
    case "native-message":
      return "Claude 메시지";
  }
}

export function actorLabel(actor: Actor, agents: readonly AgentSession[]): string {
  if (actor.kind === "human") return "사용자";
  if (actor.kind === "system") return "Naru";
  const agent = agents.find((candidate) => candidate.id === actor.agentSessionId);
  return agent === undefined ? "에이전트" : agentTitle(agent);
}

export function eventLabel(event: AgentEvent): string {
  return eventTypeLabel(
    event.type,
    typeof event.data.status === "string" ? event.data.status : null,
  );
}

/** An event type as a person reads it; types this build does not know stay generic. */
export function eventTypeLabel(type: string, status: string | null): string {
  switch (type as AgentEvent["type"]) {
    case "instruction.created":
      return "지시 기록";
    case "instruction.forgotten":
      return "지시 삭제";
    case "instruction.delivered":
      return "메시지 전달";
    case "intent_contract.proposed":
      return "의도 계약 제안";
    case "intent_contract.approved":
      return "의도 계약 승인";
    case "plan.created":
      return "계획 작성";
    case "task.created":
      return "작업 생성";
    case "task.updated":
      return status === null
        ? "작업 변경"
        : `작업 ${taskStatusLabel(status as AgentTask["status"])}`;
    case "run.started":
      return "실행 시작";
    case "run.progress":
      return "실행 진행";
    case "run.finished":
      return status === null ? "실행 종료" : `실행 ${runStatusLabel(status as Run["status"])}`;
    case "agent_session.registered":
      return "에이전트 등록";
    case "agent_session.updated":
      return status === null
        ? "에이전트 상태 변경"
        : `에이전트 ${statusLabel(status as AgentSession["status"])}`;
    case "agent_session.hold_started":
      return "사람이 개입";
    case "agent_session.hold_released":
      return "에이전트에게 반환";
    case "handoff.requested":
      return "사람 확인 요청";
    case "handoff.resolved":
      return "사람 확인 완료";
    case "handoff.cancelled":
      return "사람 확인 취소";
    case "review.submitted":
      return "리뷰 제출";
    case "artifact.published":
      return "산출물 등록";
    case "shared_process.started":
      return "공유 프로세스 시작";
    case "shared_process.updated":
      return status === null
        ? "공유 프로세스 변경"
        : `공유 프로세스 ${processStatusLabel(status as SharedProcess["status"])}`;
    case "shared_process.hold_started":
      return "프로세스 사람이 개입";
    case "shared_process.hold_released":
      return "프로세스 반환";
    default:
      return "Naru 기록";
  }
}

export function timeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
