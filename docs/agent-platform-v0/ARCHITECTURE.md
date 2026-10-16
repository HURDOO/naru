# Agent Platform v0 기술 아키텍처 (초안)

> 상태: Gate 1(AP-T08) 완료. §1~§5는 Phase 2 공통 기반이고, §6은 검증 결과에 따른 런타임 구성이다. 결정의 근거는 [DECISIONS.md](DECISIONS.md)에 있다.

## 1. 구성

```text
browser ── Gateway(passkey) ── Naru server ── HTTP·WS ─┐
                                                       ├─ AgentPlatformCore ─ SQLite(v20+)
agent runtime ── stdio ── naru-mcp bin ── owner UDS ───┘          │
                                                                  └─ DS Host(UDS, 기존 capability)
```

- **AgentPlatformCore**(`apps/server/src/agent-platform/`)는 Web UI, MCP, CLI가 함께 쓰는 단일
  command와 query 진입점이다. 정책을 우회하는 별도 DB 쓰기 통로를 두지 않는다(SOURCE_SPEC §11).
- browser 경로는 기존 Gateway assertion, CSRF, Origin 검사와 사람 기기 lease를 그대로 사용한다.
- agent 경로는 Naru가 띄운 agent session에만 주입한 MCP bin을 통해 들어온다. 이 bin은 owner-only
  UDS로 연결하고, 세션별 capability로 행위자를 결정한다(AP-D004, V13).
- 계약은 `@naru/contracts/naru-agent/v1`에 둔다. 기존 `naru-app/v1`과 `durable-session/v0`의 wire는
  바꾸지 않는다.

## 2. 데이터 모델

`Task`, `Run`, `AgentSession`, terminal Session은 서로 다른 개념이다. 한 Task는 여러 Run을 가질 수
있고, 한 AgentSession은 자식 AgentSession과 terminal Session을 만들 수 있다.

