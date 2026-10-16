import type { AgentSession } from "@naru/contracts/naru-agent/v1";
import { type FormEvent, useEffect, useState } from "react";
import { useAgentApp } from "./agent-context";
import { presenceLabel } from "./agent-model";
import { Avatar, Sheet } from "./agent-ui";
import {
  ApiFailure,
  type AgentJob,
  type JobAgentKeep,
  type JobCompletionPreview,
  type JobCompletionResult,
} from "./api";

/** Completing a finished job, or reopening a completed one for another round (AP-D036). */
export function JobSheet({
  job,
  action,
  onClose,
}: {
  readonly job: AgentJob;
  readonly action: "complete" | "reopen";
  readonly onClose: () => void;
}): React.JSX.Element {
  return action === "complete" ? (
    <CompleteSheet job={job} onClose={onClose} />
  ) : (
    <ReopenSheet job={job} onClose={onClose} />
  );
}

function CompleteSheet({
  job,
  onClose,
}: {
  readonly job: AgentJob;
  readonly onClose: () => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const [preview, setPreview] = useState<JobCompletionPreview | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  // Every agent that may go starts chosen; one the person wants to keep is unticked.
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<JobCompletionResult | null>(null);
  useEffect(() => {
    let live = true;
    app.api.jobCompletion(job.goal.id).then(
      (next) => {
        if (live) setPreview(next);
      },
      (failure: unknown) => {
        if (live) setIssue(messageOf(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [app.api, job.goal.id]);
  const toggle = (id: string) =>
    setKept((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const leaving =
    preview?.agents.filter((item) => item.keep === null && !kept.has(item.agent.id)) ?? [];

  if (result !== null) {
    const removed = result.worktrees.filter((item) => item.removed);
    const stayed = result.worktrees.filter((item) => !item.removed);
    return (
      <Sheet title="완료했습니다" onClose={onClose}>
        <p className="ag-sheet-lead">{job.goal.verbatim ?? "잊은 지시"}</p>
        <section className="ag-sheet-section">
          <h3>정리한 것</h3>
          <ul className="ag-plain-list">
            <li>
              {result.retired.length === 0
                ? "정리한 에이전트가 없습니다."
                : `에이전트 ${result.retired.length}개: ${names(app, result.retired)}`}
            </li>
            {removed.length > 0 && (
              <li>
                작업 브랜치와 워크트리 {removed.length}개:{" "}
                {removed.map((item) => item.branch).join(", ")}
              </li>
            )}
          </ul>
        </section>
        {(result.kept.length > 0 || stayed.length > 0 || result.panesKept > 0) && (
          <section className="ag-sheet-section">
            <h3>남긴 것</h3>
            <ul className="ag-plain-list">
              {result.kept.map((item) => (
                <li key={item.agent.id}>
                  {app.identity(item.agent).name} · {keepLabel(item.keep)}
                </li>
              ))}
              {stayed.map((item) => (
                <li key={item.branch}>
                  {item.branch} · {worktreeReason(item.reason)}
                </li>
              ))}
              {result.panesKept > 0 && <li>닫지 못한 Pane {result.panesKept}개</li>}
            </ul>
          </section>
        )}
        <p className="ag-muted">
          대화 기록은 남아 있습니다. 끝난 일에서 다시 열면 같은 대화로 이어 갑니다.
        </p>
        <div className="ag-sheet-actions">
          <button className="ag-button" data-variant="primary" type="button" onClick={onClose}>
            확인
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="완료 확인" onClose={onClose}>
      <p className="ag-sheet-lead">{job.goal.verbatim ?? "잊은 지시"}</p>
      <p className="ag-muted">
        모든 작업이 끝났습니다. 완료하면 이 일을 한 작업자와 리뷰어를 멈추고 정리합니다. 대화 기록은
        남고, 다시 열면 같은 대화로 이어 갑니다. 오케스트레이터는 그대로 둡니다.
      </p>
      {issue !== null && (
        <p className="ag-issue" role="status">
          {issue}
        </p>
      )}
      {preview === null ? (
        issue === null && <p className="ag-muted">정리할 것을 확인하는 중…</p>
      ) : (
        <>
          <section className="ag-sheet-section">
            <h3>정리할 에이전트</h3>
            {preview.agents.length === 0 ? (
              <p className="ag-muted">이 일에만 쓴 에이전트가 없습니다.</p>
            ) : (
              <ul className="ag-cleanup-list">
                {preview.agents.map((item) => (
                  <li key={item.agent.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.keep === null && !kept.has(item.agent.id)}
                        disabled={item.keep !== null}
                        onChange={() => toggle(item.agent.id)}
                      />
                      <Avatar
                        identity={app.identity(item.agent)}
                        size={22}
                        presence={app.presence(item.agent)}
                      />
                      <span>{app.identity(item.agent).name}</span>
                      <span className="ag-muted">
                        {item.keep === null
                          ? presenceLabel(app.presence(item.agent))
                          : keepLabel(item.keep)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {preview.worktrees.length > 0 && (
            <section className="ag-sheet-section">
              <h3>작업 브랜치</h3>
              <ul className="ag-plain-list">
                {preview.worktrees.map((item) => (
                  <li key={item.branch}>
                    <code>{item.branch}</code> ·{" "}
                    {item.merged
                      ? "병합됨 · 깨끗하면 워크트리와 브랜치를 지웁니다"
                      : "병합 기록이 없어 남깁니다"}
                  </li>
                ))}
              </ul>
              <p className="ag-muted">
                커밋하지 않은 변경이나 병합 뒤 새 커밋이 있으면 지우지 않습니다. 원격 저장소는
                건드리지 않습니다.
              </p>
            </section>
          )}
        </>
      )}
      <div className="ag-sheet-actions">
        <button className="ag-button" type="button" onClick={onClose}>
          나중에
        </button>
        <button
          className="ag-button"
          data-variant="primary"
          type="button"
          disabled={busy || preview === null || preview.openTasks > 0 || !app.mutationAllowed}
          onClick={() => {
            setBusy(true);
            let outcome: JobCompletionResult | null = null;
            void app
              .act("일을 완료했습니다.", async () => {
                outcome = await app.api.completeJob(job.goal.id, [...kept]);
              })
              .then((done) => {
                setBusy(false);
                if (done && outcome !== null) setResult(outcome);
              });
          }}
        >
          {leaving.length === 0 ? "완료" : `완료하고 ${leaving.length}개 정리`}
        </button>
      </div>
    </Sheet>
  );
}

function ReopenSheet({
  job,
  onClose,
}: {
  readonly job: AgentJob;
  readonly onClose: () => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<readonly AgentSession[]>([]);
  const cleaned = (job.cleanedUpAgentSessionIds ?? [])
    .map((id) => app.agentById(id))
    .filter((agent): agent is AgentSession => agent !== undefined);
  return (
    <Sheet title="다시 열기" onClose={onClose}>
      <p className="ag-sheet-lead">{job.goal.verbatim ?? "잊은 지시"}</p>
      <p className="ag-muted">
        이어서 할 일을 적으면 원문 그대로 오케스트레이터에게 전달합니다.
        {cleaned.length > 0 &&
          ` 완료할 때 정리한 ${names(app, cleaned)}을(를) 같은 대화로 다시 띄웁니다.`}
      </p>
      {failed.length > 0 && (
        <p className="ag-issue" role="status">
          {names(app, failed)}은(는) 다시 띄우지 못했습니다. 대화에서 다시 실행할 수 있습니다.
        </p>
      )}
      <form
        className="ag-sheet-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          const verbatim = text.trim();
          if (verbatim === "") return;
          setBusy(true);
          let missed: readonly AgentSession[] = [];
          void app
            .act("다시 열었습니다.", async () => {
              missed = (await app.api.reopenJob(job.goal.id, verbatim)).failed;
            })
            .then((done) => {
              setBusy(false);
              if (!done) return;
              if (missed.length === 0) onClose();
              else setFailed(missed);
            });
        }}
      >
        <label className="ag-field">
          <span>이어서 할 일 (원문 그대로 전달됩니다)</span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            placeholder="무엇을 더 하거나 고칠지 적어 주세요"
            disabled={!app.mutationAllowed || failed.length > 0}
          />
        </label>
        <div className="ag-sheet-actions">
          <button className="ag-button" type="button" onClick={onClose}>
            {failed.length > 0 ? "닫기" : "나중에"}
          </button>
          {failed.length === 0 && (
            <button
              className="ag-button"
              data-variant="primary"
              type="submit"
              disabled={!app.mutationAllowed || busy || text.trim() === ""}
            >
              다시 열기
            </button>
          )}
        </div>
      </form>
    </Sheet>
  );
}

function names(app: ReturnType<typeof useAgentApp>, agents: readonly AgentSession[]): string {
  return agents.map((agent) => app.identity(agent).name).join(", ");
}

function keepLabel(keep: JobAgentKeep): string {
  switch (keep) {
    case "held":
      return "남김 · 사람이 잡고 있음";
    case "other-work":
      return "남김 · 다른 일을 맡고 있음";
    case "working":
      return "남김 · 지금 일하는 중";
    case "person":
      return "남김";
  }
}

function worktreeReason(reason: JobCompletionResult["worktrees"][number]["reason"]): string {
  switch (reason) {
    case "changes":
      return "커밋하지 않은 변경이 있어 남김";
    case "unmerged":
      return "병합 뒤 새 커밋이 있어 남김";
    case "in-use":
      return "열린 터미널이나 Naru 기록이 있어 남김";
    case "missing":
      return "이미 없음";
    case "failed":
    case null:
      return "git이 지우지 못해 남김";
  }
}

function messageOf(failure: unknown): string {
  return failure instanceof ApiFailure ? failure.message : "요청을 처리하지 못했습니다.";
}
