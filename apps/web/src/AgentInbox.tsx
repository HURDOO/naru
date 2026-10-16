import type { Handoff, IntentContract, SharedProcess } from "@naru/contracts/naru-agent/v1";
import { type FormEvent, useState } from "react";
import { useAgentApp } from "./agent-context";
import { approvalKindLabel, processStatusLabel } from "./agent-labels";
import { ago, type InboxItem, inboxKindLabel } from "./agent-model";
import { Icon, Sheet } from "./agent-ui";
import { jobProgress, stallAge, stallText } from "./jobs-model";

/** One thing that waits for the person, answerable in place when it is a yes/no (AP-D022). */
export function InboxCard({ item }: { readonly item: InboxItem }): React.JSX.Element {
  const app = useAgentApp();
  const project = item.projectId === null ? null : app.projectName(item.projectId);
  const by = (name: string) => (project === null ? name : `${name} · ${project}`);
  if (item.kind === "approval") {
    const name = app.identity(item.agent).name;
    return (
      <article className="ag-inbox-card" aria-label={`${inboxKindLabel(item)}: ${name}`}>
        <header>
          <span className="ag-inbox-kind">{inboxKindLabel(item)}</span>
        </header>
        <h3>{by(name)}</h3>
        {item.approval.summary === undefined ? (
          <p>에이전트가 허락을 기다립니다.</p>
        ) : (
          <code className="ag-inbox-code">{item.approval.summary}</code>
        )}
        <div className="ag-inbox-actions">
          <button
            className="ag-button"
            data-variant="primary"
            type="button"
            disabled={!app.mutationAllowed}
            onClick={() =>
              void app.act(`${approvalKindLabel(item.approval.kind)}을 승인했습니다.`, () =>
                app.api.respondAgentApproval(item.agent.id, item.approval.requestId, "approve"),
              )
            }
          >
            승인
          </button>
          <button
            className="ag-button"
            type="button"
            disabled={!app.mutationAllowed}
            onClick={() =>
              void app.act("거부했습니다.", () =>
                app.api.respondAgentApproval(item.agent.id, item.approval.requestId, "deny"),
              )
            }
          >
            거부
          </button>
          {item.approval.sessionAllow === true && (
            <button
              className="ag-button"
              type="button"
              disabled={!app.mutationAllowed}
              title="같은 종류의 요청은 이 에이전트 세션이 끝날 때까지 묻지 않습니다"
              onClick={() =>
                void app.act("이 세션에서는 묻지 않게 허용했습니다.", () =>
                  app.api.respondAgentApproval(
                    item.agent.id,
                    item.approval.requestId,
                    "approve-session",
                  ),
                )
              }
            >
              이 세션에서는 항상 허용
            </button>
          )}
          <button className="ag-link" type="button" onClick={() => app.openChat(item.agent.id)}>
            대화 보기
          </button>
        </div>
      </article>
    );
  }
  if (item.kind === "stall") {
    const orchestrator = item.orchestrator;
    return (
      <article
        className="ag-inbox-card"
        data-kind="stall"
        aria-label={`${inboxKindLabel(item)}: ${app.projectName(item.projectId)}`}
      >
        <header>
          <span className="ag-inbox-kind">{inboxKindLabel(item)}</span>
          <span className="ag-inbox-when">{stallAge(item.stall, app.now)}</span>
        </header>
        <h3>{app.projectName(item.projectId)}</h3>
        <p>
          {stallText(item.stall.cause)}
          {item.task === undefined ? "" : ` · ${item.task.title}`}
        </p>
        <p className="ag-muted">오케스트레이터를 한 번 깨웠지만 아직 움직임이 없습니다.</p>
        <div className="ag-inbox-actions">
          <button
            className="ag-button"
            data-variant="primary"
            type="button"
            disabled={!app.mutationAllowed}
            onClick={() =>
              void app.act("오케스트레이터에게 다시 확인시켰습니다.", () =>
                app.api.nudgeProject(item.projectId),
              )
            }
          >
            오케스트레이터에게 확인시키기
          </button>
          {orchestrator !== undefined && (
            <button className="ag-link" type="button" onClick={() => app.openChat(orchestrator.id)}>
              대화 보기
            </button>
          )}
        </div>
      </article>
    );
  }
  if (item.kind === "job") {
    const progress = jobProgress(item.job);
    return (
      <article
        className="ag-inbox-card"
        data-kind="job"
        aria-label={`${inboxKindLabel(item)}: ${item.job.goal.verbatim ?? "잊은 지시"}`}
      >
        <header>
          <span className="ag-inbox-kind">{inboxKindLabel(item)}</span>
          <span className="ag-inbox-when">{ago(item.job.goal.createdAt, app.now)} 맡김</span>
        </header>
        <h3>{item.job.goal.verbatim ?? "잊은 지시"}</h3>
        <p>
          작업 {progress.total}개가 모두 끝났습니다. 완료하면 이 일을 한 작업자와 리뷰어를
          정리합니다.
        </p>
        <div className="ag-inbox-actions">
          <button
            className="ag-button"
            data-variant="primary"
            type="button"
            onClick={() => app.openDecision(item)}
          >
            확인하기
          </button>
        </div>
      </article>
    );
  }
  if (item.kind === "contract") {
    const name =
      item.orchestrator === undefined
        ? `${app.projectName(item.projectId)} 오케스트레이터`
        : app.identity(item.orchestrator).name;
    return (
      <article className="ag-inbox-card" aria-label={`${inboxKindLabel(item)}: ${name}`}>
        <header>
          <span className="ag-inbox-kind">{inboxKindLabel(item)}</span>
          <span className="ag-inbox-when">{ago(item.contract.createdAt, app.now)}</span>
        </header>
        <h3>{name}</h3>
        <p>
          {item.contract.body.principles.slice(0, 2).join(" · ") ||
            "이 프로젝트에서 지킬 원칙을 제안했습니다."}
        </p>
        <div className="ag-inbox-actions">
          <button
            className="ag-button"
            data-variant="primary"
            type="button"
            onClick={() => app.openDecision(item)}
          >
            검토하기
          </button>
          {item.orchestrator !== undefined && (
            <button
              className="ag-link"
              type="button"
              onClick={() => app.openChat(item.orchestrator!.id)}
            >
              대화 보기
            </button>
          )}
        </div>
      </article>
    );
  }
  const name =
    item.requester === undefined
      ? item.handoff.requestedBy.kind === "human"
        ? "나"
        : "Naru"
      : app.identity(item.requester).name;
  return (
    <article className="ag-inbox-card" aria-label={`${inboxKindLabel(item)}: ${name}`}>
      <header>
        <span className="ag-inbox-kind">{inboxKindLabel(item)}</span>
        <span className="ag-inbox-when">{ago(item.handoff.createdAt, app.now)}</span>
      </header>
      <h3>{by(name)}</h3>
      <p>{item.handoff.payload.reason}</p>
      <p className="ag-inbox-recommend">추천: {item.handoff.payload.recommendation}</p>
      <div className="ag-inbox-actions">
        <button
          className="ag-button"
          data-variant="primary"
          type="button"
          onClick={() => app.openDecision(item)}
        >
          {item.handoff.kind === "manual-test" || item.handoff.kind === "terminal-control"
            ? "확인하기"
            : "결정하기"}
        </button>
        {item.requester !== undefined && (
          <button
            className="ag-link"
            type="button"
            onClick={() => app.openChat(item.requester!.id)}
          >
            대화 보기
          </button>
        )}
      </div>
    </article>
  );
}

