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
    hook, 역할별 model, `--setting-sources project,local`을 함께 넣는다.
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
- orchestrator 역할의 에이전트는 대화가 준비되면 wakeup 대상에 등록된다(AP-T16에서 지시 형식을
  완성한다).
- runtime 상태(`GET /runtime`)는 writer, generation, 형태, 대기 중인 승인, 실행 중인 보조 에이전트를
  보여 준다. 보조 에이전트는 관찰만 한다(AP-D014).

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
