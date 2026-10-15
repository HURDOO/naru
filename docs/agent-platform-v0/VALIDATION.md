# Agent Platform v0 검증 매트릭스 (Phase 1)

## 환경과 판정 기준

- 환경(2026-10-15): macOS Darwin 25.6 arm64, Node v24.20.0, codex-cli 0.162.1, Claude Code 2.1.296,
  OpenCode 1.18.35 + oh-my-openagent 5.1.28. 기준 commit은 `4eb5433`.
- 상태 정의:
  - `PASS`: 설치 버전에서 재현했다.
  - `PARTIAL`: 일부만 재현했거나 분석만 했다. 남은 범위를 함께 적는다.
  - `FAIL`: 재현해 보니 지원되지 않는다.
  - `NOT TESTED`: 아직 실행하지 않았다.
- 공식 문서에 적혀 있다는 이유만으로 PASS를 주지 않는다. 런타임별 상세 보고서는 각 spike branch의
  `validation/*.md`이며, integration이 인수한 뒤 이 표에 반영한다.

## 요약

| ID  | 항목                                                      | 위치                                                                                             | 상태                                                                                                                                                      |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V01 | Codex 공유 App Server와 writer 중재                       | [codex-runtime](validation/codex-runtime.md)                                                     | **PASS**(실제 TUI에 GUI turn이 live로 렌더, proxy single-writer gate, 완료 대기·interrupt 이전)                                                           |
| V02 | Codex Stop/Release → TUI Resume → GUI 복귀                | [codex-runtime](validation/codex-runtime.md)                                                     | **PASS**(실패 주입 포함, API만으로 이력 복원)                                                                                                             |
| V03 | Claude SDK/CLI ↔ TUI 전환                                 | [claude-runtime](validation/claude-runtime.md)                                                   | **PASS**(stop → resume 왕복), **FAIL**(동시 writer 보호 없음), PARTIAL(live attach는 `--bg`만)                                                            |
| V04 | Codex native subagent L1~L4                               | [codex-runtime](validation/codex-runtime.md)                                                     | PARTIAL: L1, L2 **PASS**, L3 거부, L4 읽기 전용 관찰. 기능 플래그로 억제되지 않음                                                                         |
| V05 | Claude native subagent L1~L4                              | [claude-runtime](validation/claude-runtime.md)                                                   | **PASS** L1, L2와 억제. **FAIL** L3, L4                                                                                                                   |
| V06 | Claude cross-session messaging 감사와 차단                | [claude-messaging](validation/claude-messaging.md)                                               | **PASS**(로컬: 활성화, 형식, hook 감사·차단, 범위 한정 차단), PARTIAL(hook 없는 TUI 관찰)                                                                 |
| V07 | Claude Agent Teams                                        | [claude-runtime](validation/claude-runtime.md)                                                   | PARTIAL(interactive TUI에서만, 실험적)                                                                                                                    |
| V08 | Codex↔Codex, Codex↔Claude 통신                            | [codex-runtime](validation/codex-runtime.md), [claude-messaging](validation/claude-messaging.md) | 관리형 MCP는 Codex와 Claude 모두 **PASS**. 독립 root 사이 native 주소 지정은 FAIL. Codex↔Claude 실제 왕복은 NOT TESTED                                    |
| V09 | DurableSession API, stream, control, lease와 agent caller | 이 branch                                                                                        | **PASS** (Host 계층), PARTIAL (Naru 계층)                                                                                                                 |
| V10 | 비밀 입력 보호                                            | 이 branch                                                                                        | **PASS** (echo-off 경로), 제한 있음                                                                                                                       |
| V11 | App Server process와 DurableSession 연결                  | [codex-runtime](validation/codex-runtime.md)                                                     | **PASS**(격리 Host PTY console, UDS protocol 유지, 제어 인계와 Host 재기동)                                                                               |
| V12 | OpenCode/OmO attach, SDK, child trace                     | [opencode](validation/opencode.md)                                                               | **PASS**(serve API·SSE, permission, abort, TUI live attach, child L1~L3, plugin hook), **FAIL**(동시 write 중재, child 이력 보존), PARTIAL(MCP 세션 신원) |
| V13 | Gateway 사용자 인증과 agent 인증                          | 이 branch                                                                                        | PARTIAL (분석)                                                                                                                                            |
| V14 | 기존 Hook, 세션, 워크플로 migration                       | 이 branch                                                                                        | PARTIAL (분석)                                                                                                                                            |