| 테이블                                   | 내용                                                                 | 핵심 불변 조건                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_instructions`                     | 사람의 지시와 에이전트의 위임 메시지 원문(AP-D002)                   | 원문은 불변이고 수정은 `supersedes_id`로 남긴다. 에이전트가 쓴 행은 `origin_user_instruction_id`가 필수다. forget은 원문을 지우고 tombstone을 남긴다 |
| `agent_intent_contracts`                 | 승인된 원칙, 허용 기술, 승인 필요 항목                               | project별 version이 단조 증가한다. 활성 상태는 project별로 최대 하나다                                                                               |
| `agent_plans`                            | 계획 version, 담당 orchestrator, 요약                                | project별 version이 단조 증가한다                                                                                                                    |
| `agent_tasks`, `agent_task_dependencies` | 목적, 완료 조건, 상태, 우선순위, 담당자, 의존성 DAG                  | `origin_instruction_id`가 필수다(INV-01). `revision`으로 낙관적 동시성을 관리한다. 의존성에 cycle을 허용하지 않는다                                  |
| `agent_runs`                             | Task 실행 시도, 런타임, 모델, 상태, 오류 분류                        | 재시작 뒤 결과를 모르면 `unknown`으로 둔다. 성공이나 실패를 추정해 기록하지 않는다                                                                   |
| `agent_sessions`                         | 런타임 세션 참조, 역할, 부모 관계, 관찰 수준, 대화 writer, 사람 hold | 관찰 수준은 검증된 값만 쓴다(`pty`, `transcript`, `lifecycle`, `none`)                                                                               |
| `agent_handoffs`                         | 사람 개입 요청과 해소 결과                                           | payload 필수 필드(SOURCE_SPEC §9.2)를 schema로 검사한다. 해소는 한 번만 가능하다                                                                     |
| `agent_reviews`                          | correctness와 intent 판정                                            | 의도 위반 판정이 남아 있으면 merge gate를 통과시키지 않는다(A11)                                                                                     |
| `agent_artifacts`                        | commit, branch, 경로, 테스트 결과 참조                               | 파일 내용과 전체 출력은 저장하지 않는다                                                                                                              |
| `agent_events`, `agent_event_cursors`    | 메타데이터 이벤트와 consumer별 cursor                                | 전역 `seq`로 순서를 매긴다. payload는 참조와 열거값만 담는다                                                                                         |
| `agent_commands`                         | 변경 command의 idempotency 기록                                      | 같은 actor와 key로 다른 payload가 오면 거부한다                                                                                                      |

terminal Session 바인딩, SharedProcess, 사람 hold, 에이전트의 PTY 입력 기록은 AP-T12에서 같은 원칙으로
추가한다.

## 3. command, 이벤트, 복구

1. 모든 변경 command는 서버가 정한 `actor`, `idempotencyKey`, 필요할 때 `expectedRevision`을 받는다.
2. 하나의 SQLite transaction 안에서 domain 쓰기, event append, command 기록을 함께 commit한다.
3. commit 뒤에만 구독자(WS 화면, orchestrator wakeup)에게 알린다. 알림이 유실돼도 cursor로 다시
   읽을 수 있다.
4. 같은 key의 재요청은 처음 결과를 그대로 돌려준다. 그래서 재시작이나 재전송으로 위임이나 결정이
   두 번 처리되지 않는다(INV-07).
5. orchestrator wakeup은 자기 cursor 이후의 이벤트를 범위(global 또는 project)로 걸러 한 묶음으로
   전달한다. 사람이 hold 중인 대상은 AP-D005를 따른다.
   - 받는 쪽(AP-D037, `wakeups.ts`의 `relevantTo`): 프로젝트 오케스트레이터는 자기 프로젝트 이벤트만 받고
     지시는 자기와 프로젝트에 온 것만 받는다. 메인은 전체·자기 지시, 자기 질문의 답, 자기 hold, 프로젝트
     오케스트레이터의 실패·멈춤·상태 모름만 받는다. 작업자·리뷰어는 Core `eventConcernsAgent`로 자기 일만 받는다.
     store의 프로젝트 이벤트 조회는 전체 이벤트를 함께 돌려주므로 여기서 거른다.
   - cursor는 차례가 끝난 것을 볼 때 옮긴다(최소 한 번 전달). 보낸 위치는 `orchestrator-sent:<id>` cursor로 따로
     남기고, 그 안의 이벤트를 다시 보내면 `resent`로 표시해 깨우기 메시지에 다시 보냈다고 적는다.

## 4. 행위자와 권한

- 행위자 종류는 `human`, `agent`, `system` 세 가지다. agent의 ID와 역할은 capability가 결정하며,
  도구 인자는 신뢰하지 않는다.
- 역할별 command 허용 범위(초기값)는 contract의 데이터로 둔다.

  | 역할                   | 허용 범위                                                                         |
  | ---------------------- | --------------------------------------------------------------------------------- |
  | `main-orchestrator`    | 전역 조회, project orchestrator에게 위임                                          |
  | `project-orchestrator` | 자기 project의 plan과 task, 위임, review 요청, Handoff, managed agent 생성        |
  | `worker`               | 자기 task 범위의 진행 보고, artifact, Handoff, 설계 변경 제안, 세션 생성(AP-D006) |
  | `reviewer`             | review 제출과 조회                                                                |

- 사람의 browser 변경은 기존처럼 사람 기기 lease를 요구한다. 에이전트 command는 이 lease를 거치지 않는다.

## 5. 저장과 노출 경계

- AP-D002에 따라 원문은 `agent_instructions`(사람 지시와 위임 메시지)와 Handoff 해소 결과에만 둔다.
  이벤트, 구조화 로그, Push에는 넣지 않는다.
- 에이전트가 보내는 자유 텍스트(진행 요약, 설계 변경 제안, review 의견)는 크기 상한을 둔다. 알려진
  token 패턴은 best-effort로 마스킹한다. 1차 방어선은 에이전트에게 비밀값을 주지 않는 것이다.

## 6. 런타임 구성 (Gate 1)

### 6.1 공통 경계

- `apps/server/src/agent-runtime/adapter.ts`의 `AgentRuntimeAdapter`가 런타임별 차이를 흡수한다. 하는 일은
  세션 시작과 resume, turn 전송, interrupt, 승인 응답, 이력 조회, 재시작 probe다.
- 어댑터는 이력을 저장하지 않는다. Chat 화면은 런타임의 공식 history API로 다시 읽는다(AP-D002).
- `writer-gate.ts`의 reducer가 대화 writer를 하나로 강제한다(INV-05). 이유는 세 런타임 모두 동시 입력을
  진행 중인 turn에 합치거나 유실하기 때문이다.
- 사람 hold(AP-D005)는 writer를 `gui`나 `tui`(사람)로 옮기는 것으로 표현한다. hold 중
  orchestrator의 전송은 Core가 거부한다.
- MCP capability는 런타임의 MCP server 설정에만 넣는다. agent process env에 두면 shell에서 보인다.
- 런타임별 실제 지원 범위는 `capabilities.ts`(검증 근거 포함)를 UI에 그대로 보여 준다(A16).

### 6.2 런타임별 구성

| 런타임           | 실행 위치                                                                                              | Chat(GUI)                                | TUI                                                | 전환                                                           | native child                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| Codex 0.162.1    | Host PTY의 launcher와 guardian가 app-server를 소유한다. 기존 Pane relay를 쓰고, headless는 V11 console | relay의 추가 client(JSON-RPC)            | 실제 `codex --remote` TUI가 같은 thread를 공유한다 | `live`: turn 경계에서 writer만 이전한다. 복구는 B안            | L1·L2(`subAgentActivity`, child thread 구독)     |
| Claude 2.1.296   | Host PTY의 runner(SDK는 `ClaudeSdkPort`로 공급, AP-D012. protocol은 pipe와 UDS, PTY에는 console)       | SDK 구조화 이벤트와 `getSessionMessages` | 기존 Claude Pane(`--resume`)                       | `stop-resume`: runner 종료 → Pane resume → `SessionStart` 확인 | L1·L2(`--forward-subagent-text`, Subagent hooks) |
| OpenCode 1.18.35 | Host PTY의 Naru 전용 `opencode serve`와 Naru plugin                                                    | serve HTTP API와 SSE                     | 같은 세션에 `opencode attach`                      | `live`: Naru proxy write gate                                  | L1~L3(OmO child). 이력은 10분 뒤 삭제된다        |

### 6.3 정책 요약

- native subagent: 관찰은 L2까지만 표시하고, L3·L4가 필요한 작업은 managed agent로 보낸다. 억제를
  강제 수단으로 주장하지 않는다(AP-D009).
- agent 간 통신: managed 세션은 Naru MCP `delegate`를 쓴다. Claude의 native cross-session은 managed
  세션에서만 차단한다(AP-D010).
- TUI 직접 입력 기록: managed 세션에서만 원문을 기록한다(AP-D002).
  - Codex: relay가 보는 주 thread의 `turn/start` 입력
  - Claude: `UserPromptSubmit` hook. cross-session inbound를 거부하고 Naru가 넣은 입력은 대조해 제외한다.
  - OpenCode: plugin `chat.message`
- 재시작: 어댑터의 `probe`가 런타임 상태를 확인하기 전까지 Run은 `unknown`이다. Codex crash는 마지막
  turn을 `interrupted`로 남기고, OpenCode crash는 tool part가 `running`으로 남는다. 둘 다 성공으로
  간주하지 않는다.

### 6.4 관리형 Claude 에이전트 실행 (AP-T14 구현)

- 시작 조건: `NARU_AGENT_PLATFORM=1`, durable Host 소유, `NARU_CLAUDE_PATH`, 사용자가 설치한 SDK
  경로 `NARU_CLAUDE_AGENT_SDK_PATH`(AP-D012)가 모두 있을 때만 켜진다. 하나라도 없으면 Core와 MCP만
  동작하고 runtime API는 등록되지 않는다.
- Pane:
  - 에이전트마다 `claude` Pane 하나(launch profile `claude-agent`)를 만들고 `agent_sessions.pane_id`로
    묶는다. 이 profile은 Pane API로 만들 수 없다.
  - 작업공간에는 접힌 상태로 들어가, 사용자가 배치한 레이아웃은 바뀌지 않으면서 "접은 Pane" 목록에
    보인다(K4). 가장 얕은 Pane을 나눠 넣으므로 깊이 제한(12)에 걸리지 않는다.
  - Host에서는 기존 `claude-code` profile과 integration policy로 실행한다. 무엇을 띄울지(runner 또는
    TUI)는 Naru가 launch 응답으로 정하므로 Host와 배포 설정은 바뀌지 않는다.
- 실행 형태(`agent_sessions.launch_mode`):
  - `runner`: launcher가 Node로 `claude-agent-runner`를 띄운다. launch 응답에는 runtime channel의
    socket과 token만 추가할 수 있다(응답 schema가 다른 키를 거부한다). token은 실행할 때마다 새로
    발급되어 이전 세대 runner는 다시 붙지 못한다.
  - `tui`: 같은 대화를 `claude --resume`으로 연다. Naru MCP 설정, bridge hook(`tui` mode), Pane 활동
    hook, 역할별 model, `--setting-sources user,project,local`을 함께 넣는다(AP-D020).
  - 두 형태 모두 실행할 때마다 agent capability를 새로 발급하고 이전 것을 폐기한다.
- writer gate(`stop-resume`): orchestrator와 Chat(gui)은 같은 runner를 쓰므로 바로 넘긴다. TUI로
  오가는 전환만 Pane process를 끝내고(Host session remove) 다른 형태로 다시 시작한다. TUI 쪽은 활동
  hook의 `SessionStart`가 Pane에 남긴 대화 ID로, runner 쪽은 `conversation-ready`로 확인한다. ID가
  다르거나 시간 안에 오지 않으면 이전 형태로 rollback한다.
- runner는 Naru 재시작을 넘어 살아 있다가 다시 접속한다. 아직 시작 전인 runner가 접속하면 Naru가
  Core 기록으로 plan을 다시 만든다. 접속이 끊긴 채 15초가 지나면 상태를 `unknown`으로 둔다.
- browser API(사람, device lease 필요):
  - `POST /api/agent/agents`(생성과 실행), `/launch`, `/stop`, `GET /runtime`, `GET /history`
  - `POST /hold`: 개입은 Core hold를 먼저 걸고 writer를 Chat 또는 TUI로 옮긴다. 해제는 writer를
    orchestrator에게 돌려준 뒤 hold를 푼다. 그래서 깨어난 orchestrator가 바로 쓸 수 있다.
  - `POST /turns`, `/interrupt`, `/approvals/:requestId`: 사람이 writer이고 browser가 본 generation이
    현재 것일 때만 받는다. Chat turn은 그 에이전트에 대한 사람의 원문 지시로 기록한다(AP-D002).
- orchestrator 역할의 에이전트는 대화가 준비되면 wakeup 대상에 등록된다.
  - 깨우는 이벤트에서 runtime 상태 보고는 뺀다. 다른 에이전트의 failed·unknown·stopped만 남긴다.
  - 행동 지침(`skills/naru-orchestration`)은 runner의 system prompt와 TUI의 `--append-system-prompt`로
    넣는다.
- main orchestrator는 project가 없는 전역 세션이다. Pane과 작업 디렉터리는 사람이 생성할 때 고른 host
  project의 것을 쓴다.
- runtime 상태(`GET /runtime`)는 writer, generation, 형태, 대기 중인 승인, 실행 중인 보조 에이전트를
  보여 준다. 보조 에이전트는 관찰만 한다(AP-D014).

### 6.4.1 관리형 Codex 에이전트 (AP-T13)

- Codex Pane(`codex-agent`)의 launcher와 relay가 그대로 실행된다. relay는 runtime channel로 Naru에
  붙는 runner 역할도 한다.
  - Naru의 plan으로 thread를 만들거나 resume한다. 이때 Naru MCP를 `config["mcp_servers.naru"]`로,
    역할 지침을 `developerInstructions`로 넣는다.
  - 그다음 실제 TUI를 그 thread에 `resume`으로 붙인다.
- Chat(GUI)과 TUI가 같은 thread를 live로 공유한다(writer gate `live`).
  - relay는 Naru가 알려 준 writer로 TUI의 대화 쓰기와 승인 응답을 거른다.
  - TUI가 다른 thread로 resume하려는 요청은 막는다.
- TUI 직접 입력은 prompt ID와 함께 보고된다. Naru는 그 ID를 idempotency key로 써서 한 번만 기록한다.
- 역할별 model(검증값 `gpt-6-astra`)은 thread에 명시한다. reasoning은 codex-main profile의 xhigh다.

### 6.5 공유 프로세스와 사람 hold (AP-T12)

- `start_process`(MCP)는 Core에 project, task, run, agent, 목적, 명령 원문, port, 유지 정책을 먼저
  기록한다(AP-D006). 그다음 실행기가 terminal Pane(`shell`)을 접힌 채 만들고 Host session에서 명령을
  입력한다.
- Naru는 process마다 controller attachment 하나를 유지한다.
  - 에이전트의 입력(`send_process_input`)은 이 attachment로 보낸다. 원문은
    `agent_shared_process_inputs`에 남긴다(AP-D003).
  - 화면(`read_process_screen`)은 headless terminal로 텍스트화해 에이전트에게만 돌려준다. 저장하지
    않는다.
- `PaneControlPolicy`: 에이전트가 운영하는 Pane(공유 프로세스, runner 형태의 관리형 에이전트)에는
  사람 기기도 observer로 붙는다. 그래서 화면을 보기만 해서는 에이전트의 제어권을 빼앗지 않는다.
  - hold하면 에이전트 attachment가 제어권을 놓고 기기가 받는다.
  - 반환하면 기기가 놓고 에이전트가 새 generation으로 다시 받는다.
  - 관리형 에이전트는 TUI 형태로 hold했을 때만 사람이 제어한다.
- `HoldMonitor`는 사람 hold를 세 경우에 반환한다.
  - 명시적 해제
  - controller 기기가 없는 상태가 유예 시간 이상 지속
  - 사람 입력(terminal 입력, Chat turn)이 idle 시간 이상 없음
  - 반환은 명시적 해제와 같은 경로다. 에이전트 대화는 writer를 먼저 돌려준다.
  - 이벤트 `*.hold_released`(사유 포함)가 orchestrator를 깨운다.
- secure input(`terminal.input.secure`)의 bytes는 PTY에만 간다. Naru는 사람이 입력했다는 사실만 hold
  idle 판정에 쓴다.
  - 입력 UI는 shell terminal Pane의 `비밀 입력`(password 입력란)이다. 값은 Enter와 함께 한 번 보내고
    browser 상태나 draft에 남기지 않는다. Claude·Codex Pane에는 두지 않는다(입력이 모델 prompt가 된다).
  - Host의 입력 중복 제거 fingerprint는 process별 key의 HMAC이다.

### 6.5.1 worktree, merge, 사람 채널 (AP-T11, AP-D016)

- `AgentWorkspace`(`agent-runtime/workspace.ts`)가 git과 Naru project 작업을 한다. 권한은 Core가 먼저
  판단한다(`authorizeWorktree`, `authorizeMerge`, `authorizePaneOpen`).
  - git은 Naru의 metadata 조회와 같은 runner를 쓴다: 사용자·system 설정 없음, 승인 root를 ceiling으로,
    명령당 8초.
  - worktree는 `ProjectCatalogService.register`로 연결한다. `agent_worktrees`가 부모 project를 기록한다.
    Core의 scope 검사는 에이전트의 project와 그 project에 묶인 worktree를 같은 범위로 본다.
  - merge는 대상 checkout이 깨끗할 때 `--no-ff` merge commit으로 한다(AP-D019). 충돌하면 `--abort`로
    되돌리고 충돌 파일과 함께 거부한다. 신원은 project, 사용자 git config 순서로 읽고, 저장소 hook은
    실행하지 않는다. 결과 commit을 artifact로 남긴다.
- `interrupt_agent`는 supervisor의 writer gate를 거친다. 대화 writer가 orchestrator일 때만 보낸다.
- 승인 대기 알림(AP-D021): supervisor가 승인 대기 여부가 바뀔 때 `attention`을 부른다.
  `DurableHostSessionFacade.showAgentAttention`이 에이전트 Pane의 활동 상태를
  `interaction-required`와 `idle` 사이에서 바꾼다. 그 뒤는 기존 활동 경로(Pane·project 표시, push,
  clear)다. 웹은 그 알림이 관리형 에이전트 Pane을 가리키면 에이전트 화면에서 그 에이전트를 연다.
- Handoff push: app이 Core 이벤트 `handoff.requested`를 받아 `notifyHandoff`를 부른다.
  - payload(`PushHandoffPayloadSchema`)는 ID와 종류만 담는다. 이유, 선택지, 환경은 서버에만 있다.
  - topic은 Handoff별이다. project의 clear 알림이 아직 전달되지 않은 Handoff 알림을 대체하지 않게 한다.
  - service worker는 `naru:handoff:<id>` tag로 한 번만 보여 준다. 열면 `naruHandoff` 또는
    `NARU_PUSH_HANDOFF`로 앱이 그 Inbox 항목을 연다.

### 6.5.2 도구 승인 (AP-D017)

- runner와 Codex relay는 승인 요청에 요약(도구와 명령 또는 경로)을 붙여 보낸다. supervisor는 이 요약을
  메모리에만 둔다. runtime 상태와 project 응답의 `pendingApprovals`로 화면에 보인다.
- `POST /approvals/:requestId`는 사람이 답하는 경로다(`respondApprovalAsPerson`). 대화 writer와
  무관하게 기기 lease만 요구한다. `generation`은 이전 client를 위해 받기만 하고 쓰지 않는다.
- Naru MCP 도구는 Claude settings의 `mcp__naru` 허용과 Codex relay의 자동 응답으로 묻지 않는다.
- 권한 모드(AP-D023, AP-D024): Naru가 사용자 모드를 읽어(project local, project, 사용자 settings의
  `permissions.defaultMode`, 없으면 auto) runner plan의 `permissionMode`와 TUI의 `--permission-mode`로
  넘긴다. 넘기지 않으면 이어 가는 대화가 이전 모드를 그대로 쓰기 때문이다. 그 모드가 결정하지 못한
  호출만 `canUseTool`로 와서 승인 요청이 된다.
  - SDK가 같이 준 `suggestions`가 있으면 승인 항목에 `sessionAllow`를 붙인다. `approve-session`이면 그
    규칙을 `destination: "session"`으로만 돌려준다. Codex 명령·파일 승인은 `acceptForSession`이다.

### 6.6 웹 화면 (AP-T17)

- 작업공간 옆의 `에이전트` 탭이다. 사람 기기 lease가 있어야 바꿀 수 있다(AP-D005 첫 계층). 읽기는
  polling이다.
  - project 상태·전체 현황·이벤트: 3초
  - 에이전트 runtime 상태: 2초
  - 대화 이력: turn이 끝날 때와 8초마다 runtime에서 다시 읽는다(AP-D002)
- 화면과 근거 API
  - 전체 현황: `GET /api/agent/overview`
  - 프로젝트 개요: `GET /api/agent/projects/:id`. 승인된 계약, 승인 대기 제안(`pendingIntentContract`),
    활성 계획, 작업, 열린 Handoff, 에이전트, 지시, 공유 프로세스를 함께 준다.
    - 작업 그래프는 `dependsOn` 깊이로 단계를 나눈다.
    - 작업 노드는 `GET /api/agent/tasks/:id`(Run, 리뷰, 산출물, 병합 조건)를 연다.
  - Agent Panel 활동 탭: `GET /api/agent/events?projectId&after&latest=1`.
    - 처음에는 최신 page를 읽고, 그 뒤로는 이어서 받는다. 최대 1,000개를 browser 메모리에만 둔다.
    - 그 에이전트가 한 일이나 그 에이전트에 관한 이벤트를 보여 준다. 이벤트에는 metadata만 있다.
  - 쓰기는 기존 command route를 쓴다: 지시, 의도 계약 승인, 에이전트 생성·실행·정지, hold, turn, 중단,
    승인, Handoff 결정, 공유 프로세스 hold·정지.
- 화면에 바로 보이지 않는 경계
  - TUI는 작업공간의 실제 Pane을 연다. 에이전트 화면 안에 terminal을 다시 그리지 않는다.
  - native 보조 에이전트는 관찰만 한다(AP-D014).

### 6.6.1 에이전트 화면 재설계 (AP-T20, AP-D022)

AP-T17의 목록·상세 카드 화면을 Figma 시안 v1 구조로 바꿨다. 위의 API와 쓰기 경로는 그대로 쓰고, 읽기
두 개를 더했다.

- 구성(`AgentApp`): 왼쪽 rail(휴대폰은 아래 탭)에 관제실, 대화, 흐름. 작업공간·에이전트 전환과
  "나를 기다림 N"은 top bar에 있다. 에이전트 화면 코드는 열 때만 불러온다(lazy).
  - 관제실(`ControlRoom`): 메인 오케스트레이터에게 맡기는 입력창(global 지시, 없으면 시작), 지표, project별
    작업 흐름 그래프, 나를 기다리는 것(승인·Handoff·의도 계약), 에이전트 목록, 타임라인.
  - 대화(`AgentChat`): 상태별 목록, 대화, 작업 맥락(맡은 작업, 진행 단계, 산출물, 리뷰, 프로세스, 함께
    일하는 에이전트). 보내면 Chat으로 hold한 뒤 turn을 쓴다. 답하는 중이면 hold의 `interrupt`를 쓴다.
  - 흐름(`FlowView`): 한 project의 단계별 작업 그래프와 선택한 작업의 기록·산출물·병합 조건. 휴대폰은
    단계 목록이다.
- 읽기 API(추가형, 기존 consumer 영향 없음)
  - `GET /api/agent/board`: 에이전트 작업이 있는 모든 project의 project 응답(지시 원문 제외)과 global
    에이전트, 모든 열린 Handoff, global 에이전트의 승인 대기. 3초마다 읽는다. 작업공간 화면은 top bar
    숫자를 위해 15초마다 읽는다.
  - `GET /api/agent/agents/:id/instructions`: 그 에이전트에게 한 말(위임, 사람의 직접 대화, project
    오케스트레이터는 project 지시, 메인은 사용자 global 지시)과 각 위임의 원본 사용자 지시. 원문은 이미
    저장된 지시다(AP-D002). 최신 200개. `decisions`: 그 에이전트가 물은 질문에 사람이 한 답과, 프로젝트
    오케스트레이터면 그 프로젝트의 의도 계약 승인(AP-D035).
  - 이벤트는 project 없이 전체를 읽는다(`GET /api/agent/events?latest=1`, 처음 500개, 이후 이어 받기,
    browser에 최대 3,000개).
- 대화 구성(`agent-conversation.ts`): runtime 이력을 다시 읽어 만든다. Claude session message와 Codex
  turn item을 요청, 답, 도구 묶음, 생각, 알림으로 나눈다.
  - 요청은 기록된 지시 원문과 맞춰 누가 했는지(나, 오케스트레이터 이름)를 붙인다. Naru wakeup turn은
    그 안의 `instruction.created`가 가리키는 지시로 바꾸고, `handoff.resolved`·`intent_contract.approved`가
    `decisions`에 있으면 사람의 말풍선으로 바꾼다(AP-D035). 나머지 이벤트는 한 줄 알림이 된다.
  - 이력은 마지막 page부터 다시 읽는다(답하는 중 2.5초, 아니면 8초, turn이 끝날 때).
  - 에이전트의 질문(`request_human_handoff`, `propose_design_change`)은 도구 묶음에서 빼서 카드로 둔다.
    결과의 handoff id로 열린 질문과 이어 "답하기"를 붙인다(AP-D025).
  - 사람의 Chat turn에 붙는 Naru 메모(열린 질문 알림)는 대화에서 지운다.
- 타임라인은 이벤트에서 만든다: runtime turn(`agent_session.updated` active→idle), 사람 hold, 질문
  (`handoff.requested`), 병합(`artifact.published` commit). 불러온 이벤트보다 오래된 것은 그리지 않는다.

### 6.6.2 작업공간 세로 목록과 위쪽 메뉴 (AP-T22 1단계, AP-D027~D031)

- 저장(AP-D031): project의 `workspaces` 행(Pane 목록과 legacy layout)은 그대로 두고, 작업공간은
  `workspace_views`(DB v21)에 둔다. layout은 `pane`, `slot`(아직 없는 Pane 자리), `split` node로 이뤄지고
  Pane 일부만 담는다. 작업공간마다 `version`이 있다. 사람이 바꾼 Pane 이름은 `panes.custom_title`이다.
  - 읽기: `GET /api/projects/:id/workspace`의 `views`(추가형).
  - 쓰기: `POST/PUT/DELETE /api/projects/:id/views[/:viewId]`, 작업공간 안에서 새 Pane을 만드는
    `POST /api/projects/:id/views/:viewId/panes`, 이름 바꾸기 `PATCH /api/panes/:id`. 모두 사람 기기 lease가
    필요하고, 응답은 전체 `Workspace`다.
  - Pane 끄기는 그 Pane을 모든 작업공간에서 뺀다. 작업공간에서 새로 만든 Pane과 에이전트 Pane은 legacy
    layout에 접힌 채 더해져, legacy layout은 계속 모든 Pane을 담는다.
  - 관제실과 흐름의 에이전트 이름: `GET /api/agent/board`의 `paneNames`(사람이 바꾼 이름)가 있으면 그
    이름을 쓴다.
- 화면 조건: agent API를 제공하는 server(`NARU_AGENT_PLATFORM=1`)에서만 새 화면을 켠다. 그렇지 않으면 가로
  탭 화면 그대로다(e2e가 이 화면을 지킨다).
- 위쪽 메뉴(`MainNav`): `관제실 | 작업공간 | 흐름`, 관제실의 숫자 배지와 "나를 기다림 N". 처음 여는 화면은
  관제실이다. 900px 이하에서는 위쪽 막대 아래 줄로 내려간다. 휴대폰에서도 세 항목이 늘 보인다.
  - `AgentApp`은 메뉴가 고른 화면(관제실, 흐름)을 받고 왼쪽 rail을 그리지 않는다.
  - 1단계에서 대화는 관제실 위에 열리는 화면으로 남는다. 메뉴를 누르면 닫힌다. 2단계에서 에이전트 Pane으로
    옮긴다(AP-D028).
- 작업공간 화면(`WorkspaceScreen`, lazy):
  - 세로 목록: project 이름(누르면 프로젝트 메뉴), 작업공간들(배치 그림, Pane 수), 작업공간 추가, 구분선,
    개별 Pane(이름, `나`/`에이전트`와 상태, 쓰는 사람 표시, ⋯ 메뉴).
  - 1101px 이상은 목록이 왼쪽에 늘 있다. 601~1100px은 목록을 서랍으로 연다. 600px 이하는 목록과 연
    화면을 번갈아 보여 주고, 위쪽 메뉴로 들어오면 목록부터 보인다.
  - 작업공간 화면: 이름, Pane 넣기(새 Pane 또는 이미 있는 Pane), 편집, 집중·분할 보기. 집중 보기와 휴대폰은
    Pane과 빈 자리를 칩으로 고른다. Pane 머리줄의 `―`는 작업공간에서 빼기다(Pane은 계속 실행).
  - 편집: 이름 입력, 작업공간 삭제(두 번 눌러 확인), 목록의 `＋`/`✓`, 목록에서 Pane을 끌어 Pane의
    오른쪽·아래나 빈 자리에 놓기.
  - Pane 하나만 보기: 목록의 Pane을 누르면 그 Pane만 연다. "작업공간에 넣기"로 작업공간에 둔다.
  - 어떤 작업공간·Pane을 열었는지는 project별로 `localStorage`에 둔다.
- 쓰는 사람 표시(AP-D029): agent board의 에이전트(`paneId`, `humanHoldSince`)와 공유 프로세스로 만든다.
  - 내 Pane: `나 · 내 Pane`.
  - 에이전트 Pane: 이름과 `끼어들기`. 끼어들기는 TUI surface의 hold이고, 답하는 중이면 그 차례를 멈춘다.
  - 끼어든 Pane: `나 · 끼어든 중`과 `놓기`. 기존 hold API(`/api/agent/agents/:id/hold`,
    `/api/agent/processes/:id/hold`)를 쓴다.
- 새로 고침: 작업공간 화면은 5초마다(창이 보일 때, focus를 받을 때) 작업공간과 agent board를 다시 읽는다.
  이 기기에서 저장하지 않은 변경이 있으면 건너뛴다.
- 꺼진 에이전트 정리(AP-D033): 관제실 에이전트 목록의 "꺼진 에이전트 정리 N"이
  `POST /api/agent/cleanup`을 부른다. Core `cleanup`이 모든 항목을 먼저 확인한 뒤 항목마다 idempotent
  command로 `retired_at`을 남기고(`agent_session.updated`/`shared_process.updated`, `retired: true`), route가
  남은 Pane을 닫는다. store의 목록 조회는 정리된 행을 빼고, board는 이름을 위해 `retiredAgents`를 따로 준다.

### 6.6.3 멈춘 일 알아차리기와 맡긴 일 카드 (AP-D034)

- 위임 확인: `tools.ts`의 `delegate`는 scope와 다른 인자를 받으면 바로 거부한다. Core `instructionRecipients`가
  지시를 받을 에이전트를 정하고, 모두 사람이 끈 상태면 지시를 만들지 않는다.
- 사람 말 공유: store `listApplicableHumanInstructions`의 `agentWords`로 오케스트레이터는 그 프로젝트
  에이전트에게 사람이 직접 한 agent scope 지시도 받는다.
- 다시 실행: `ManagedAgentSupervisor`의 `autoRelaunch`(index.ts에서 켬)가 `reconcileAfterStart` 뒤와 에이전트가 쓴
  `instruction.created`의 받는 쪽이 꺼져 있을 때 다시 실행한다. 에이전트마다 `RELAUNCH_COOLDOWN_MS`(10분)에 한
  번이다. Claude runner는 이어 띄울 대화에 저장된 메시지가 없으면 새 대화로 시작한다(`resumableRef`).
  차례를 한 번도 받지 않은 에이전트는 ID만 있고 저장된 대화가 없다.
- 실시간 활동: runtime 채널 이벤트 `tool-activity {tool, target}`.
  - Claude runner는 stream의 마지막 `tool_use`에서(`toolActivity`), Codex는 `item/started`에서(`codexActivity`)
    보낸다.
  - supervisor는 차례마다 `turnStartedAt`과 `activity`를 메모리에만 두고 차례가 끝나면 지운다.
  - board가 프로젝트별 `working`과 `globalWorking`으로 준다.
- 멈춤: `agent-platform/stalls.ts`의 `StallMonitor`가 60초마다 열린 작업이 있는 프로젝트를 본다.
  - Core `projectProgress`는 최근 이벤트를 거꾸로 읽는다. 런타임 상태 보고와 멈춤 기록을 건너뛰고 처음 만난
    이벤트가 마지막 진행(`lastProgressAt`)이다. 그 뒤의 `project.stalled` 기록이 지금의 멈춤이다. 단계는 가장 새
    기록, `since`는 가장 오래된 기록에서 온다.
  - 사람을 기다리는 것(열린 handoff, 승인 전 의도 계약, hold, 도구 승인)이나 일하는 에이전트가 있으면 건너뛴다.
  - 진행 없이 `minutes`가 지나면 stage `orchestrator`를 기록한다(오케스트레이터 wakeup). 마지막 기록부터 다시
    `minutes`가 지나면 `person`을 기록한다. `stallCause`가 작업 상태와 에이전트 상태로 원인을 고른다.
  - board의 `stall`은 stage `person`일 때만 준다. `POST /api/agent/projects/:id/nudge`는 사람 actor의
    `orchestrator` 기록이다.
  - `person` 기록은 `WebPushNotificationService.notifyStall`로 기기에 간다. payload는 ID와 원인뿐이다
    (`PushStallPayload`). service worker는 프로젝트마다 알림 하나(`naru:stall:<projectId>`)를 두고, 누르면
    `NARU_PUSH_STALL` 메시지나 `naruStall` 주소로 관제실을 연다.
- 맡긴 일: `GET /api/agent/jobs`는 Core `listJobs`다. 사람의 최근 목표 40개 가운데 작업이 있거나, 30분 안에
  오케스트레이터가 받은 목표를 12개까지 준다. 작업마다 리뷰 종류별 최신 결과와 최신 Run을 붙인다.
  - web: `AgentApp`이 board와 함께 3초마다 읽어 context의 `jobs`와 `working`으로 준다.
  - `jobs-model.ts`(순수 함수)가 큰 그림 단계, 작업 번호(의존 순서), 작업별 작업·검증·병합, "지금" 줄을
    정한다. `JobCards.tsx`가 그린다.
  - 받은함 항목 `stall`은 승인 다음, 결정 앞에 둔다. 에이전트 목록 줄에는 실행 중인 도구가 한 줄 더 붙는다.

### 6.6.4 맡긴 일 완료하기와 다시 열기 (AP-D036)

- 저장: DB v23 `agent_jobs`(`goal_instruction_id`, `round`, `completed_at`, `retired_json`). 다음 라운드의 말은
  사람 지시이고 `origin_user_instruction_id`가 목표를 가리킨다. store `listHumanGoals`는 이런 지시를 목표에서 빼고
  최근 라운드 순으로 정렬한다. `listGoalWork`는 라운드 지시와 그것을 인용한 위임·작업을 같은 목표로 묶는다.
- Core:
  - `jobCompletionPlan`: 그 일의 작업자·리뷰어와 남길 이유(`held`, `other-work`), Naru가 만든 워크트리와 병합 커밋.
  - `completeJob`: 열린 작업이 없을 때만 받는다. 넘겨받은 에이전트를 stopped·retired로 기록하고 `job.completed`를
    남긴다. 재시도는 목표 id만으로 같은 명령이 된다.
  - `reopenJob`: 라운드 지시를 만들고 에이전트를 되살린다. 되살린 기록은 라운드 지시 id를 `correlationId`로 가져,
    재시도해도 누구를 되살렸는지 다시 찾는다.
- `agent-runtime/jobs.ts`의 `JobLifecycle`이 실행 쪽을 맡는다.
  - 완료: 계획을 읽고 runtime에서 지금 차례 중이거나 승인을 기다리는 에이전트를 남긴다(`working`). Core에 먼저
    기록하고, 연결된 runner에 stop을 보내 10초까지 연결이 끊기길 기다린 뒤 Pane을 지운다. 끝나지 않은 TUI나 runner는
    Pane과 함께 끝난다.
  - 워크트리: `AgentWorkspace.removeMergedWorktree`가 안전 조건(AP-D036)을 확인하고 `worktree remove`·`branch -d`
    뒤 Naru project 연결을 푼다. 실행 중인 Pane은 Host의 `isRunning`으로 본다.
  - 다시 열기: 되살린 에이전트 가운데 꺼진 것을 `launch`한다. 계획의 `resumeRef`로 대화를 이어 가고, Claude
    runner는 저장된 대화가 없으면 새로 시작한다(`resumableRef`).
- wakeup: `job.completed`·`job.reopened`는 알림만이다. 정리하거나 되살린 기록(`retired`), 정리된 에이전트의
  상태 보고는 오케스트레이터를 깨우지 않는다. 라운드 지시의 `instruction.created`는 평소처럼 깨운다.
- web:
  - `jobs-model.ts`의 `awaitingCompletion`·`jobCompleted`, `stageStates(stage, completed)`. 다시 연 일은 라운드
    지시 뒤에 움직인 작업이 없으면 "계획"이다.
  - 받은함 항목 `job`("완료 확인")은 의도 계약 다음, 맨 뒤다.
  - 완료 확인·결과·다시 열기 창은 `JobSheets.tsx`다. `AgentApp`이 열 때의 일을 붙잡아 두므로, 완료해 받은함에서
    빠져도 결과 창이 남는다.
