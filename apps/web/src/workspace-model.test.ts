// @vitest-environment jsdom
import type { Pane, Workspace, WorkspaceView } from "@naru/contracts";
import type { AgentSession, SharedProcess } from "@naru/contracts/naru-agent/v1";
import { defaultViewLayout, viewPaneIds } from "@naru/domain";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBoard } from "./api";
import {
  addPaneToView,
  activeViewPaneId,
  nextViewName,
  ownerLabel,
  ownerOf,
  paneDisplayName,
  paneOwners,
  slotTitle,
  viewThumbnail,
} from "./workspace-model";
import { readSelection, resolveSelection, writeSelection } from "./workspace-selection";

const PROJECT = "a0000000-0000-4000-8000-000000000001";
const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-10-16T00:00:00.000Z";

function pane(n: number, patch: Partial<Pane> = {}): Pane {
  return {
    id: id(n),
    projectId: PROJECT,
    kind: "terminal",
    title: `Terminal ${n}`,
    launchProfile: "shell",
    status: "running",
    exitCode: null,
    codexSessionId: null,
    codexSessionResumable: false,
    lastErrorCode: null,
    lastExitedAt: null,
    activity: { state: "idle", eventId: null, runtimeId: null, revision: 0, updatedAt: NOW },
    viewState: { selectedDocumentPath: null, navigationOpen: true, expandedDirectories: [] },
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function agent(n: number, patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: id(100 + n),
    projectId: PROJECT,
    role: "worker",
    runtime: "claude",
    runtimeSessionRef: null,
    parentAgentSessionId: null,
    native: false,
    observation: "transcript",
    conversationWriter: "orchestrator",
    humanHoldSince: null,
    status: "active",
    paneId: null,
    launchMode: "runner",
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function process(paneId: string, held: boolean): SharedProcess {
  return {
    id: id(300),
    projectId: PROJECT,
    taskId: null,
    runId: null,
    agentSessionId: null,
    purpose: "dev server",
    command: "pnpm dev",
    ports: [5173],
    keep: "run",
    paneId,
    humanHoldSince: held ? NOW : null,
    status: "running",
    exitCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function board(
  agents: AgentSession[],
  processes: SharedProcess[] = [],
  paneNames = {},
): AgentBoard {
  return {
    projects: [
      {
        projectId: PROJECT,
        intentContract: null,
        pendingIntentContract: null,
        activePlan: null,
        tasks: [],
        openHandoffs: [],
        agents,
        processes,
        pendingApprovals: [],
      },
    ],
    globalAgents: [],
    openHandoffs: [],
    globalPendingApprovals: [],
    paneNames,
  };
}

function view(patch: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id: id(500),
    kind: "user",
    name: "기본",
    layout: null,
    activePaneId: null,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

const projectName = () => "alpha";

describe("who writes a Pane (AP-D005, AP-D029)", () => {
  it("treats unbound Panes as the person's and names agents and processes", () => {
    const worker = agent(1, { paneId: id(1) });
    const held = agent(2, { paneId: id(2), humanHoldSince: NOW });
    const owners = paneOwners(board([worker, held], [process(id(3), false)]), projectName);

    expect(ownerOf(owners, id(9))).toEqual({ kind: "mine" });
    expect(ownerLabel(ownerOf(owners, id(9)))).toBe("나 · 내 Pane");
    expect(ownerOf(owners, id(1))).toMatchObject({ kind: "agent", name: "작업자 1", held: false });
    expect(ownerLabel(ownerOf(owners, id(1)))).toBe("작업자 1 · 쓰는 중");
    expect(ownerLabel(ownerOf(owners, id(2)))).toBe("나 · 끼어든 중");
    expect(ownerLabel(ownerOf(owners, id(3)))).toBe("dev server · 에이전트");
    expect(paneOwners(null, projectName).size).toBe(0);
  });

  it("shows the person's name first, then the agent's, then Naru's", () => {
    const worker = agent(1, { paneId: id(1) });
    const owners = paneOwners(board([worker], [], { [id(1)]: "로그인 담당" }), projectName);
    const agentPane = pane(1, { kind: "claude", title: "Claude worker · naru-1" });

    expect(paneDisplayName(agentPane, ownerOf(owners, id(1)))).toBe("로그인 담당");
    expect(
      paneDisplayName(agentPane, ownerOf(paneOwners(board([worker]), projectName), id(1))),
    ).toBe("작업자 1");
    expect(paneDisplayName(pane(2))).toBe("Terminal 2");
    expect(paneDisplayName(pane(2, { customTitle: "로그 보기" }))).toBe("로그 보기");
    expect(paneDisplayName(pane(2, { customTitle: null }))).toBe("Terminal 2");
  });
});

describe("workspaces in the list (AP-D027, AP-D031)", () => {
  it("adds a Pane beside the active one, or alone, and keeps one already there", () => {
    const empty = addPaneToView(view(), id(1));
    expect(empty).toMatchObject({ layout: { type: "pane", paneId: id(1) }, activePaneId: id(1) });

    const two = addPaneToView({ ...empty, activePaneId: id(1) }, id(2));
    expect(viewPaneIds(two.layout)).toEqual([id(1), id(2)]);
    expect(two.activePaneId).toBe(id(2));
    expect(addPaneToView(two, id(1)).layout).toBe(two.layout);

    const onlyPlaces = view({
      layout: defaultViewLayout({ claude: null, codex: null, terminal: null }),
    });
    const filled = addPaneToView(onlyPlaces, id(3));
    expect(viewPaneIds(filled.layout)).toEqual([id(3)]);
  });

  it("finds the active Pane and names new workspaces and empty places", () => {
    const layout = defaultViewLayout({ claude: id(1), codex: null, terminal: id(2) });
    expect(activeViewPaneId(view({ layout, activePaneId: id(2) }))).toBe(id(2));
    expect(activeViewPaneId(view({ layout, activePaneId: id(9) }))).toBe(id(1));
    expect(nextViewName([view({ name: "기본" })])).toBe("작업공간 2");
    expect(nextViewName([view({ name: "기본" }), view({ name: "작업공간 2" })])).toBe("작업공간 3");
    expect(slotTitle({ kind: "codex", launchProfile: "codex-main" })).toBe("메인 Codex");
    expect(slotTitle({ kind: "claude", launchProfile: "claude-code" })).toBe("Claude");
  });

  it("draws the layout as cells for the small picture", () => {
    const cells = viewThumbnail(defaultViewLayout({ claude: id(1), codex: null, terminal: id(2) }));
    expect(cells).toHaveLength(3);
    expect(cells[0]).toMatchObject({ x: 0, y: 0, width: 0.5, empty: false });
    expect(cells[1]).toMatchObject({ x: 0.5, empty: true });
    expect(cells[2]!.y).toBeCloseTo(0.64);
    expect(viewThumbnail(null)).toEqual([]);
  });
});

describe("what this device has open (AP-D031)", () => {
  afterEach(() => localStorage.clear());

  const workspace = (views: WorkspaceView[], panes: Pane[]): Workspace => ({
    projectId: PROJECT,
    schemaVersion: 2,
    version: 0,
    layout: null,
    activePaneId: null,
    panes,
    views,
    updatedAt: NOW,
  });

  it("keeps a stored choice that still exists and falls back to the first workspace", () => {
    const first = view();
    const second = view({ id: id(501), name: "리뷰" });
    const current = workspace([first, second], [pane(1)]);

    expect(readSelection(PROJECT)).toBeNull();
    writeSelection(PROJECT, { type: "view", id: second.id });
    expect(resolveSelection(current, readSelection(PROJECT))).toEqual({
      type: "view",
      id: second.id,
    });
    writeSelection(PROJECT, { type: "pane", id: id(1) });
    expect(resolveSelection(current, readSelection(PROJECT))).toEqual({ type: "pane", id: id(1) });
    expect(resolveSelection(current, { type: "pane", id: id(9) })).toEqual({
      type: "view",
      id: first.id,
    });
    expect(resolveSelection(workspace([], [pane(1)]), null)).toEqual({ type: "pane", id: id(1) });
    expect(resolveSelection(workspace([], []), null)).toBeNull();

    localStorage.setItem(`naru-workspace-selection:${PROJECT}`, "{broken");
    expect(readSelection(PROJECT)).toBeNull();
  });
});