## 구현 검증

- AP-T14 Host PTY 실행, TUI 전환, browser API: [validation/agent-runtime-host.md](validation/agent-runtime-host.md)
  - 격리 fixture 기준 PASS다. 실제 Claude TUI 전환은 PARTIAL이다.
  - 이 검증에서 Node realpath·socket stat 결함을 찾아 고쳤다. 운영에도 영향이 있을 수 있다.

## 재검증 V04b, V05b, V06b (2026-10-15)

### V04b. Codex `/subagents`와 Naru relay

- **증상(사용자 보고)**: Naru Codex Pane에서 `/subagents`로 보조 에이전트를 고르면
  `NARU_CODEX_RELAY_FAILED`가 나고 Codex가 중지된다.
- **원인**
  - 보조 에이전트를 고르면 TUI가 자식 thread를 `thread/resume`한다.
  - relay의 상태 추적기(`codex-interaction-state.ts`)는 `parentThreadId`가 있는 thread를 신원 위반으로
    보고 예외를 던졌다. 이 예외가 relay를 종료시켰다.
- **재현**: 수정 전 relay에서 실제 codex-cli 0.162.1의 자식 thread 응답과 PTY 안의 실제 TUI로 같은
  증상을 재현했다(`tests/spikes/codex-runtime/relay-subagents.ts`, `subagent-view.ts`).
- **수정(`d7f3061`)**: 자식 thread는 사용자 thread를 바꾸지 않는 보기로 취급한다. Pane은 사용자 thread에
  계속 바인딩된다. 단위 회귀 테스트를 추가했다.
- **수정 후 실제 TUI 결과**
  - 보조 에이전트 화면이 열리고 relay가 유지된다.
  - 보조 에이전트 화면에서 Codex가 "This sub-agent is controlled by its parent. Direct input is disabled."를
    표시한다.
  - 주 에이전트로 돌아오면 입력이 정상으로 들어간다.
- **판정**: Codex native subagent의 관찰(L2)은 TUI에서 가능하다. 직접 입력(L3)은 Codex가 설계상 막아
  두었다. 수정은 기존 Codex Pane의 회귀 수정이므로 main 반영과 운영 배포 대상이다(배포는 승인 필요).

### V05b. Claude TUI에서 실행 중인 보조 에이전트에 입력

- **경로**: 빈 프롬프트에서 ↓를 두 번 누르면 프롬프트 아래 에이전트 목록(`⏺ main`, `◯ general-purpose`)에
  들어간다. ↓로 보조 에이전트를 고르고 Enter를 누르면 화면이 그 에이전트로 바뀌고 입력칸이
  `Message @general-purpose…`가 된다.
- **결과**
  - 입력은 "queued"로 표시된다. 보조 에이전트가 진행 중인 tool을 마친 뒤 user 메시지로 받는다.
  - 공식 SDK `getSubagentMessages`로 전달을 확인했다. 보조 에이전트의 최종 보고(SubagentHandback)에도
    지시한 marker가 들어갔다.
  - **TUI 경로의 L3는 PASS**다. 이전 V05의 L3 FAIL은 stream-json과 SDK client 경로에만 해당한다.
- **주의**
  - `UserPromptSubmit` hook payload에는 그 입력이 어느 에이전트로 갔는지 나타내는 필드가 없다.
  - Claude Code는 프롬프트 제안 같은 내부용 보조 에이전트도 `SubagentStart`/`SubagentStop`으로 알린다.
    Naru는 이것을 `agent_type`으로 걸러 표시해야 한다.
  - 프롬프트에서 ←를 누르면 계정 전체의 세션 대시보드가 열린다. 사용자의 다른 세션도 보이므로 자동화에서
    쓰지 않는다. 이번 검증 중 이 화면에서 검증용 세션 1개가 잘못 생겼고, 즉시 중지하고 삭제했다.

