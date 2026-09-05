import type {
  DocumentCatalog,
  DocumentContent,
  Pane,
  SplitDirection,
  TaskItem,
} from "@naru/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ApiFailure } from "./api";
import type { NaruApi } from "./api";
import { SafeMarkdown } from "./document-markdown";
import { documentSections } from "./document-sections";

interface DocumentPaneProps {
  pane: Pane;
  active: boolean;
  panelId: string;
  tabPanel: boolean;
  api: NaruApi;
  mutationAllowed: boolean;
  toolbarExtras?: ReactNode;
  onActivate: () => void;
  onFocus?: () => void;
  onClose: () => Promise<boolean>;
  onOpenInNewPane: (path: string, direction: SplitDirection) => Promise<void>;
  onEditInFiles: (path: string, direction: SplitDirection) => Promise<void>;
  onViewStateChange: (pane: Pane) => void;
}

export function DocumentPane(props: DocumentPaneProps): React.JSX.Element {
  const { api, onViewStateChange, pane } = props;
  const tasksMode = pane.kind === "tasks";
  const [catalog, setCatalog] = useState<DocumentCatalog | null>(null);
  const [selectedPath, setSelectedPath] = useState(pane.viewState.selectedDocumentPath);
  const [navigationOpen, setNavigationOpen] = useState(pane.viewState.navigationOpen);
  const [document, setDocument] = useState<DocumentContent | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const requestSequence = useRef(0);
  const selectedPathRef = useRef(selectedPath);

  const loadDocument = useCallback(
    async (path: string): Promise<void> => {
      const sequence = ++requestSequence.current;
      setLoadingDocument(true);
      setError(null);
      setSourceOpen(false);
      try {
        const next = await api.document(pane.projectId, path);
        if (sequence === requestSequence.current) setDocument(next);
      } catch (cause) {
        if (sequence === requestSequence.current) {
          setDocument(null);
          setError(documentErrorMessage(cause));
        }
      } finally {
        if (sequence === requestSequence.current) setLoadingDocument(false);
      }
    },
    [api, pane.projectId],
  );

  const loadCatalog = useCallback(async (): Promise<void> => {
    setLoadingCatalog(true);
    setError(null);
    try {
      const next = tasksMode ? await api.tasks(pane.projectId) : await api.docs(pane.projectId);
      setCatalog(next);
      const initial = selectedPathRef.current ?? next.documents[0]?.path ?? null;
      if (initial !== selectedPathRef.current) {
        selectedPathRef.current = initial;
        setSelectedPath(initial);
        if (initial !== null) {
          const updated = await api.updatePaneViewState(pane.id, {
            selectedDocumentPath: initial,
          });
          onViewStateChange(updated);
        }
      }
      if (initial !== null) await loadDocument(initial);
      else setDocument(null);
    } catch (cause) {
      setCatalog(null);
      setDocument(null);
      setError(documentErrorMessage(cause));
    } finally {
      setLoadingCatalog(false);
    }
  }, [api, loadDocument, onViewStateChange, pane.id, pane.projectId, tasksMode]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCatalog(), 0);
    return () => {
      window.clearTimeout(timer);
      requestSequence.current += 1;
    };
  }, [loadCatalog]);

  const selectDocument = async (path: string): Promise<void> => {
    if (path === selectedPath) return;
    selectedPathRef.current = path;
    setSelectedPath(path);
    setDocument(null);
    try {
      const updated = await api.updatePaneViewState(pane.id, { selectedDocumentPath: path });
      onViewStateChange(updated);
      await loadDocument(path);
    } catch (cause) {
      setError(documentErrorMessage(cause));
    }
  };

  const toggleNavigation = (): void => {
    const next = !navigationOpen;
    setNavigationOpen(next);
    void api
      .updatePaneViewState(pane.id, { navigationOpen: next })
      .then(onViewStateChange)
      .catch((cause) => {
        setError(documentErrorMessage(cause));
      });
  };

  return (
    <section
      className={`${tasksMode ? "tasks-pane" : "docs-pane"} document-pane pane-surface ${props.active ? "is-active" : ""}`}
      id={props.panelId}
      role={props.tabPanel ? "tabpanel" : "region"}
      aria-label={`${pane.title} ${tasksMode ? "작업 목록" : "문서"}`}
      tabIndex={-1}
      data-pane-id={pane.id}
      data-pane-kind={pane.kind}
      data-active={props.active}
      onPointerDown={props.onActivate}
      onFocusCapture={props.onFocus ?? props.onActivate}
    >
      <header className="pane-toolbar">
        <div className="pane-identity">
          <span className={tasksMode ? "tasks-glyph" : "docs-glyph"} aria-hidden="true">
            {tasksMode ? "✓" : "▤"}
          </span>
          <div>
            <strong>{pane.title}</strong>
            <span>{selectedPath ?? (tasksMode ? "TASKS.md 자동 인식" : "docs/ 탐색")}</span>
          </div>
        </div>
        <div className="pane-actions">
          <span className="status-pill status-ready" role="status">
            <span aria-hidden="true" /> 읽기 전용
          </span>
          <button
            className="icon-button document-navigation-toggle"
            type="button"
            aria-label={navigationOpen ? "문서 목록 접기" : "문서 목록 펼치기"}
            aria-expanded={navigationOpen}
            onClick={toggleNavigation}
          >
            ☷
          </button>
          {props.toolbarExtras}
          <button
            className="icon-button"
            type="button"
            aria-label={`${pane.title} 새로고침`}
            disabled={loadingCatalog || loadingDocument}
            onClick={() => void loadCatalog()}
          >
            ↻
          </button>
          <button
            className="icon-button danger-hover"
            type="button"
            aria-label={`${pane.title} 닫기`}
            disabled={!props.mutationAllowed}
            onClick={(event) => {
              const trigger = event.currentTarget;
              void props.onClose().then((closed) => {
                if (!closed && trigger.isConnected) trigger.focus();
              });
            }}
          >
            ×
          </button>
        </div>
      </header>

      <div className="document-pane-body" data-navigation-open={navigationOpen}>
        {navigationOpen && (
          <DocumentNavigation
            tasksMode={tasksMode}
            catalog={catalog}
            selectedPath={selectedPath}
            loading={loadingCatalog}
            onSelect={(path) => void selectDocument(path)}
          />
        )}
        <main className="document-viewer" aria-busy={loadingDocument}>
          {error ? (
            <DocumentMessage title="문서를 열지 못했습니다" description={error} />
          ) : loadingCatalog || loadingDocument ? (
            <div className="document-loading" role="status">
              <span /> 문서를 정리하는 중…
            </div>
          ) : catalog?.status === "missing" ? (
            <DocumentMessage
              title={tasksMode ? "작업 파일을 찾지 못했습니다" : "docs 폴더가 없습니다"}
              description={
                tasksMode
                  ? "프로젝트의 TASKS.md 또는 docs 아래 TASKS.md를 읽기 전용으로 자동 인식합니다."
                  : "프로젝트에 docs 폴더와 Markdown 문서를 추가하면 이 Pane에서 자동으로 정리합니다."
              }
            />
          ) : catalog?.status === "empty" ? (
            <DocumentMessage
              title="표시할 Markdown 문서가 없습니다"
              description="docs 폴더의 .md 파일만 읽기 전용으로 표시합니다."
            />
          ) : document ? (
            tasksMode ? (
              <TasksDocumentView
                document={document}
                sourceOpen={sourceOpen}
                onToggleSource={() => setSourceOpen((current) => !current)}
                onOpenInNewPane={props.onOpenInNewPane}
                onEditInFiles={props.onEditInFiles}
                mutationAllowed={props.mutationAllowed}
              />
            ) : (
              <DocsDocumentView
                document={document}
                sourceOpen={sourceOpen}
                onToggleSource={() => setSourceOpen((current) => !current)}
                onOpenInNewPane={props.onOpenInNewPane}
                onEditInFiles={props.onEditInFiles}
                mutationAllowed={props.mutationAllowed}
              />
            )
          ) : (
            <DocumentMessage
              title="문서를 선택해 주세요"
              description="목록에서 읽을 문서를 고르세요."
            />
          )}
        </main>
      </div>
    </section>
  );
}

