import type {
  FileAssistantMerge,
  FileDraft,
  Pane,
  ProjectFileContent,
  ProjectFileEntry,
  SplitDirection,
} from "@naru/contracts";
import {
  fileConflictAssistantPrompt,
  renderResolvedSegments,
  threeWayMerge,
  type MergeConflictResolution,
  type ThreeWayMergeResult,
} from "@naru/domain/three-way-merge";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiFailure, type NaruApi } from "./api";
import type { TerminalConnection } from "./terminal-connection";

interface FilesPaneProps {
  pane: Pane;
  panes: readonly Pane[];
  active: boolean;
  panelId: string;
  tabPanel: boolean;
  api: NaruApi;
  connection: TerminalConnection | null;
  mutationAllowed: boolean;
  toolbarExtras?: ReactNode;
  onActivate: () => void;
  onActivatePane: (paneId: string) => void;
  onFocus?: () => void;
  onClose: () => Promise<boolean>;
  onOpenDocument: (
    path: string,
    kind: "docs" | "tasks",
    direction: SplitDirection,
  ) => Promise<void>;
  onViewStateChange: (pane: Pane) => void;
}

interface ConflictState {
  readonly result: ThreeWayMergeResult;
  readonly current: ProjectFileContent;
  readonly mine: string;
  readonly base: string;
}

type AssistantMergePhase = "waiting" | "running" | "interaction-required" | "checking";
type AssistantMergeOutcome = "completed" | "failed";

interface AssistantMergeRequestState {
  readonly merge: FileAssistantMerge;
  readonly path: string;
  readonly baseRevision: string | null;
  readonly base: string;
  readonly mine: string;
  readonly sensitive: boolean;
  readonly phase: AssistantMergePhase;
}

interface AssistantMergeReview {
  readonly paneTitle: string;
  readonly mine: string;
  readonly previousDisk: string;
  readonly outcome: AssistantMergeOutcome;
}