### V06b. Naru bridge 아래의 Claude native 메시징

- **구성**: 보내는 쪽 `PreToolUse(SendMessage)` hook과 받는 쪽 `UserPromptSubmit` hook이 세션별
  capability로 Naru bridge(시험용 stub)에 묻는다(`tests/spikes/claude-messaging/v06b-bridge.ts`).
- **실제 세션 3개로 한 결과**

  | 시나리오                          | 결과                                                                                                                                                               |
  | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | 관리 대상 → 관리 대상             | 허가와 기록을 거쳐 전달되고, 받는 쪽이 지시를 수행했다. 기록된 보낸 쪽은 bridge가 capability로 결정했다. 받는 쪽 `origin.verifiedPeerPid`도 보낸 쪽 PID와 일치했다 |
  | 관리 대상 → 관리 대상이 아닌 세션 | 보내는 쪽에서 거부됐다(`not a Naru-managed session`). 기록은 남지 않았다                                                                                           |
  | hook 없는 세션 → 관리 대상        | 메시지는 도착했지만 받는 쪽 hook이 허가 기록이 없어 막았다. 받는 쪽은 지시를 수행하지 않았다                                                                       |
  | 받는 쪽이 사람 hold 중            | 보내는 쪽에서 `AGENT_HELD_BY_HUMAN`으로 거부됐다                                                                                                                   |
  | bridge 중단                       | 보내는 쪽에서 fail-closed로 거부됐다. 받는 쪽은 아무것도 받지 않았다                                                                                               |

- **판정: PASS.** native 메시징을 Naru 정책(관리 대상 제한, 신원과 원문 기록, hold, fail-closed) 아래에서
  쓸 수 있다.
- **V06c (production 구성요소)**
  - stub 대신 실제 Core, AgentSocketServer, `agent-hook-cli`, `naruClaudeHookSettings`로 같은 5단계를 실제
    세션 3개로 다시 돌렸다. 모두 통과했다(`tests/spikes/claude-messaging/v06c-production-bridge.ts`).
  - 위임 기록의 작성자는 보낸 에이전트, 원본 지시는 그 에이전트가 맡은 Task의 목표였다. 원문도 보존됐다.
  - 관리 대상이 아닌 세션의 메시지는 받는 쪽 hook이 막았다. 실행된 turn이 0이었다.

## V01, V02, V04, V08, V11 요약 (상세: [validation/codex-runtime.md](validation/codex-runtime.md))

- **A안 채택 근거**
  - 실제 `codex --remote` TUI가 GUI client가 시작한 turn의 delta를 완료 전에 화면에 렌더했다.
  - native 동시 `turn/start`는 진행 중인 turn에 입력을 합친다. 그래서 single writer는 proxy가 강제해야
    한다.
  - spike proxy는 다음을 결정적으로 거부했다: 비소유자의 `turn/start`, 설정 변경 resume, 미분류
    method, 중복 승인 응답.
- **B안은 복구 경로로 둔다.**
  - 다른 app-server 사이의 GUI→TUI→GUI resume, 존재하지 않는 ID, TUI kill, app-server crash를 모두
    재현했다.
  - crash 때 완료되지 않은 assistant delta는 보존되지 않는다. 마지막 turn은 `interrupted`로 남는다.
- **이력(AP-D002 전제)**: `thread/read(includeTurns)`와 `thread/turns/list` pagination만으로 텍스트와
  MCP tool 이력을 복원했다. rollout 파일은 파싱하지 않았다. pagination cursor는 opaque로 다룬다.
- **승인 요청**은 같은 request ID로 모든 client에 broadcast된다. 그래서 응답 권한도 proxy가 writer에게만
  준다.
- **Native subagent**
  - L1(`subAgentActivity`)과 L2(child thread 구독과 이력)가 동작한다.
  - 실행 중 직접 입력과 steer는 거부된다.
  - `multi_agent=false` 같은 플래그로는 spawn이 막히지 않는다. 억제를 강제 수단으로 주장하지 않는다
    (AP-D009).
