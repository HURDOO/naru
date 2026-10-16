import type { AgentTask } from "@naru/contracts/naru-agent/v1";
import { useMemo } from "react";
import { useAgentApp } from "./agent-context";
import {
  ago,
  clock,
  type GraphMetrics,
  layoutGraph,
  taskState,
  taskWaitingFor,
} from "./agent-model";
import { Avatar } from "./agent-ui";
import type { AgentBoardProject } from "./api";

const LANE: GraphMetrics = { nodeWidth: 196, nodeHeight: 88, columnGap: 72, rowGap: 16 };
const FLOW: GraphMetrics = { nodeWidth: 212, nodeHeight: 96, columnGap: 104, rowGap: 28 };
/** Room above the nodes for the stage labels in the large graph. */
const FLOW_HEADER = 52;
const FLOW_PADDING = 32;

/**
 * A project's tasks as a dependency graph (AP-D022): columns by depth, curved edges from each
 * dependency, edges into running work animated. `lane` is the compact one on the control room,
 * `flow` the large one with stage bands.
 */
export function TaskGraph({
  project,
  variant,
  selectedTaskId = null,
  zoom = 1,
  minHeight = 0,
  onSelect,
}: {
  readonly project: AgentBoardProject;
  readonly variant: "lane" | "flow";
  readonly selectedTaskId?: string | null;
  readonly zoom?: number;
  /** The visible canvas height, so the stage bands reach its bottom. */
  readonly minHeight?: number;
  readonly onSelect: (task: AgentTask) => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const metrics = variant === "lane" ? LANE : FLOW;
  const layout = useMemo(() => layoutGraph(project.tasks, metrics), [project.tasks, metrics]);
  const pad = variant === "flow" ? FLOW_PADDING : 0;
  const top = variant === "flow" ? FLOW_HEADER : 0;
  const width = layout.width + pad * 2;
  const height = Math.max(layout.height + top + pad * 2, minHeight / zoom);
  const pitch = metrics.nodeWidth + metrics.columnGap;
  return (
    <div
      className="ag-graph-scroll"
      data-variant={variant}
      style={variant === "flow" ? undefined : { height: height + 4 }}
    >
      <div className="ag-graph-sizer" style={{ width: width * zoom, height: height * zoom }}>
        <div
          className="ag-graph"
          role="group"
          aria-label={`${app.projectName(project.projectId)} 작업 흐름`}
          style={{ width, height, transform: zoom === 1 ? undefined : `scale(${zoom})` }}
        >
          {variant === "flow" &&
            Array.from({ length: layout.levels }, (_, level) => (
              <div
                key={level}
                className="ag-stage-band"
                data-odd={level % 2 === 1}
                style={{ left: pad + level * pitch - metrics.columnGap / 2, width: pitch }}
              >
                <span>{level === 0 ? "1단계 · 먼저 할 일" : `${level + 1}단계`}</span>
              </div>
            ))}
          <svg
            className="ag-graph-edges"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            aria-hidden="true"
          >
            <g transform={`translate(${pad} ${top + pad})`}>
              {layout.edges.map((edge) => (
                <g key={edge.key} data-kind={edge.kind}>
                  <path className="ag-edge" d={edge.path} />
                  <circle className="ag-edge-end" cx={edge.end.x} cy={edge.end.y} r={3.5} />
                </g>
              ))}
            </g>
          </svg>
          {layout.nodes.map((node) => (
            <TaskNode
              key={node.task.id}
              task={node.task}
              project={project}
              selected={node.task.id === selectedTaskId}
              style={{
                left: pad + node.x,
                top: top + pad + node.y,
                width: metrics.nodeWidth,
                height: metrics.nodeHeight,
              }}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function TaskNode({
  task,
  project,
  selected,
  style,
  onSelect,
}: {
  readonly task: AgentTask;
  readonly project: AgentBoardProject;
  readonly selected: boolean;
  readonly style: React.CSSProperties;
  readonly onSelect: (task: AgentTask) => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const state = taskState(task, taskWaitingFor(task, project, app.board.openHandoffs));
  const assignee = app.agentById(task.assigneeAgentSessionId);
  const identity = assignee === undefined ? null : app.identity(assignee);
  const finished = state.key === "done" || state.key === "cancelled";
  return (
    <button
      type="button"
      className="ag-node"
      data-state={state.key}
      data-tone={state.tone}
      aria-pressed={selected}
      aria-label={`${task.title}, ${state.label}, ${identity === null ? "담당 없음" : `담당 ${identity.name}`}`}
      style={style}
      onClick={() => onSelect(task)}
    >
      <span className="ag-node-state">
        <span className="ag-dot" aria-hidden="true" />
        {state.label}
      </span>
      <span className="ag-node-title">{task.title}</span>
      <span className="ag-node-foot">
        {identity === null ? (
          <span className="ag-node-agent ag-muted">담당 없음</span>
        ) : (
          <>
            <Avatar identity={identity} size={18} />
            <span className="ag-node-agent">{identity.name}</span>
          </>
        )}
        <span className="ag-node-meta">
          {finished
            ? clock(task.updatedAt)
            : state.key === "pending" || state.key === "ready"
              ? ""
              : ago(task.updatedAt, app.now)}
        </span>
      </span>
    </button>
  );
}