export function FilesPane(props: FilesPaneProps): React.JSX.Element {
  const { api, onViewStateChange, pane } = props;
  const [listings, setListings] = useState<Record<string, ProjectFileEntry[]>>({});
  const [expanded, setExpanded] = useState(() => new Set(pane.viewState.expandedDirectories));
  const [navigationOpen, setNavigationOpen] = useState(pane.viewState.navigationOpen);
  const [selectedPath, setSelectedPath] = useState(pane.viewState.selectedDocumentPath);
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [baseSource, setBaseSource] = useState("");
  const [source, setSource] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sensitivePath, setSensitivePath] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, MergeConflictResolution>>({});
  const [newPath, setNewPath] = useState("");
  const [saveAsPath, setSaveAsPath] = useState("");
  const [codexPaneId, setCodexPaneId] = useState("");
  const [assistantNotice, setAssistantNotice] = useState<string | null>(null);
  const [assistantRequest, setAssistantRequest] = useState<AssistantMergeRequestState | null>(null);
  const [assistantReview, setAssistantReview] = useState<AssistantMergeReview | null>(null);
  const [assistantSubmitting, setAssistantSubmitting] = useState(false);
  const paneElement = useRef<HTMLElement>(null);
  const assistantCheck = useRef<string | null>(null);
  const sequence = useRef(0);
  const initialSelectedPath = useRef(pane.viewState.selectedDocumentPath);
  const dirty = selectedPath !== null && (source !== baseSource || baseRevision === null);

  const codexPanes = useMemo(
    () =>
      props.panes.filter(
        (candidate) => candidate.kind === "codex" && candidate.status === "running",
      ),
    [props.panes],
  );
  const availableCodexPanes = useMemo(
    () =>
      codexPanes.filter(
        (candidate) =>
          candidate.activity.state !== "running" &&
          candidate.activity.state !== "interaction-required",
      ),
    [codexPanes],
  );
  const selectedCodexPane =
    availableCodexPanes.find((candidate) => candidate.id === codexPaneId) ??
    availableCodexPanes.find((candidate) => candidate.title === "Main Codex") ??
    availableCodexPanes[0] ??
    null;

  const loadDirectory = useCallback(
    async (path: string): Promise<void> => {
      try {
        const listing = await api.files(pane.projectId, path);
        setListings((current) => ({ ...current, [path]: listing.entries }));
      } catch (cause) {
        setError(fileErrorMessage(cause));
      }
    },
    [api, pane.projectId],
  );

  const acceptContent = useCallback((content: ProjectFileContent, nextSource = content.source) => {
    setSelectedPath(content.path);
    setBaseRevision(content.revision);
    setBaseSource(content.source);
    setSource(nextSource);
    setSensitive(content.sensitive);
    setDraftStatus(nextSource !== content.source ? "saving" : "idle");
    setSensitivePath(null);
    setConflict(null);
    setResolutions({});
    setAssistantRequest(null);
    setAssistantReview(null);
    setAssistantNotice(null);
    setError(null);
  }, []);

  const persistSelection = useCallback(
    async (path: string | null): Promise<void> => {
      const updated = await api.updatePaneViewState(pane.id, { selectedDocumentPath: path });
      onViewStateChange(updated);
    },
    [api, onViewStateChange, pane.id],
  );

  const closeCompactNavigation = useCallback((): void => {
    if (!navigationOpen || (paneElement.current?.clientWidth ?? Number.POSITIVE_INFINITY) > 560) {
      return;
    }
    setNavigationOpen(false);
    void api
      .updatePaneViewState(pane.id, { navigationOpen: false })
      .then(onViewStateChange)
      .catch((cause) => setError(fileErrorMessage(cause)));
  }, [api, navigationOpen, onViewStateChange, pane.id]);

  const openFile = useCallback(
    async (path: string, allowSensitive = false): Promise<void> => {
      if (dirty && path !== selectedPath) {
        setError("현재 초안을 저장하거나 버린 뒤 다른 파일을 열어 주세요.");
        return;
      }
      closeCompactNavigation();
      const request = ++sequence.current;
      setLoading(true);
      setError(null);
      try {
        const content = await api.file(pane.projectId, path, allowSensitive);
        if (request !== sequence.current) return;
        await persistSelection(path);
        if (request !== sequence.current) return;
        acceptContent(content);
      } catch (cause) {
        if (request !== sequence.current) return;
        if (cause instanceof ApiFailure && cause.code === "FILE_SENSITIVE_CONFIRMATION_REQUIRED") {
          setSensitivePath(path);
          setError(null);
        } else {
          setError(fileErrorMessage(cause));
        }
      } finally {
        if (request === sequence.current) setLoading(false);
      }
    },
    [
      acceptContent,
      api,
      closeCompactNavigation,
      dirty,
      pane.projectId,
      persistSelection,
      selectedPath,
    ],
  );

  const reconcileDraft = useCallback(
    async (draft: FileDraft): Promise<void> => {
      setSensitive(draft.sensitive);
      setSelectedPath(draft.path);
      setBaseRevision(draft.baseRevision);
      setBaseSource(draft.baseSource);
      setSource(draft.draftSource);
      setDraftStatus("saved");
      await persistSelection(draft.path);
      if (draft.baseRevision === null) return;

      if (draft.assistantMerge) {
        const requestedResult = threeWayMerge(
          draft.baseSource,
          draft.draftSource,
          draft.assistantMerge.current.source,
        );
        if (requestedResult.status === "conflict") {
          setConflict({
            result: requestedResult,
            current: draft.assistantMerge.current,
            mine: draft.draftSource,
            base: draft.baseSource,
          });
          setAssistantRequest({
            merge: draft.assistantMerge,
            path: draft.path,
            baseRevision: draft.baseRevision,
            base: draft.baseSource,
            mine: draft.draftSource,
            sensitive: draft.sensitive,
            phase: "waiting",
          });
          return;
        }
        if (requestedResult.source !== null) {
          acceptContent(draft.assistantMerge.current, requestedResult.source);
          setDraftStatus("saving");
          return;
        }
      }

      try {
        const current = await api.file(pane.projectId, draft.path, draft.sensitive);
        if (current.revision === draft.baseRevision) return;
        const result = threeWayMerge(draft.baseSource, draft.draftSource, current.source);
        if (result.status === "merged" && result.source !== null) {
          acceptContent(current, result.source);
        } else {
          setConflict({ result, current, mine: draft.draftSource, base: draft.baseSource });
        }
      } catch (cause) {
        setError(fileErrorMessage(cause));
      }
    },
    [acceptContent, api, pane.projectId, persistSelection],
  );

  useEffect(() => {
    let cancelled = false;
    const start = async (): Promise<void> => {
      setLoading(true);
      await loadDirectory("");
      if (cancelled) return;
      try {
        const draft = await api.fileDraft(pane.id);
        if (cancelled) return;
        if (draft) await reconcileDraft(draft);
        else if (initialSelectedPath.current) {
          try {
            const content = await api.file(pane.projectId, initialSelectedPath.current);
            if (!cancelled) {
              await persistSelection(content.path);
              if (!cancelled) acceptContent(content);
            }
          } catch (cause) {
            if (
              !cancelled &&
              cause instanceof ApiFailure &&
              cause.code === "FILE_SENSITIVE_CONFIRMATION_REQUIRED"
            ) {
              setSensitivePath(initialSelectedPath.current);
            } else if (!cancelled) setError(fileErrorMessage(cause));
          }
        }
      } catch (cause) {
        if (!cancelled) setError(fileErrorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void start();
    return () => {
      cancelled = true;
      sequence.current += 1;
    };
  }, [
    acceptContent,
    api,
    loadDirectory,
    pane.id,
    pane.projectId,
    persistSelection,
    reconcileDraft,
  ]);

  useEffect(() => {
    if (!dirty || !selectedPath || conflict) return;
    const timer = window.setTimeout(() => {
      void api
        .saveFileDraft(pane.id, {
          path: selectedPath,
          baseRevision,
          draftSource: source,
          allowSensitive: sensitive,
          assistantMerge: null,
        })
        .then(() => setDraftStatus("saved"))
        .catch((cause) => {
          setDraftStatus("error");
          setError(fileErrorMessage(cause));
        });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [api, baseRevision, conflict, dirty, pane.id, selectedPath, sensitive, source]);

  const updateExpanded = (path: string, open: boolean): void => {
    const next = new Set(expanded);
    if (open) {
      next.add(path);
      if (listings[path] === undefined) void loadDirectory(path);
    } else next.delete(path);
    setExpanded(next);
    void api
      .updatePaneViewState(pane.id, { expandedDirectories: [...next] })
      .then(props.onViewStateChange)
      .catch((cause) => setError(fileErrorMessage(cause)));
  };

  const save = async (
    path = selectedPath,
    revision = baseRevision,
    value = source,
  ): Promise<void> => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const saved = await api.saveFile(pane.projectId, {
        path,
        source: value,
        expectedRevision: revision,
        allowSensitive: sensitive || isSensitiveName(path),
      });
      acceptContent(saved);
      await api.deleteFileDraft(pane.id);
      setDraftStatus("idle");
      await persistSelection(path);
      await loadDirectory(parentPath(path));
    } catch (cause) {
      if (
        cause instanceof ApiFailure &&
        cause.code === "FILE_CONFLICT" &&
        selectedPath &&
        path === selectedPath
      ) {
        try {
          const current = await api.file(pane.projectId, selectedPath, sensitive);
          const result = threeWayMerge(baseSource, source, current.source);
          if (result.status === "merged" && result.source !== null) {
            acceptContent(current, result.source);
            setDraftStatus("saving");
          } else {
            setConflict({ result, current, mine: source, base: baseSource });
            setResolutions({});
          }
        } catch (readCause) {
          setError(fileErrorMessage(readCause));
        }
      } else setError(fileErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const discard = async (): Promise<void> => {
    setSource(baseSource);
    setConflict(null);
    setDraftStatus("idle");
    await api.deleteFileDraft(pane.id).catch((cause) => setError(fileErrorMessage(cause)));
  };

  const createFile = (): void => {
    const path = normalizeInputPath(newPath);
    if (!path) {
      setError("새 파일의 프로젝트 상대 경로를 입력해 주세요.");
      return;
    }
    if (dirty) {
      setError("현재 초안을 저장하거나 버린 뒤 새 파일을 만들어 주세요.");
      return;
    }
    setSelectedPath(path);
    setBaseRevision(null);
    setBaseSource("");
    setSource("");
    setSensitive(isSensitiveName(path));
    setConflict(null);
    setNewPath("");
    setError(null);
    closeCompactNavigation();
  };

  const applyResolutions = (fallback?: MergeConflictResolution): void => {
    if (!conflict) return;
    const selected = Object.fromEntries(
      conflict.result.conflicts.map((item) => [item.id, resolutions[item.id] ?? fallback]),
    ) as Record<string, MergeConflictResolution>;
    const resolved = renderResolvedSegments(conflict.result.segments, selected);
    if (resolved === null) {
      setError("모든 충돌 구간에서 사용할 내용을 선택해 주세요.");
      return;
    }
    acceptContent(conflict.current, resolved);
  };

  const inspectAssistantResult = useCallback(
    async (request: AssistantMergeRequestState, outcome: AssistantMergeOutcome): Promise<void> => {
      if (assistantCheck.current === request.merge.requestedAt) return;
      assistantCheck.current = request.merge.requestedAt;
      setAssistantRequest((current) =>
        current?.merge.requestedAt === request.merge.requestedAt
          ? { ...current, phase: "checking" }
          : current,
      );
      try {
        const current = await api.file(pane.projectId, request.path, request.sensitive);
        if (current.revision === request.merge.current.revision) {
          await api.saveFileDraft(pane.id, {
            path: request.path,
            baseRevision: request.baseRevision,
            draftSource: request.mine,
            allowSensitive: request.sensitive,
            assistantMerge: null,
          });
          const result = threeWayMerge(request.base, request.mine, request.merge.current.source);
          if (result.status === "conflict") {
            setConflict({
              result,
              current: request.merge.current,
              mine: request.mine,
              base: request.base,
            });
          }
          setAssistantRequest(null);
          setAssistantNotice(
            outcome === "completed"
              ? "Codex 작업은 끝났지만 대상 파일은 바뀌지 않았습니다. Codex 답변을 확인하거나 다른 병합 방법을 선택해 주세요."
              : "Codex 작업이 중단됐고 대상 파일도 바뀌지 않았습니다. 다른 Codex Pane이나 직접 병합을 사용해 주세요.",
          );
          return;
        }

        await api.deleteFileDraft(pane.id);
        const paneTitle =
          props.panes.find((candidate) => candidate.id === request.merge.paneId)?.title ?? "Codex";
        acceptContent(current);
        setDraftStatus("idle");
        setAssistantReview({
          paneTitle,
          mine: request.mine,
          previousDisk: request.merge.current.source,
          outcome,
        });
      } catch (cause) {
        setError(fileErrorMessage(cause));
      } finally {
        if (assistantCheck.current === request.merge.requestedAt) assistantCheck.current = null;
      }
    },
    [acceptContent, api, pane.id, pane.projectId, props.panes],
  );

  const trackedAssistantPane = assistantRequest
    ? props.panes.find((candidate) => candidate.id === assistantRequest.merge.paneId)
    : undefined;

  useEffect(() => {
    if (!assistantRequest) return;
    const timer = window.setTimeout(() => {
      if (!trackedAssistantPane || trackedAssistantPane.status !== "running") {
        void inspectAssistantResult(assistantRequest, "failed");
        return;
      }
      const activity = trackedAssistantPane.activity;
      if (activity.eventId === assistantRequest.merge.initialActivityEventId) return;
      if (activity.state === "running") {
        setAssistantRequest((current) =>
          current?.merge.requestedAt === assistantRequest.merge.requestedAt &&
          current.phase !== "running"
            ? { ...current, phase: "running" }
            : current,
        );
        return;
      }
      if (activity.state === "interaction-required") {
        setAssistantRequest((current) =>
          current?.merge.requestedAt === assistantRequest.merge.requestedAt &&
          current.phase !== "interaction-required"
            ? { ...current, phase: "interaction-required" }
            : current,
        );
        return;
      }
      if (activity.state === "completed" || activity.state === "idle") {
        void inspectAssistantResult(assistantRequest, "completed");
        return;
      }
      if (
        activity.state === "failed" ||
        activity.state === "canceled" ||
        activity.state === "server-stopped"
      ) {
        void inspectAssistantResult(assistantRequest, "failed");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [assistantRequest, inspectAssistantResult, trackedAssistantPane]);

  const sendToCodex = async (): Promise<void> => {
    if (!conflict || !selectedPath || !selectedCodexPane) {
      setAssistantNotice(
        codexPanes.length === 0
          ? "실행 중인 Codex Pane이 없습니다. Codex Pane을 시작한 뒤 다시 시도해 주세요."
          : "모든 Codex Pane이 다른 작업 중입니다. 작업이 끝나면 자동으로 선택할 수 있습니다.",
      );
      return;
    }
    if (
      sensitive &&
      !window.confirm("민감할 수 있는 파일의 patch를 선택한 Codex Pane에 전달할까요?")
    ) {
      return;
    }
    setAssistantSubmitting(true);
    setAssistantNotice(null);
    const prompt = fileConflictAssistantPrompt(
      selectedPath,
      conflict.base,
      conflict.mine,
      conflict.current.source,
    );
    if (prompt.length > 60_000) {
      setAssistantNotice(
        "충돌 patch가 너무 커 자동 전달할 수 없습니다. 직접 충돌 해결을 사용해 주세요.",
      );
      setAssistantSubmitting(false);
      return;
    }
    try {
      const draft = await api.saveFileDraft(pane.id, {
        path: selectedPath,
        baseRevision,
        draftSource: conflict.mine,
        allowSensitive: sensitive,
        assistantMerge: {
          paneId: selectedCodexPane.id,
          initialActivityEventId: selectedCodexPane.activity.eventId,
          currentRevision: conflict.current.revision,
        },
      });
      if (!draft.assistantMerge) throw new Error("Codex 병합 요청 상태를 보존하지 못했습니다.");
      const request: AssistantMergeRequestState = {
        merge: draft.assistantMerge,
        path: draft.path,
        baseRevision: draft.baseRevision,
        base: draft.baseSource,
        mine: draft.draftSource,
        sensitive: draft.sensitive,
        phase: "waiting",
      };
      setAssistantRequest(request);
      const sent =
        props.connection?.input(
          selectedCodexPane.id,
          `\u001b[200~${fileConflictAssistantPrompt(
            selectedPath,
            conflict.base,
            conflict.mine,
            draft.assistantMerge.current.source,
          )}\u001b[201~\r`,
        ) ?? false;
      if (!sent) {
        await api.saveFileDraft(pane.id, {
          path: selectedPath,
          baseRevision,
          draftSource: conflict.mine,
          allowSensitive: sensitive,
          assistantMerge: null,
        });
        setAssistantRequest(null);
        setAssistantNotice(
          "터미널 제어 연결이 활성 상태가 아닙니다. 제어권을 복구한 뒤 다시 시도해 주세요.",
        );
        return;
      }
      props.onActivate();
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.code === "FILE_CONFLICT") {
        try {
          const current = await api.file(pane.projectId, selectedPath, sensitive);
          const result = threeWayMerge(conflict.base, conflict.mine, current.source);
          if (result.status === "merged" && result.source !== null) {
            acceptContent(current, result.source);
            setDraftStatus("saving");
          } else {
            setConflict({ ...conflict, result, current });
            setResolutions({});
            setAssistantNotice(
              "요청 직전에 디스크가 다시 바뀌어 비교 내용을 갱신했습니다. 확인 후 다시 요청해 주세요.",
            );
          }
        } catch (readCause) {
          setError(fileErrorMessage(readCause));
        }
      } else setError(fileErrorMessage(cause));
    } finally {
      setAssistantSubmitting(false);
    }
  };

  const copyDraft = async (): Promise<void> => {
    if (!conflict) return;
    try {
      await navigator.clipboard.writeText(conflict.mine);
      setAssistantNotice("내 초안을 클립보드에 복사했습니다.");
    } catch {
      setAssistantNotice("브라우저가 클립보드 쓰기를 허용하지 않았습니다.");
    }
  };

  return (
    <section
      className={`files-pane pane-surface ${props.active ? "is-active" : ""}`}
      id={props.panelId}
      role={props.tabPanel ? "tabpanel" : "region"}
      aria-label={`${pane.title} 프로젝트 파일`}
      tabIndex={-1}
      data-pane-id={pane.id}
      data-pane-kind="files"
      data-active={props.active}
      ref={paneElement}
      onPointerDown={props.onActivate}
      onFocusCapture={props.onFocus ?? props.onActivate}
    >
      <header className="pane-toolbar">
        <div className="pane-identity">
          <span className="files-glyph" aria-hidden="true">
            ◇
          </span>
          <div>
            <strong>{pane.title}</strong>
            <span>{selectedPath ?? "프로젝트 파일 탐색"}</span>
          </div>
        </div>
        <div className="pane-actions">
          <span
            className={`status-pill ${dirty || assistantReview ? "status-running" : "status-ready"}`}
            role="status"
          >
            <span aria-hidden="true" />{" "}
            {dirty ? draftLabel(draftStatus) : assistantReview ? "Codex 결과 검토" : "저장됨"}
          </span>
          <button
            className="icon-button files-navigation-toggle"
            type="button"
            aria-label={navigationOpen ? "파일 탐색기 접기" : "파일 탐색기 펼치기"}
            aria-expanded={navigationOpen}
            onClick={() => {
              const next = !navigationOpen;
              setNavigationOpen(next);
              void api
                .updatePaneViewState(pane.id, { navigationOpen: next })
                .then(props.onViewStateChange);
            }}
          >
            ☷
          </button>
          {props.toolbarExtras}
          <button
            className="icon-button files-refresh"
            type="button"
            aria-label="파일 목록 새로고침"
            onClick={() => void loadDirectory("")}
          >
            ↻
          </button>
          <button
            className="icon-button danger-hover"
            type="button"
            aria-label={`${pane.title} 닫기`}
            disabled={!props.mutationAllowed}
            onClick={() => {
              if (
                dirty &&
                !window.confirm("저장하지 않은 메모리 초안을 버리고 Files Pane을 닫을까요?")
              ) {
                return;
              }
              void props.onClose();
            }}
          >
            ×
          </button>
        </div>
      </header>

      <div className="files-pane-body" data-navigation-open={navigationOpen}>
        {navigationOpen && (
          <nav className="files-navigation" aria-label="프로젝트 파일 탐색기">
            <form
              className="files-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                createFile();
              }}
            >
              <label htmlFor={`new-file-${pane.id}`}>새 파일</label>
              <div>
                <input
                  id={`new-file-${pane.id}`}
                  value={newPath}
                  onChange={(event) => setNewPath(event.target.value)}
                  placeholder="src/new.ts"
                  autoComplete="off"
                />
                <button type="submit">만들기</button>
              </div>
            </form>
            <FileTree
              path=""
              listings={listings}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggle={updateExpanded}
              onSelect={(path) => void openFile(path)}
            />
          </nav>
        )}

        <main className="file-editor" aria-busy={loading}>
          {error && (
            <div className="file-alert" role="alert">
              {error}
            </div>
          )}
          {sensitivePath ? (
            <section className="file-empty sensitive-file-confirmation">
              <span aria-hidden="true">!</span>
              <h2>민감할 수 있는 파일입니다</h2>
              <p>
                {sensitivePath} 내용은 화면과 메모리 초안에만 두며 구조화 로그나 DB에 저장하지
                않습니다.
              </p>
              <button type="button" onClick={() => void openFile(sensitivePath, true)}>
                내용 열기
              </button>
            </section>
          ) : conflict ? (
            <ConflictEditor
              conflict={conflict}
              resolutions={resolutions}
              onResolve={(id, resolution) =>
                setResolutions((current) => ({ ...current, [id]: resolution }))
              }
              onApply={() => applyResolutions()}
              onEditMine={() => applyResolutions("mine")}
              onForce={() => {
                if (window.confirm("현재 디스크 revision을 기준으로 내 초안 내용을 저장할까요?")) {
                  void save(selectedPath, conflict.current.revision, conflict.mine);
                }
              }}
              onCopyDraft={() => void copyDraft()}
              saveAsPath={saveAsPath}
              onSaveAsPath={setSaveAsPath}
              onSaveAs={() => {
                const path = normalizeInputPath(saveAsPath);
                if (path) void save(path, null, conflict.mine);
              }}
              codexPanes={codexPanes}
              codexPaneId={assistantRequest?.merge.paneId ?? selectedCodexPane?.id ?? ""}
              onCodexPane={setCodexPaneId}
              onSendToCodex={() => void sendToCodex()}
              onOpenCodexPane={props.onActivatePane}
              assistantRequest={assistantRequest}
              assistantSubmitting={assistantSubmitting}
              assistantNotice={assistantNotice}
            />
          ) : selectedPath ? (
            <>
              {assistantReview && (
                <AssistantMergeReviewBanner
                  review={assistantReview}
                  onDismiss={() => setAssistantReview(null)}
                />
              )}
              <div className="file-editor-header">
                <div>
                  <strong>{selectedPath}</strong>
                  <span>{baseRevision ? `rev ${baseRevision.slice(0, 8)}` : "새 파일"}</span>
                  {sensitive && <em>민감 파일</em>}
                  {dirty && <span>서버 재시작 시 초안 삭제</span>}
                </div>
                <div className="file-editor-actions">
                  {isStructuredDocument(selectedPath) && (
                    <button
                      type="button"
                      disabled={!props.mutationAllowed}
                      onClick={() =>
                        void props.onOpenDocument(
                          selectedPath,
                          selectedPath.endsWith("TASKS.md") ? "tasks" : "docs",
                          "horizontal",
                        )
                      }
                    >
                      구조화 보기
                    </button>
                  )}
                  <button type="button" disabled={!dirty || loading} onClick={() => void discard()}>
                    초안 버리기
                  </button>
                  <button
                    className="primary-button compact"
                    type="button"
                    disabled={!dirty || loading}
                    onClick={() => void save()}
                  >
                    저장
                  </button>
                </div>
              </div>
              <label className="sr-only" htmlFor={`file-source-${pane.id}`}>
                {selectedPath} 편집
              </label>
              <textarea
                id={`file-source-${pane.id}`}
                className="file-source-editor"
                value={source}
                spellCheck={false}
                onChange={(event) => {
                  setSource(event.target.value);
                  setDraftStatus("saving");
                }}
              />
            </>
          ) : (
            <section className="file-empty">
              <span aria-hidden="true">◇</span>
              <h2>파일을 선택해 주세요</h2>
              <p>왼쪽 탐색기에서 UTF-8 텍스트 파일을 열거나 새 파일 경로를 입력하세요.</p>
            </section>
          )}
        </main>
      </div>
    </section>
  );
}

function FileTree({
  path,
  listings,
  expanded,
  selectedPath,
  onToggle,
  onSelect,
}: {
  path: string;
  listings: Readonly<Record<string, readonly ProjectFileEntry[]>>;
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  onToggle: (path: string, open: boolean) => void;
  onSelect: (path: string) => void;
}): React.JSX.Element {
  const entries = listings[path];
  if (!entries) return <span className="files-tree-loading">불러오는 중…</span>;
  return (
    <ul className="files-tree" data-root={path === "" ? "true" : undefined}>
      {entries.map((entry) => {
        const open = expanded.has(entry.path);
        const expandable = entry.kind === "directory" && !entry.protected && !entry.excluded;
        return (
          <li key={entry.path} data-kind={entry.kind} data-excluded={entry.excluded || undefined}>
            <button
              type="button"
              className={selectedPath === entry.path ? "is-selected" : ""}
              aria-current={selectedPath === entry.path ? "page" : undefined}
              aria-expanded={expandable ? open : undefined}
              disabled={entry.protected || entry.excluded || entry.kind === "symlink"}
              title={fileEntryTitle(entry)}
              onClick={() => {
                if (expandable) onToggle(entry.path, !open);
                else if (entry.kind === "file") onSelect(entry.path);
              }}
            >
              <span aria-hidden="true">
                {entry.kind === "directory"
                  ? open
                    ? "▾"
                    : "▸"
                  : entry.kind === "symlink"
                    ? "↗"
                    : "·"}
              </span>
              <span>{entry.name}</span>
              {entry.sensitive && <em aria-label="민감할 수 있음">!</em>}
            </button>
            {expandable && open && (
              <FileTree
                path={entry.path}
                listings={listings}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ConflictEditor({
  conflict,
  resolutions,
  onResolve,
  onApply,
  onEditMine,
  onForce,
  onCopyDraft,
  saveAsPath,
  onSaveAsPath,
  onSaveAs,
  codexPanes,
  codexPaneId,
  onCodexPane,
  onSendToCodex,
  onOpenCodexPane,
  assistantRequest,
  assistantSubmitting,
  assistantNotice,
}: {
  conflict: ConflictState;
  resolutions: Readonly<Record<string, MergeConflictResolution>>;
  onResolve: (id: string, resolution: MergeConflictResolution) => void;
  onApply: () => void;
  onEditMine: () => void;
  onForce: () => void;
  onCopyDraft: () => void;
  saveAsPath: string;
  onSaveAsPath: (path: string) => void;
  onSaveAs: () => void;
  codexPanes: readonly Pane[];
  codexPaneId: string;
  onCodexPane: (id: string) => void;
  onSendToCodex: () => void;
  onOpenCodexPane: (paneId: string) => void;
  assistantRequest: AssistantMergeRequestState | null;
  assistantSubmitting: boolean;
  assistantNotice: string | null;
}): React.JSX.Element {
  const conflictCount = conflict.result.conflicts.length;
  const resolvedCount = conflict.result.conflicts.filter(
    (item) => resolutions[item.id] !== undefined,
  ).length;
  const remainingCount = conflictCount - resolvedCount;
  const assistantBusy = assistantRequest !== null || assistantSubmitting;
  const selectedPane = codexPanes.find((pane) => pane.id === codexPaneId) ?? null;
  const selectablePaneCount = codexPanes.filter(isCodexPaneAvailable).length;

  return (
    <section className="file-conflict" aria-labelledby="file-conflict-title">
      <header>
        <span className="eyebrow">저장 충돌</span>
        <h2 id="file-conflict-title">내 초안과 현재 디스크 변경이 겹칩니다</h2>
        <p>
          디스크 파일은 바뀌지 않았고 내 초안도 메모리에 보존되어 있습니다. 직접 고르거나 Codex에 두
          변경의 병합을 요청하세요.
        </p>
      </header>

      <section
        className="file-conflict-section"
        aria-labelledby="direct-merge-title"
        data-locked={assistantBusy || undefined}
      >
        <div className="file-conflict-section-heading">
          <div>
            <span className="file-conflict-step">방법 1</span>
            <h3 id="direct-merge-title">직접 병합</h3>
            <p>겹친 구간마다 어떤 내용을 남길지 선택합니다.</p>
            {assistantBusy && (
              <p className="file-conflict-locked-note">
                Codex 병합을 추적하는 동안에는 동시에 직접 저장하지 않습니다.
              </p>
            )}
          </div>
          <p className="file-conflict-progress" role="status">
            {remainingCount === 0
              ? `${conflictCount}개 선택 완료`
              : `${conflictCount}개 중 ${resolvedCount}개 선택 · ${remainingCount}개 남음`}
          </p>
        </div>

        <div className="file-conflict-list">
          {conflict.result.conflicts.map((item, index) => {
            const selected = resolutions[item.id];
            return (
              <article key={item.id} className="file-conflict-hunk">
                <div className="file-conflict-hunk-heading">
                  <h4>
                    충돌 {index + 1} · {item.startLine}–{item.endLine}행
                  </h4>
                  <span data-resolved={selected !== undefined}>
                    {selected === "mine"
                      ? "내 변경 사용"
                      : selected === "theirs"
                        ? "디스크 변경 유지"
                        : selected === "both"
                          ? "두 변경 이어 붙이기"
                          : "선택 필요"}
                  </span>
                </div>
                <div className="file-conflict-columns">
                  <ConflictVersion label="내가 편집한 내용" source={item.mine} />
                  <ConflictVersion label="디스크의 최신 내용" source={item.theirs} />
                </div>
                <details className="file-conflict-base">
                  <summary>편집 전 기준 보기</summary>
                  <ConflictVersion label="두 변경의 공통 기준" source={item.base} />
                </details>
                <div
                  className="file-conflict-choices"
                  role="group"
                  aria-label={`${item.startLine}행 충돌 선택`}
                >
                  <button
                    type="button"
                    disabled={assistantBusy}
                    aria-label="내 변경 사용"
                    aria-pressed={selected === "mine"}
                    onClick={() => onResolve(item.id, "mine")}
                  >
                    <strong>내 변경 사용</strong>
                    <small>이 구간을 내 초안으로 바꿈</small>
                  </button>
                  <button
                    type="button"
                    disabled={assistantBusy}
                    aria-label="디스크 변경 유지"
                    aria-pressed={selected === "theirs"}
                    onClick={() => onResolve(item.id, "theirs")}
                  >
                    <strong>디스크 변경 유지</strong>
                    <small>외부에서 바뀐 내용을 남김</small>
                  </button>
                  <button
                    type="button"
                    disabled={assistantBusy}
                    aria-label="두 변경 이어 붙이기"
                    aria-pressed={selected === "both"}
                    onClick={() => onResolve(item.id, "both")}
                  >
                    <strong>두 변경 이어 붙이기</strong>
                    <small>내 변경 다음에 디스크 변경을 둠</small>
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        <div className="file-conflict-review-row">
          <button
            className="primary-button compact file-conflict-review"
            type="button"
            disabled={remainingCount > 0 || assistantBusy}
            onClick={onApply}
          >
            병합 결과 검토
          </button>
          <span>바로 저장하지 않고 편집기에서 결과를 확인합니다.</span>
        </div>
      </section>

      <section
        className="file-conflict-section file-conflict-assistant"
        aria-labelledby="conflict-assistant-title"
      >
        <div className="file-conflict-section-heading">
          <div>
            <span className="file-conflict-step">방법 2</span>
            <h3 id="conflict-assistant-title">Codex로 병합</h3>
            <p>
              현재 디스크를 기준으로 양쪽의 비충돌 변경을 보존하고, 겹친 의미를 합치도록 요청합니다.
              자동 저장하거나 승인하지 않습니다.
            </p>
          </div>
        </div>
        <div className="file-conflict-assistant-actions">
          <select
            aria-label="충돌을 전달할 Codex Pane"
            value={codexPaneId}
            disabled={assistantBusy}
            onChange={(event) => onCodexPane(event.target.value)}
          >
            <option value="">사용 가능한 Codex Pane 없음</option>
            {codexPanes.map((pane) => (
              <option
                key={pane.id}
                value={pane.id}
                disabled={!isCodexPaneAvailable(pane) && pane.id !== assistantRequest?.merge.paneId}
              >
                {pane.title}
                {pane.activity.state === "running"
                  ? " · 작업 중"
                  : pane.activity.state === "interaction-required"
                    ? " · 입력 필요"
                    : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={assistantBusy || selectedPane === null || !isCodexPaneAvailable(selectedPane)}
            onClick={onSendToCodex}
          >
            {assistantSubmitting
              ? "요청 준비 중…"
              : selectedPane
                ? `${selectedPane.title}로 병합 요청`
                : "Codex로 병합 요청"}
          </button>
        </div>
        {!assistantRequest && !assistantSubmitting && selectedPane && (
          <p className="file-conflict-assistant-selection">
            {selectablePaneCount === 1
              ? `${selectedPane.title}를 자동으로 선택했습니다.`
              : `${selectedPane.title}를 기본으로 선택했습니다. 필요하면 바꿀 수 있습니다.`}
          </p>
        )}
        {!assistantRequest && !assistantSubmitting && !selectedPane && (
          <p className="file-conflict-assistant-selection" role="status">
            {codexPanes.length === 0
              ? "실행 중인 Codex Pane이 없습니다. Codex Pane을 시작하면 여기서 자동으로 선택합니다."
              : "모든 Codex Pane이 다른 작업 중입니다. 작업이 끝나면 자동으로 선택합니다."}
          </p>
        )}
        {assistantRequest && (
          <div className="file-conflict-assistant-progress" role="status" aria-live="polite">
            <div>
              <strong>{assistantPhaseTitle(assistantRequest.phase)}</strong>
              <span>{assistantPhaseDescription(assistantRequest.phase)}</span>
            </div>
            {assistantRequest.phase === "interaction-required" && (
              <button type="button" onClick={() => onOpenCodexPane(assistantRequest.merge.paneId)}>
                Codex Pane 확인
              </button>
            )}
          </div>
        )}
      </section>

      <details className="file-conflict-recovery">
        <summary>다른 복구 방법</summary>
        <div className="file-conflict-recovery-body">
          <div className="file-conflict-recovery-action">
            <div>
              <strong>내 변경을 기준으로 직접 편집</strong>
              <span>모든 겹친 구간에서 내 초안을 선택해 편집기로 돌아갑니다.</span>
            </div>
            <button type="button" disabled={assistantBusy} onClick={onEditMine}>
              편집 시작
            </button>
          </div>
          <div className="file-conflict-recovery-action">
            <div>
              <strong>내 초안 따로 보관</strong>
              <span>브라우저 클립보드에 현재 초안 전체를 복사합니다.</span>
            </div>
            <button type="button" onClick={onCopyDraft}>
              내 초안 복사
            </button>
          </div>
          <div className="file-conflict-recovery-action file-conflict-save-as">
            <div>
              <label htmlFor="conflict-save-as">다른 파일로 저장</label>
              <span>현재 파일을 건드리지 않고 내 초안을 새 경로에 저장합니다.</span>
            </div>
            <div>
              <input
                id="conflict-save-as"
                value={saveAsPath}
                disabled={assistantBusy}
                onChange={(event) => onSaveAsPath(event.target.value)}
                placeholder="src/resolved.ts"
              />
              <button type="button" disabled={assistantBusy} onClick={onSaveAs}>
                저장
              </button>
            </div>
          </div>
          <div className="file-conflict-recovery-action is-danger">
            <div>
              <strong>디스크 변경을 버리고 덮어쓰기</strong>
              <span>현재 디스크에서 바뀐 내용을 모두 잃을 수 있습니다.</span>
            </div>
            <button type="button" disabled={assistantBusy} onClick={onForce}>
              내 초안으로 덮어쓰기
            </button>
          </div>
        </div>
      </details>

      {assistantNotice && (
        <p className="file-conflict-notice" role="status">
          {assistantNotice}
        </p>
      )}
    </section>
  );
}

function AssistantMergeReviewBanner({
  review,
  onDismiss,
}: {
  review: AssistantMergeReview;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <section className="file-assistant-review" aria-labelledby="file-assistant-review-title">
      <div>
        <span className="eyebrow">
          {review.outcome === "completed" ? "Codex 병합 완료" : "Codex 변경 발견"}
        </span>
        <h2 id="file-assistant-review-title">병합 결과를 검토해 주세요</h2>
        <p>
          {review.paneTitle}가 변경한 현재 디스크 결과를 아래 편집기에 열었습니다. 새 충돌로
          취급하지 않으며, 필요하면 수정한 뒤 저장하세요.
        </p>
      </div>
      <button className="secondary-button compact" type="button" onClick={onDismiss}>
        검토 완료
      </button>
      <details>
        <summary>병합 전 두 내용 보기</summary>
        <div className="file-assistant-review-columns">
          <ConflictVersion label="내 초안" source={review.mine} />
          <ConflictVersion label="병합 전 디스크" source={review.previousDisk} />
        </div>
      </details>
    </section>
  );
}

function ConflictVersion({ label, source }: { label: string; source: string }): React.JSX.Element {
  return (
    <section>
      <strong>{label}</strong>
      <pre tabIndex={0}>{source || "(빈 내용)"}</pre>
    </section>
  );
}

function isCodexPaneAvailable(pane: Pane): boolean {
  return (
    pane.status === "running" &&
    pane.activity.state !== "running" &&
    pane.activity.state !== "interaction-required"
  );
}

function assistantPhaseTitle(phase: AssistantMergePhase): string {
  if (phase === "waiting") return "요청을 보냈습니다";
  if (phase === "running") return "Codex가 병합 중입니다";
  if (phase === "interaction-required") return "Codex가 입력을 기다립니다";
  return "병합 결과를 확인하는 중입니다";
}

function assistantPhaseDescription(phase: AssistantMergePhase): string {
  if (phase === "waiting") return "Files에 그대로 있으면 시작과 완료를 자동으로 추적합니다.";
  if (phase === "running") return "완료되면 디스크 결과를 자동으로 열어 검토 상태로 전환합니다.";
  if (phase === "interaction-required")
    return "필요할 때만 Codex Pane으로 이동하세요. 답변 뒤 결과 확인은 자동으로 이어집니다.";
  return "수동 새로고침 없이 최신 revision을 읽고 있습니다.";
}

function fileEntryTitle(entry: ProjectFileEntry): string {
  if (entry.protected) return "보호된 내부 경로";
  if (entry.excluded) return "초기 탐색에서 제외된 큰 의존성·빌드 폴더";
  if (entry.kind === "symlink") return `심볼릭 링크 (${entry.symlinkStatus ?? "확인 불가"})`;
  return entry.path;
}

function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function normalizeInputPath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}

function isStructuredDocument(path: string): boolean {
  return (
    (path.startsWith("docs/") && path.toLowerCase().endsWith(".md")) || path.endsWith("TASKS.md")
  );
}

function isSensitiveName(path: string): boolean {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === "credentials" ||
    name === "credentials.json" ||
    name === "secrets.json" ||
    /\.(?:pem|key|p12|pfx|mobileprovision)$/.test(name)
  );
}

function draftLabel(status: "idle" | "saving" | "saved" | "error"): string {
  if (status === "saving") return "메모리 초안 저장 중";
  if (status === "saved") return "메모리 초안 보존됨";
  if (status === "error") return "초안 보존 실패";
  return "저장 안 됨";
}

function fileErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiFailure))
    return cause instanceof Error ? cause.message : "파일을 처리하지 못했습니다.";
  switch (cause.code) {
    case "FILE_OUTSIDE_ROOT":
      return "프로젝트 경계를 벗어나는 경로나 심볼릭 링크는 열 수 없습니다.";
    case "FILE_PERMISSION_DENIED":
      return "Mac mini에서 이 파일이나 폴더의 권한을 확인해 주세요.";
    case "FILE_MISSING":
      return "파일이나 폴더가 이동 또는 삭제되었습니다. 탐색기를 새로고침해 주세요.";
    case "FILE_TOO_LARGE":
      return "파일이 1 MiB 편집 상한을 넘었습니다.";
    case "FILE_BINARY":
      return "binary 또는 유효하지 않은 UTF-8 파일은 편집할 수 없습니다.";
    case "FILE_LIMIT_EXCEEDED":
      return "파일 탐색 또는 메모리 초안 상한을 넘었습니다.";
    case "FILE_PROTECTED":
      return "보호된 Git 내부 경로나 심볼릭 링크는 Files Pane에서 열 수 없습니다.";
    default:
      return cause.message;
  }
}