- **MCP 주입**
  - `thread/start.config`로 thread마다 MCP command와 env를 주입할 수 있다. 같은 설정이어도 thread마다
    MCP process가 따로 뜬다.
  - 따라서 Codex에서도 capability를 세션별로 바인딩할 수 있다(AP-D004).
  - 빈 `mcp_servers`는 MCP 비활성화 수단이 아니다.
- **DurableSession 연결(V11)**: Host가 소유한 process가 private UDS의 app-server를 갖고, PTY에는
  redacted lifecycle console을 띄운다. 이 구조에서 control 인계, reconnect, resize, PTY 입력, Host
  재기동이 모두 protocol을 손상하지 않았다.
- **TUI 직접 입력(X1)**: `turn/start`의 `input[].text`로 관찰된다. TUI가 내부 thread에도 `turn/start`를
  보내므로 기록할 때는 주 thread ID로 걸러야 한다.
- **model 목록(X2)**: 7개 ID를 확인했고, 실제 실행은 `gpt-6-sol`만 했다.

## V03, V05, V07 요약 (상세: [validation/claude-runtime.md](validation/claude-runtime.md))

- **대화 writer(AP-D005 세 번째 계층)**
  - Claude는 같은 session의 동시 writer를 막지 않는다. print 두 개, 또는 idle TUI와 print를 동시에
    쓰면 turn이 비결정적으로 사라졌다.
  - 그래서 Naru가 Claude session ID별 single-writer lock을 직접 가져야 한다.
- **GUI↔TUI 전환**은 stop 후 resume 방식(B안)을 쓴다.
  - 진행 중인 turn을 끝내거나 interrupt한다 → SDK process를 종료한다 → 기존 Claude Pane resume 경로
    (D023)로 TUI를 연다.
  - `SessionStart`가 `source: resume`과 같은 session ID를 보고한 뒤에만 입력을 연다. 그렇지 않으면
    rollback한다.
  - `--bg`와 `claude attach`는 DurableSession 밖의 Claude 소유 PTY이고 writer 중재도 없다. 관리형
    세션에는 쓰지 않는다.
- **이력 재구성(AP-D002 전제)**: 공식 SDK `getSessionMessages`와 `getSubagentMessages`로 TUI turn을
  포함한 이력을 읽을 수 있다. 따라서 Claude는 Naru가 대화 원문을 저장할 필요가 없다.
- **TUI prompt 원문(AP-D002-2)**
  - `UserPromptSubmit` hook에 prompt 원문이 온다. 이를 쓰려면 D016(원문 폐기)을 대체하는 새 결정이
    필요하다.
  - cross-session 메시지도 같은 hook으로 들어온다. 그래서 managed 세션에서 inbound를 refuse(V06)해야
    사람의 prompt와 구분할 수 있다.
  - Naru가 controller로 TUI에 넣은 입력도 같은 hook으로 들어온다. Naru가 넣은 입력과의 대조가 필요하다.
- **Native subagent**
  - 관찰은 L1과 L2까지 지원된다. 그래서 일반 작업에는 native를 유지한다.
  - 직접 개입(L3)이나 독립 PTY(L4)가 필요한 작업은 Naru managed agent로 보낸다.
  - `--disallowedTools Task Agent`로 native subagent를 끌 수 있다.
- **Agent Teams**는 interactive 전용이고 실험적이다. 그래서 오케스트레이터 기반에서 제외한다.
- **신원 token 위치**
  - capability는 Claude process env가 아니라 `--mcp-config`의 server env로만 전달한다.
  - process env에 두면 agent의 Bash에서도 보인다. AP-T11의 roundtrip spike는 이미 이 방식이다.
- **model**: 사용자 settings 없이 실행하면 기본 model이 `claude-haiku-5-5`가 됐다. 그래서 관리형
  세션은 역할별 model을 명시한다. 확인된 ID는 `claude-opus-5-5`, `claude-fable-5-1`,
  `claude-sonnet-5-5`, `claude-haiku-5-5`다.