function DocumentNavigation({
  tasksMode,
  catalog,
  selectedPath,
  loading,
  onSelect,
}: {
  tasksMode: boolean;
  catalog: DocumentCatalog | null;
  selectedPath: string | null;
  loading: boolean;
  onSelect: (path: string) => void;
}): React.JSX.Element {
  return (
    <nav className="document-navigation" aria-label={tasksMode ? "작업 파일" : "프로젝트 문서"}>
      <div className="document-navigation-heading">
        <strong>{tasksMode ? "작업 파일" : "문서"}</strong>
        <span>{catalog?.documents.length ?? 0}</span>
      </div>
      {loading ? (
        <span className="document-navigation-empty">불러오는 중…</span>
      ) : (
        <ul>
          {catalog?.documents.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={entry.path === selectedPath ? "is-selected" : ""}
                aria-current={entry.path === selectedPath ? "page" : undefined}
                style={
                  {
                    "--document-depth": Math.max(0, entry.path.split("/").length - 2),
                  } as CSSProperties
                }
                onClick={() => onSelect(entry.path)}
              >
                <span aria-hidden="true">{entry.kind === "tasks" ? "✓" : "·"}</span>
                <span>
                  <strong>{entry.title}</strong>
                  <small>{entry.path}</small>
                </span>
                {entry.tooLarge && <em>큼</em>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

interface DocumentViewProps {
  document: DocumentContent;
  sourceOpen: boolean;
  onToggleSource: () => void;
  onOpenInNewPane: (path: string, direction: SplitDirection) => Promise<void>;
  onEditInFiles: (path: string, direction: SplitDirection) => Promise<void>;
  mutationAllowed: boolean;
}

function DocsDocumentView(props: DocumentViewProps): React.JSX.Element {
  const { document } = props;
  const sections = documentSections(document.source, document.headings);
  return (
    <article className="document-content">
      <DocumentHeader {...props} />
      {document.warnings.length > 0 && <DocumentWarnings warnings={document.warnings} />}
      {document.summary && (
        <section className="document-summary" aria-labelledby={`${safeId(document.path)}-summary`}>
          <h3 id={`${safeId(document.path)}-summary`}>요약</h3>
          <p>{document.summary}</p>
        </section>
      )}
      <section className="document-outline" aria-labelledby={`${safeId(document.path)}-outline`}>
        <div className="document-outline-heading">
          <h3 id={`${safeId(document.path)}-outline`}>목차</h3>
          <span>{sections.length}개 섹션</span>
        </div>
        {sections.length === 0 ? (
          <p className="document-muted">Markdown heading이 없습니다.</p>
        ) : (
          <div className="document-section-list">
            {sections.map((section) => (
              <details className="document-section" key={section.id}>
                <summary>
                  <span className="disclosure-chevron" aria-hidden="true">
                    ›
                  </span>
                  <span className="document-section-label">
                    <strong>{section.title}</strong>
                    {section.subheadings.length > 0 && (
                      <span
                        className="document-subheading-list"
                        title={section.subheadings.map((heading) => heading.text).join(" · ")}
                      >
                        {section.subheadings.map((heading) => heading.text).join(" · ")}
                      </span>
                    )}
                  </span>
                  <small>{section.line}행</small>
                </summary>
                <div className="document-section-body">
                  {section.markdown === "" ? (
                    <p className="document-muted">이 section에는 별도 본문이 없습니다.</p>
                  ) : (
                    <SafeMarkdown markdown={section.markdown} />
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
      <DocumentSource {...props} />
    </article>
  );
}

function TasksDocumentView(props: DocumentViewProps): React.JSX.Element {
  const { document } = props;
  const overview = document.tasks;
  if (!overview) return <DocsDocumentView {...props} />;
  const currentIds = new Set(overview.inProgress.map((task) => task.id));
  if (overview.nextTask) currentIds.add(overview.nextTask.id);
  const regularPending = overview.pending.filter(
    (task) => !currentIds.has(task.id) && !task.postMvp,
  );
  const postMvp = overview.postMvp.filter((task) => !currentIds.has(task.id));
  return (
    <article className="document-content tasks-content">
      <DocumentHeader {...props} />
      {document.warnings.length > 0 && <DocumentWarnings warnings={document.warnings} />}
      <div className="task-metrics" aria-label="작업 현황">
        <TaskMetric label="진행 중" value={overview.inProgress.length} tone="active" />
        <TaskMetric label="대기" value={overview.pending.length} tone="pending" />
        <TaskMetric label="보류" value={overview.deferred.length} tone="deferred" />
        <TaskMetric label="완료" value={overview.completed.length} tone="complete" />
        <TaskMetric label="MVP 이후" value={overview.postMvp.length} tone="future" />
      </div>
      <TaskGroup title="진행 중" tasks={overview.inProgress} empty="진행 중인 작업이 없습니다." />
      <TaskGroup
        title="다음 작업"
        tasks={overview.nextTask ? [overview.nextTask] : []}
        empty="명시된 다음 작업이 없습니다."
      />
      <TaskGroup title="대기 작업" tasks={regularPending} empty="일반 대기 작업이 없습니다." />
      <TaskGroup title="보류" tasks={overview.deferred} empty="보류된 작업이 없습니다." />
      <TaskGroup title="MVP 이후" tasks={postMvp} empty="MVP 이후 후보가 없습니다." />
      <details className="completed-task-group">
        <summary>완료 작업 {overview.completed.length}개</summary>
        <TaskGroup title="완료" tasks={overview.completed} />
      </details>
      <DocumentSource {...props} />
    </article>
  );
}

function DocumentHeader(props: DocumentViewProps): React.JSX.Element {
  const { document } = props;
  return (
    <header className="document-header">
      <div className="document-header-main">
        <span className="eyebrow">{document.kind === "tasks" ? "TASKS" : "MARKDOWN"}</span>
        <h2>{document.title}</h2>
        <p>
          <span>{document.path}</span>
          <span>{formatBytes(document.sizeBytes)}</span>
          <span>{formatDate(document.modifiedAt)}</span>
          <span title="문서 revision">rev {document.revision.slice(0, 8)}</span>
        </p>
        <div
          className="document-open-actions"
          role="group"
          aria-label="현재 문서를 새 Pane에서 열기"
        >
          <button
            type="button"
            disabled={!props.mutationAllowed}
            onClick={() => void props.onOpenInNewPane(document.path, "horizontal")}
          >
            <span aria-hidden="true">→</span> 오른쪽에 열기
          </button>
          <button
            type="button"
            disabled={!props.mutationAllowed}
            onClick={() => void props.onOpenInNewPane(document.path, "vertical")}
          >
            <span aria-hidden="true">↓</span> 아래에 열기
          </button>
          <button
            type="button"
            disabled={!props.mutationAllowed}
            onClick={() => void props.onEditInFiles(document.path, "horizontal")}
          >
            <span aria-hidden="true">✎</span> Files에서 편집
          </button>
        </div>
      </div>
    </header>
  );
}

function DocumentSource({
  document,
  sourceOpen,
  onToggleSource,
}: DocumentViewProps): React.JSX.Element {
  return (
    <section className="document-source">
      <button type="button" aria-expanded={sourceOpen} onClick={onToggleSource}>
        {sourceOpen ? "원문 접기" : "원문 보기"}
      </button>
      {sourceOpen && <pre tabIndex={0}>{document.source}</pre>}
    </section>
  );
}

function DocumentWarnings({
  warnings,
}: {
  warnings: DocumentContent["warnings"];
}): React.JSX.Element {
  return (
    <div className="document-warning" role="status">
      {warnings.map((warning) => (
        <p key={warning}>
          {warning === "MARKDOWN_UNCLOSED_FENCE"
            ? "닫히지 않은 Markdown 코드 블록이 있어 목차 일부가 생략될 수 있습니다."
            : "지원하는 작업 heading을 찾지 못해 원문 보기만 제공할 수 있습니다."}
        </p>
      ))}
    </div>
  );
}

function TaskMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}): React.JSX.Element {
  return (
    <div data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TaskGroup({
  title,
  tasks,
  empty,
}: {
  title: string;
  tasks: TaskItem[];
  empty?: string;
}): React.JSX.Element {
  return (
    <section className="task-group">
      <h3>{title}</h3>
      {tasks.length === 0 ? (
        empty ? (
          <p className="document-muted">{empty}</p>
        ) : null
      ) : (
        <div className="task-list">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskCard({ task }: { task: TaskItem }): React.JSX.Element {
  const hasDetails = Boolean(
    task.scope ||
    task.prerequisites ||
    task.deliverables ||
    task.completionCriteria.length > 0 ||
    task.records.length > 0,
  );
  return (
    <details
      className="task-card"
      data-status={task.status}
      data-next={task.next ? "true" : undefined}
    >
      <summary>
        <span className="task-status-mark" aria-hidden="true">
          {taskStatusMark(task)}
        </span>
        <span className="sr-only">{taskStatusLabel(task)}</span>
        <div>
          <strong>{task.id}</strong>
          <h4>{task.title}</h4>
        </div>
        {task.postMvp && <span className="task-future-badge">MVP 이후</span>}
        <span className="disclosure-chevron task-disclosure-chevron" aria-hidden="true">
          ›
        </span>
      </summary>
      <div className="task-card-body">
        {!hasDetails && <p className="document-muted">기록된 상세 내용이 없습니다.</p>}
        {task.scope && (
          <section className="task-detail">
            <h5>범위</h5>
            <p>{task.scope}</p>
          </section>
        )}
        {task.prerequisites && (
          <section className="task-detail">
            <h5>선행 조건</h5>
            <p>{task.prerequisites}</p>
          </section>
        )}
        {task.deliverables && (
          <section className="task-detail">
            <h5>산출물</h5>
            <p>{task.deliverables}</p>
          </section>
        )}
        {task.completionCriteria.length > 0 && (
          <section className="task-detail">
            <h5>완료 조건 {task.completionCriteria.length}개</h5>
            <ul>
              {task.completionCriteria.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </section>
        )}
        {task.records.length > 0 && (
          <section className="task-detail">
            <h5>진행·검증 기록 {task.records.length}개</h5>
            <ul>
              {task.records.map((record, index) => (
                <li key={index}>{record}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </details>
  );
}

function taskStatusMark(task: TaskItem): string {
  if (task.status === "completed") return "✓";
  if (task.status === "in_progress") return "–";
  if (task.status === "deferred") return "~";
  return task.next ? "→" : "○";
}

function taskStatusLabel(task: TaskItem): string {
  if (task.status === "completed") return "완료";
  if (task.status === "in_progress") return "진행 중";
  if (task.status === "deferred") return "보류";
  return task.next ? "다음 작업" : "대기";
}

function DocumentMessage({
  title,
  description,
}: {
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <section className="document-message">
      <span aria-hidden="true">▤</span>
      <h2>{title}</h2>
      <p>{description}</p>
    </section>
  );
}

function documentErrorMessage(cause: unknown): string {
  if (cause instanceof ApiFailure) {
    switch (cause.code) {
      case "DOCS_FILE_TOO_LARGE":
        return "파일이 1 MiB 표시 상한을 넘었습니다. 터미널이나 로컬 편집기에서 확인해 주세요.";
      case "DOCS_PERMISSION_DENIED":
        return "Mac mini에서 이 문서의 읽기 권한을 확인해 주세요.";
      case "DOCS_OUTSIDE_ROOT":
        return "프로젝트 문서 경계를 벗어나는 심볼릭 링크나 경로는 열 수 없습니다.";
      case "DOCS_FILE_MISSING":
        return "파일이 이동되거나 삭제되었습니다. 문서 목록을 새로고침해 주세요.";
      case "DOCS_LIMIT_EXCEEDED":
        return "문서 개수 또는 폴더 깊이가 안전한 탐색 상한을 넘었습니다.";
      default:
        return cause.message;
    }
  }
  return cause instanceof Error ? cause.message : "문서를 처리하지 못했습니다.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function safeId(path: string): string {
  return path.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}