/** The full question behind a handoff or a proposed intent contract, answered in a sheet. */
export function DecisionSheet({
  item,
  onClose,
}: {
  readonly item: Extract<InboxItem, { kind: "handoff" | "contract" }>;
  readonly onClose: () => void;
}): React.JSX.Element {
  return item.kind === "handoff" ? (
    <HandoffSheet item={item} onClose={onClose} />
  ) : (
    <ContractSheet contract={item.contract} onClose={onClose} />
  );
}

function HandoffSheet({
  item,
  onClose,
}: {
  readonly item: Extract<InboxItem, { kind: "handoff" }>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const handoff: Handoff = item.handoff;
  const payload = handoff.payload;
  const [option, setOption] = useState<string | null>(null);
  const [decision, setDecision] = useState("");
  const [busy, setBusy] = useState(false);
  const requester = item.requester;
  const processes =
    handoff.kind === "terminal-control" && requester !== undefined
      ? app.board.projects
          .flatMap((project) => project.processes)
          .filter(
            (process) =>
              process.agentSessionId === requester.id &&
              (process.status === "running" || process.status === "starting"),
          )
      : [];
  const blocking = app.board.projects
    .flatMap((project) => project.tasks)
    .filter((task) => payload.blockingTaskIds.includes(task.id));
  return (
    <Sheet title={inboxKindLabel(item)} onClose={onClose}>
      <p className="ag-sheet-lead">
        {requester === undefined ? "요청" : app.identity(requester).name}
        {item.projectId === null ? "" : ` · ${app.projectName(item.projectId)}`} ·{" "}
        {ago(handoff.createdAt, app.now)}
      </p>
      <section className="ag-sheet-section">
        <p className="ag-sheet-question">{payload.reason}</p>
        {blocking.length > 0 && (
          <p className="ag-muted">기다리는 작업: {blocking.map((task) => task.title).join(", ")}</p>
        )}
      </section>
      <section className="ag-sheet-section ag-recommend">
        <h3>추천</h3>
        <p>{payload.recommendation}</p>
      </section>
      <form
        className="ag-sheet-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          const text = decision.trim() || option || "";
          if (text === "") return;
          setBusy(true);
          void app
            .act("답을 보냈습니다.", () => app.api.resolveHandoff(handoff.id, text, option))
            .then((done) => {
              setBusy(false);
              if (done) onClose();
            });
        }}
      >
        {payload.options.length > 0 && (
          <fieldset className="ag-options">
            <legend>선택지</legend>
            {payload.options.map((choice) => (
              <label key={choice.label} className="ag-option">
                <input
                  type="radio"
                  name={`handoff-${handoff.id}`}
                  value={choice.label}
                  checked={option === choice.label}
                  onChange={() => setOption(choice.label)}
                  disabled={!app.mutationAllowed}
                />
                <span>
                  <strong>{choice.label}</strong>
                  {choice.description !== "" && <span>{choice.description}</span>}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <SheetList title="위험" items={payload.risks} />
        <SheetList title="준비해 둔 것" items={payload.preparedEnvironment} />
        <SheetList title="기다리는 동안 계속하는 일" items={payload.independentWorkToContinue} />
        <p className="ag-muted">다시 이어 가는 조건: {payload.resumeCondition}</p>
        {processes.length > 0 && (
          <section className="ag-sheet-section">
            <h3>터미널</h3>
            <ul className="ag-plain-list">
              {processes.map((process) => (
                <li key={process.id} className="ag-process-row">
                  <span className="ag-dot" data-tone="green" aria-hidden="true" />
                  <span className="ag-process-name">{process.purpose}</span>
                  {process.paneId !== null && (
                    <button
                      className="ag-button"
                      type="button"
                      disabled={!app.mutationAllowed}
                      onClick={() =>
                        void app
                          .act("터미널을 넘겨받았습니다.", () =>
                            process.humanHoldSince === null
                              ? app.api.setProcessHold(process.id, true)
                              : Promise.resolve(),
                          )
                          .then((done) => {
                            if (done) app.openPane(process.paneId!, process.projectId);
                          })
                      }
                    >
                      넘겨받고 열기
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <p className="ag-muted">
              비밀번호 같은 값은 터미널 도구 모음의 &lsquo;비밀 입력&rsquo;으로 넣어 주세요.
            </p>
          </section>
        )}
        <label className="ag-field">
          <span>답 (원문 그대로 에이전트에게 전달됩니다)</span>
          <textarea
            value={decision}
            onChange={(event) => setDecision(event.target.value)}
            rows={3}
            placeholder={
              option === null
                ? "결정이나 확인 결과를 적어 주세요"
                : `${option} (덧붙일 말이 있으면 적어 주세요)`
            }
            disabled={!app.mutationAllowed}
          />
        </label>
        <div className="ag-sheet-actions">
          <button className="ag-button" type="button" onClick={onClose}>
            나중에
          </button>
          <button
            className="ag-button"
            data-variant="primary"
            type="submit"
            disabled={!app.mutationAllowed || busy || (decision.trim() === "" && option === null)}
          >
            답 보내기
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function ContractSheet({
  contract,
  onClose,
}: {
  readonly contract: IntentContract;
  readonly onClose: () => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title="의도 계약 승인" onClose={onClose}>
      <p className="ag-sheet-lead">
        {app.projectName(contract.projectId)} · 제안 v{contract.version} ·{" "}
        {ago(contract.createdAt, app.now)}
      </p>
      <p className="ag-muted">
        승인하면 이 프로젝트의 에이전트들이 아래 원칙 안에서 스스로 판단하고, 벗어날 때만 다시
        묻습니다.
      </p>
      <ContractBody contract={contract} />
      <div className="ag-sheet-actions">
        <button className="ag-button" type="button" onClick={onClose}>
          나중에
        </button>
        <button
          className="ag-button"
          data-variant="primary"
          type="button"
          disabled={!app.mutationAllowed || busy}
          onClick={() => {
            setBusy(true);
            void app
              .act(`의도 계약 v${contract.version}을 승인했습니다.`, () =>
                app.api.approveIntentContract(contract.id),
              )
              .then((done) => {
                setBusy(false);
                if (done) onClose();
              });
          }}
        >
          이 계약으로 진행
        </button>
      </div>
    </Sheet>
  );
}

export function ContractBody({
  contract,
}: {
  readonly contract: IntentContract;
}): React.JSX.Element {
  return (
    <div className="ag-contract">
      <SheetList title="원칙" items={contract.body.principles} />
      <SheetList title="스스로 정해도 되는 것" items={contract.body.allowedChoices} />
      <SheetList title="승인이 필요한 경우" items={contract.body.requireApprovalIf} />
      <SheetList title="하지 않을 것" items={contract.body.forbidden} />
    </div>
  );
}

function SheetList({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section className="ag-sheet-section">
      <h3>{title}</h3>
      <ul className="ag-bullets">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/** A shared process row with its actions (open, take over or return, stop). */
export function ProcessRow({ process }: { readonly process: SharedProcess }): React.JSX.Element {
  const app = useAgentApp();
  const running = process.status === "running" || process.status === "starting";
  const held = process.humanHoldSince !== null;
  return (
    <li className="ag-process">
      <div className="ag-process-row">
        <span
          className="ag-dot"
          data-tone={
            running ? (held ? "blue" : "green") : process.status === "failed" ? "red" : "subtle"
          }
          aria-hidden="true"
        />
        <span className="ag-process-name">
          {process.purpose}
          {process.ports.length > 0 && (
            <span className="ag-muted"> :{process.ports.join(", :")}</span>
          )}
        </span>
        {process.paneId !== null && (
          <button
            className="ag-link"
            type="button"
            onClick={() => app.openPane(process.paneId!, process.projectId)}
          >
            열기
          </button>
        )}
      </div>
      <div className="ag-process-meta">
        <span>
          {processStatusLabel(process.status)}
          {held ? " · 내가 사용 중" : ""}
        </span>
        {running && (
          <span className="ag-process-actions">
            <button
              className="ag-link"
              type="button"
              disabled={!app.mutationAllowed}
              onClick={() =>
                void app.act(held ? "에이전트에게 돌려줬습니다." : "터미널을 넘겨받았습니다.", () =>
                  app.api.setProcessHold(process.id, !held),
                )
              }
            >
              {held ? "돌려주기" : "넘겨받기"}
            </button>
            <button
              className="ag-link"
              type="button"
              disabled={!app.mutationAllowed}
              onClick={() =>
                void app.act("프로세스를 정지했습니다.", () => app.api.stopProcess(process.id))
              }
            >
              정지
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

export function EmptyNote({
  icon = "check",
  children,
}: {
  readonly icon?: "check" | "bell";
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="ag-empty">
      <Icon name={icon} size={15} />
      {children}
    </p>
  );
}