## V12 요약 (상세: [validation/opencode.md](validation/opencode.md))

- **live attach**
  - `opencode serve`의 공식 HTTP API와 SSE, 그리고 `opencode attach` TUI가 같은 세션을 실시간으로
    공유한다. API turn은 TUI에 0.3~0.5초 안에 렌더된다.
  - 세 런타임 중 GUI와 TUI의 **진짜 live attach**가 공식 경로로 되는 것은 OpenCode뿐이다.
- **동시 write 중재 없음**: busy 중에 들어온 prompt가 진행 중인 loop에 합쳐진다. Naru proxy가 write
  gate를 가져야 한다(AP-D005 세 번째 계층).
- **OmO child**
  - L1~L3(parentID, live 스트림, 개별 abort, 직접 prompt)이 공식 API로 된다. 독립 PTY는 없다.
  - **완료된 subagent 세션을 OmO가 10분 뒤 삭제한다.** 그래서 AP-D002의 "런타임이 이력을 보관한다"는
    전제가 OmO child에는 성립하지 않는다(사용자 결정 필요).
- **신원**: MCP는 directory 단위 process라 세션별 신원을 줄 수 없다. 대신 plugin tool의
  `ToolContext.sessionID`와 `shell.env`가 세션별로 동작한다. 그래서 Naru 연동은 plugin
  (`OPENCODE_CONFIG_CONTENT` 주입)으로 하는 것을 권고한다.
- **복구**: server를 강제 종료하면 bash tool process가 orphan으로 남고, 이력의 tool part는
  `running`으로 영구히 남는다. Naru reconcile은 이 상태를 `unknown`이나 `interrupted`로 분류해야 한다.
- **권고**: 운영 `/omo/`는 그대로 둔다. 관리형 agent에는 Naru가 별도 `opencode serve`를 띄운다. 모든
  server가 같은 data dir을 쓰므로 관리형 세션이 `/omo/` 목록에도 보인다(사용자 결정 필요).

## V06, V08 요약 (상세: [validation/claude-messaging.md](validation/claude-messaging.md))

- native cross-session 메시징은 기본으로 켜져 있다. 같은 OS 사용자의 모든 로컬 Claude 세션이 서로를
  보고 메시지를 보낼 수 있다.
- 발신자 신원은 스스로 정한 세션 이름과 OS PID뿐이다. 원본 지시 ID를 담을 구조화 필드도 없다. 기본
  설정에서는 다른 세션의 메시지 하나로 수신 세션이 작업(파일 생성)을 수행했다. 그래서 Naru가 관리하는
  세션 사이의 통신은 **Naru MCP 경로를 기본**으로 한다.
- native는 managed 세션에서만 다음 조합으로 차단한다.
  - inbound는 `crossSessionInbound: "refuse"`로 막는다.
  - 발신은 PreToolUse hook으로 막되, SubagentStart로 수집한 agent ID만 허용한다.
  - `SendMessage`를 permission으로 통째로 deny하면 subagent 메시징까지 끊긴다.
- 관리형 MCP stub은 세션마다 별도 process로 실행돼 세션별 env token으로 발신자를 바인딩할 수 있었다.
  모델이 끼워 넣은 `from` 인자를 client가 그대로 전달하므로 신원은 반드시 server에서 결정한다
  (AP-D004, V13과 일치).
- 아직 열린 항목: TUI 세션에 새 메시지를 알려 turn을 시작시키는 wakeup 경로, Teams teammate 대상의
  허용 방식(V07), 일반 Claude Pane에도 차단을 적용할지(사용자 결정).

## V09. DurableSession 제어권과 agent caller

- 재현: `pnpm exec vitest run --config tests/spikes/vitest.config.ts`
  (`tests/spikes/durable-session/agent-control.spike.test.ts`. in-process SessionService에 fake runtime을
  쓴다.)
