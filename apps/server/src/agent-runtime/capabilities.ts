import type { AgentRuntime, RuntimeCapabilities } from "@naru/contracts/naru-agent/v1";

/**
 * Runtime-proven capabilities per installed version (Gate 1, 2026-10-15). Each `true` cites a
 * reproduced result. Naru-side enablement (adapters, write gates) is separate and not implied.
 * Changing a runtime version requires re-running the cited validation before editing this table.
 */
export const RUNTIME_CAPABILITIES: Readonly<Record<AgentRuntime, RuntimeCapabilities>> = {
  claude: {
    runtime: "claude",
    versions: { "claude-code": "2.1.296", "claude-agent-sdk": "0.3.296" },
    structuredChat: true,
    realTui: true,
    liveTuiAttach: false,
    safeGuiTuiTransition: false,
    nativeSubagentTrace: "transcript",
    nativeCrossSessionMessaging: false,
    externalApprovalControl: true,
    canBridgeToDurableSession: false,
    limits: [
      "GUI와 TUI는 동시에 쓰지 않고 멈춘 뒤 이어받는다(stop → resume).",
      "같은 대화에 두 writer가 쓰면 turn이 사라질 수 있어 Naru가 writer를 하나로 제한한다.",
      "Native subagent는 실시간 transcript까지 관찰된다. 직접 입력과 독립 터미널은 없다.",
      "Agent Teams는 interactive 실험 기능이라 오케스트레이터에 쓰지 않는다.",
    ],
    evidence: [
      "docs/agent-platform-v0/validation/claude-runtime.md",
      "docs/agent-platform-v0/validation/claude-messaging.md",
    ],
  },
  codex: {
    runtime: "codex",
    versions: { "codex-cli": "0.162.1" },
    structuredChat: false,
    realTui: true,
    liveTuiAttach: false,
    safeGuiTuiTransition: false,
    nativeSubagentTrace: "none",
    nativeCrossSessionMessaging: false,
    externalApprovalControl: false,
    canBridgeToDurableSession: false,
    limits: ["Codex 검증 결과를 인수하기 전까지 기존 TUI Pane만 지원한다."],
    evidence: [],
  },
  opencode: {
    runtime: "opencode",
    versions: { opencode: "1.18.35", "oh-my-openagent": "5.1.28" },
    structuredChat: true,
    realTui: true,
    liveTuiAttach: true,
    safeGuiTuiTransition: false,
    nativeSubagentTrace: "interactive",
    nativeCrossSessionMessaging: false,
    externalApprovalControl: true,
    canBridgeToDurableSession: false,
    limits: [
      "GUI와 TUI가 같은 세션을 실시간으로 공유한다. 쓰기는 Naru write gate가 생긴 뒤에만 안전하다.",
      "OmO는 끝난 subagent 세션을 10분 뒤 삭제해 나중에 이력을 읽을 수 없다.",
      "Child는 독립 터미널이 없다.",
    ],
    evidence: ["docs/agent-platform-v0/validation/opencode.md"],
  },
};