- 같은 Host app 아래에서 `agent:*` subject(preempt와 arbitrary 권한 없음)와 사람 subject로 다음을
  확인했다.
  - agent가 profile Session을 만들고, 제어권을 획득하고, 입력할 수 있다.
  - agent의 `preemptControl`은 `CAPABILITY_REQUIRED`로 거부된다.
  - 사람은 observer로 붙은 뒤 preempt할 수 있다. generation이 1에서 2로 올라간다.
  - preempt 뒤 agent의 늦은 입력은 이전 generation이면 `CONTROL_GENERATION_STALE`, 현재
    generation이면 `ATTACHMENT_NOT_CONTROLLER`로 거부된다. PTY에는 도달하지 않는다.
  - 사람이 제어하는 동안 agent의 `acquireControl`은 `CONTROL_HELD`로 거부된다.
  - 사람이 release하면 agent가 새 generation으로 다시 획득하고 입력할 수 있다. PTY에 쓰인 순서는
    agent, 사람, agent였다.
  - agent는 사람의 attachment로 입력하거나 release할 수 없다(`ATTACHMENT_NOT_FOUND`). resume token도
    재사용할 수 없다(`ATTACHMENT_RESUME_REJECTED`).
  - 사람 attachment의 연결이 끊기면 grace(10s) 동안은 `CONTROL_HELD`가 유지된다. grace가 지나면
    Host가 controller를 풀고 generation을 올린다. 그 뒤 agent는 획득할 수 있다.
- 판정:
  - Host 계층은 AP-D005가 기대하는 fencing을 이미 제공한다. **PASS**
  - Host에는 "사람 hold" 개념이 없고 grace가 지나면 제어권을 푼다. 따라서 hold와 그 유예·idle 시간은
    Naru 계층에 둔다(AP-D005와 일치).
  - 운영 Host 등록은 Naru subject 하나만 허용한다. agent subject를 Host가 구분하려면 등록을 변경해야
    한다(AUDIT §5-1). 그래서 Naru 계층 E2E는 AP-T12에서 한다. **PARTIAL**

## V10. 비밀 입력 보호

- 재현: `pnpm workstation:preflight` 후
  `NARU_SPIKE_ACTUAL_PTY=1 pnpm exec vitest run --config tests/spikes/vitest.config.ts`
  (`tests/spikes/durable-session/secret-input.spike.test.ts`. 실제 node-pty에서 `/bin/bash`의
  `read -s` 프롬프트를 쓴다.)
- 결과:
  - echo-off 프롬프트에 controller가 입력한 fixture 비밀값은 agent subject observer의 stream,
    controller stream, Host terminal snapshot, `readEvents` journal 어디에도 없었다.
  - 같은 Session의 echo-on 프롬프트에 입력한 값은 observer stream과 snapshot에 그대로 보였다.
- 코드 감사 결과:
  - 입력 경로는 web의 WS `terminal.input` → Naru `supervisor.write` → Host `sendInput` → PTY다.
    Naru 구조화 로그는 event와 ID만, Host logger는 고정 event 목록만 기록한다. 입력 data를 로그에
    넣는 경로는 없다.
  - Host는 짧은 중복 제거를 위해 입력의 SHA-256 fingerprint를 메모리에 60초 보관한다. salt가 없지만
    디스크에는 쓰지 않는다. secure input을 구현할 때 keyed hash 적용이나 fingerprint 생략을 검토한다.
  - browser 저장소에는 화면 설정, 마지막 project, client ID만 있고 입력 내용은 없다.
  - agent의 LLM 컨텍스트는 관찰(snapshot과 output)로만 terminal 내용을 받는다. 그래서 echo-off 비밀은
    들어가지 않는다. echo-on 비밀은 들어갈 수 있다.
- 판정: echo-off 경로는 **PASS**다. 제한은 다음과 같다.
  - 프로그램이 직접 출력(echo)하는 값은 secure input으로도 숨길 수 없다. 화면에 비밀 입력 요구가 보이면
    에이전트가 사람에게 넘기는 규칙(AP-D003)과, 사람이 echo-off 프롬프트에 secure input을 쓰는 방식이
    방어선이다.
  - secure input을 넣을 위치: `TerminalPane` 입력 경로에 별도 입력 control을 두고 새 WS frame 유형을
    정의한다. 이 frame은 agent 입력 기록, draft, 보조 입력창 경로에서 제외한다(AP-T12).
- 아직 하지 않은 것: 실제 SSH나 ansible 프롬프트(A09), 웹 UI 경로의 E2E(secure input 구현 뒤).

## V13. Gateway 사용자 인증과 agent 인증

- 사용자 경로(현재):
  1. Gateway passkey와 session에서 짧은 수명의 서명된 app assertion이 발급된다.
  2. Naru가 issuer, audience, owner, Origin, expiry를 검증한다(`gateway-auth.ts`).
  3. Naru가 app 권한을 확인한다.
  4. Naru가 등록된 app credential로 Host capability를 붙여 호출한다.
  - Naru는 loopback이나 고정 private 대역에만 bind하고 wildcard를 거부한다. Host는 owner-only UDS와
    0600 credential을 쓴다.
- agent 경로(제안, AP-D004와 AP-T11):
  - agent는 Gateway를 거치지 않는다. MCP stdio bin이 owner-only UDS로 Naru에 연결한다. 0700
    디렉터리, 0600 socket, `lstat` 검증은 기존 `integrations/codex/server.ts`와 같은 방식이다.
  - Naru가 띄운 agent session마다 짧은 수명의 capability를 발급한다. Claude hook의 Pane/runtime
    capability와 같은 방식이다. Naru가 이 capability로 `actor_id`를 결정한다.
  - browser API와 agent API는 서로 다른 listener에 둔다. 브라우저는 agent 경로를, agent는 브라우저
    경로를 사용할 수 없다.
- 구현 근거(AP-T11): agent capability와 owner-only socket, MCP bin으로 다음을 확인했다.
  - 위조한 `from` 인자 거부, revoke 뒤 거부, 오류 응답에 원문 미노출(`apps/server/test/agent-platform-mcp.test.ts`)
  - 실제 Claude Code 2.1.296에서 위임이 capability의 orchestrator 신원으로 기록됐다
    (`tests/spikes/agent-platform/claude-mcp-roundtrip.ts`, 원문 로그는 experiments에 있다).
  - Codex 주입은 아직 확인하지 않았다(V08 Codex).
- 판정: **PARTIAL**. Claude 경로는 동작하지만, Naru 시작 경로 연결과 Codex 경로가 남았다. 확정된
  제한이 하나 있다. agent는 같은 OS 사용자로 shell을
  실행하므로 owner-only credential을 읽을 수 있다. agent 인증은 책임 추적과 사고 방지 수단이며,
  악성 agent를 가두는 경계가 아니다. 격리가 필요하면 별도 OS 사용자나 sandbox가 필요하고 이는 v0 범위
  밖이다. Gate 1에서 사용자에게 알린다.

## V14. 기존 Hook, 세션, 워크플로 migration

- DB:
  - v19까지 앞으로만 migration하고 backup 계약이 있다. Agent Platform은 v20 이후 additive table로
    추가하고, Pane holder처럼 기존 테이블에 필요한 열은 nullable로 추가한다.
  - 기존 Pane과 Session link, Codex와 Claude session ID는 변환하지 않는다.
- Hook과 이벤트 중복:
  - Codex relay와 hook, Claude hook은 모두 Naru 검증을 거친 뒤 `supervisor.onActivity` 한 곳에서
    WS와 push로 퍼진다.
  - Event Store는 이 지점에 구독으로 붙이고 별도 hook 경로를 만들지 않는다. 이렇게 하면 같은 신호가
    두 번 처리되지 않는다.
  - Inbox push는 기존 project tag와 정리 규칙(D024)과 함께 설계한다.
- 워크플로 화면: project, workspace, layout은 그대로 둔다. 새 화면은 Pane kind가 아닌 별도 화면으로
  시작해 layout schema migration을 피한다.
- 호환성: 새 WS frame은 additive로 추가하고, 기존 사례(D013)처럼 server와 web을 같은 release로
  배포한다.
- 판정: **PARTIAL**(분석). v19 DB fixture로 실제 migration을 실증하는 것은 AP-T09에서 한다.
