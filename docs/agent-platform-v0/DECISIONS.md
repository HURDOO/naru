# Agent Platform v0 결정 기록

목표 명세 원문은 [SOURCE_SPEC.md](SOURCE_SPEC.md)다. 아래 결정은 원문과 기존 Naru·DurableSession·Workstation
계약 사이의 충돌을 해소한다. 완료된 기존 결정은 소급 수정하지 않는다. 기존 계약을 대체하는 부분은
해당 구현 Task에서 versioning, consumer 호환성, migration과 함께 적용한다.

상태 값은 세 가지다.

- `direction-approved`: 사용자가 방향을 승인했다. 세부 계약은 Gate 1(AP-T08)의 검증 증거로 확정한다.
- `accepted`: 확정됐다.
- `proposed`: 아직 승인 전이다.

## AP-D001. 프로그램 경계와 원장

- 상태: accepted (2026-10-15)
- 결정: Naru Agent Platform 전환은 `docs/agent-platform-v0/`의 독립 program으로 진행하고 상태는
  [TASKS.md](TASKS.md) 한 곳에서 관리한다.
  - 사용자 원문 명세는 `SOURCE_SPEC.md`에 보존한다. prettier 공백 정리만 했고 문장은 바꾸지 않았다.
  - 원문 명세의 산출물 `docs/naru-vnext/00~06`은 저장소 관례에 맞춰 이 디렉터리의 `AUDIT`,
    `VALIDATION`, `DECISIONS`, `TASKS`, 그리고 이후의 `ARCHITECTURE`, `ACCEPTANCE`, `OPERATIONS`,
    `LIMITATIONS`로 대응시킨다.
- 이유: Gateway, Naru, DurableSession은 하나의 monorepo다. 기존 program(`workstation-v0`,
  `private-ingress-v0`)과 같은 경계를 쓰면 계약 문서와 원장이 한 곳에 모인다.

## AP-D002. 원문 저장 경계: Naru가 원본인 데이터만 저장한다

- 상태: accepted (2026-10-15; 방향은 사용자가 승인했고 세부는 Gate 1 검증으로 확정했다)
- 배경: 기존 Naru는 terminal과 Codex·Claude 원문을 저장하지 않는다. DB에는 Project, Pane, layout,
  activity, 런타임 session ID만 있고, 대화 원문은 런타임(`~/.codex`, Claude JSONL)이 소유한다
  (SPEC "terminal/Codex 원문은 영구 저장하지 않는다", DurableSession v0 비목표).
- 결정: Naru가 원본(source of truth)인 데이터는 저장하고, 런타임이 원본인 데이터는 복제하지 않는다.

  저장하는 것:
  - Naru UI(Chat, Inbox, Project)에서 입력한 사용자 지시. 불변 원문, ID, 범위를 저장하고 수정은
    supersede 관계로 남긴다.
  - Naru가 관리하는 agent session에서 사용자가 TUI에 직접 제출한 prompt. 원문을 저장한다. 사용자가
    만든 기존 Pane에는 적용하지 않는다.
  - Naru MCP를 거친 에이전트 간 위임 메시지 원문
  - Intent Contract, Plan, Task, Handoff, 설계 변경 제안, 리뷰 판정, 사용자 결정, Manual Test 결과.
    idempotency key를 함께 저장한다.

  메타데이터와 참조만 저장하는 것:
  - Event Store: 유형, 행위자, 대상, 상관 ID, idempotency key, 처리 상태. 본문은 위 도메인 테이블을
    참조한다.
  - Artifact: commit, branch, 경로, 테스트 명령, exit code, 요약 수치

  저장하지 않는 것:
  - 에이전트 대화와 도구 출력. 런타임 API로 다시 읽는다.
  - terminal 출력. 지금처럼 메모리에 bounded로만 둔다.
  - 비밀 입력
  - 구조화 로그와 Push의 본문

- 이유:
  - 원본 지시가 재해석으로 대체되지 않으려면 Naru가 원본을 소유해야 한다(INV-01, INV-08).
  - 런타임 대화는 compact되거나 삭제되고 형식도 다르다. 복제하면 동기화 문제와 유출면만 늘어난다.
  - Event에 본문을 복제하면 삭제와 정정이 append-only 로그와 충돌한다. 오케스트레이터 wakeup의
    컨텍스트도 커진다. 자동 신호 출처에 섞인 원문이 저장되는 경로도 생긴다.
- 전제와 검증: "런타임 공식 API만으로 대화 이력 전체를 다시 구성할 수 있는가"를 V02, V03, V12에서
  확인한다. 안 되면 bounded cache를 별도 결정으로 다룬다.
- 결과: DB 백업에 지시 원문이 포함된다. 백업은 지금처럼 owner-only를 유지한다. Project 삭제는
  지시를 cascade 삭제한다. 사용자가 요청하면 개별 지시를 영구 삭제(forget)할 수 있다.

## AP-D003. terminal 입력 기록과 비밀 입력

- 상태: accepted (2026-10-15)
- 결정:
  - 사람이 PTY에 입력한 key는 기록하지 않는다. 기존 경계를 그대로 유지한다.
  - 에이전트가 Naru MCP로 PTY에 보낸 입력은 원문을 기록한다. Activity 표시, 감사, 그리고 재시작
    뒤 같은 명령의 중복 전송을 막는 데 쓴다. 에이전트의 native shell 실행은 런타임 기록에 남으며
    Naru는 저장하지 않는다.
  - Host나 Naru는 echo나 termios 상태로 비밀번호 프롬프트를 감지하지 않는다. 화면에 비밀번호나
    비밀 입력 요구가 나타나면 **에이전트가 스스로 판단해** TERMINAL_CONTROL handoff를 요청한다.
    이 행동 규칙은 Skill과 지침에 둔다. 에이전트에게는 비밀값을 제공하지 않는다.
  - 사람은 필요할 때 Naru UI에서 secure input을 켠다. secure input으로 넣은 bytes는 PTY에만 전달하고
    observer 중계, 기록, 로그, draft 저장 경로를 거치지 않는다.
- 이유: full-screen TUI도 echo를 끄기 때문에 terminal 모드 감지는 오탐이 많다. macOS PTY의 상태를
  믿을 만하게 읽을 수 있는지도 확인되지 않았다. 판단은 LLM에, 강제 경계(비밀값 미제공, 기록 경로
  분리)는 코드에 둔다는 INV-02의 원칙을 따른다.
- 검증: 사람 입력 경로가 어디에도 남지 않는지, secure input을 넣을 수 있는 위치는 V10에서 감사한다.

## AP-D004. Agent-facing Naru MCP

- 상태: accepted (2026-10-15; 방향은 사용자가 승인했고 세부는 Gate 1 검증으로 확정했다)
- 배경: DurableSession v0와 LIMITATIONS는 MCP server를 비목표로 두었지만, Core API를 transport와
  무관하게 설계했고 `readEvents`와 `waitForEvents`를 MCP-ready로 남겨 두었다.
- 결정:
  - Naru가 띄운 agent session에만 stdio MCP server(Naru에 포함된 bin)를 주입한다.
  - MCP server는 owner-only UDS로 Naru Core API를 호출한다. 네트워크 listener는 열지 않는다.
  - Host 접근은 Naru를 경유하고, Host는 기존 capability 검사를 유지한다.
- 범위:

  | 단계 | 내용                                                                                         |
  | ---- | -------------------------------------------------------------------------------------------- |
  | L1   | 오케스트레이션: 상태와 지시 조회, plan, delegate, progress, artifact, review, 설계 변경 제안 |
  | L2   | DurableSession: 목록, 관찰, 생성, controller일 때 입력, 제어 request/release, 자기 세션 stop |
  | L3   | agent와 런타임: managed agent 생성, 메시지, interrupt, Run과 자식 조회                       |
  | L4   | 사람 채널: Handoff와 push, Manual Test 환경                                                  |
  | L5   | Workspace와 UI: 정책 범위의 worktree 생성, Pane 열기(에이전트가 열었음을 표시), project 연결 |
  | L6   | merge gate: 리뷰와 승인 상태 조회, gate 통과 시 merge                                        |

- 노출 금지: Gateway, distribution, 운영(install, upgrade, reconfigure, DNS, TLS), passkey와 인증,
  사용자 제어권 preempt, Naru 설정(root, profile), 다른 project 범위 데이터, terminal 원문 대량 export.
- 결과: L6은 MCP만으로 강제할 수 없다. 에이전트가 native git을 쓸 수 있기 때문이다. main 보호 장치는
  Phase 2에서 별도 결정으로 다루고, project별 설치는 사용자 승인을 받는다. wakeup은 MCP notification이
  아니라 Naru의 turn 트리거로 한다.

## AP-D005. 쓰기 권리의 세 계층과 사람 개입 hold

- 상태: accepted (2026-10-15; 방향은 사용자가 승인했고 세부는 Gate 1 검증으로 확정했다)
- 배경: 지금 Naru `LeaseManager`(`apps/server/src/lease.ts`)는 instance 전체에서 한 browser만
  controller로 둔다. 이 lease가 모든 terminal 입력과 HTTP 변경을 통제한다. Host는 이미 Session별
  controller, generation fencing, preempt를 제공한다.
- 결정: 쓰기 권리를 세 계층으로 나눈다.
  1. **사람 기기 lease**: 사용자의 기기 중 하나만 사람 입력 기기가 된다. 기존과 같다. 범위는 사람
     입력으로 좁힌다. 에이전트의 동작은 이 lease를 거치지 않는다.
  2. **Session holder**: `human` 또는 `agent:<id>`. 기본값은 Session을 만든 쪽이다.
     - 사용자가 만든 기존 Pane에서는 에이전트가 request만 할 수 있고, 승인은 사람이 한다.
     - 사람이 개입(takeover)하면 `human_hold`가 걸린다. hold는 특정 기기가 아니라 사람에게 붙는다.
     - hold는 세 경우에 에이전트에게 자동 반환된다: 명시적 반납, 연결 끊김 뒤 유예 시간 초과,
       입력 없는 idle 시간 초과. 두 시간 값은 운영 설정으로 마지막에 정한다(AP-D007).
     - 에이전트는 새 generation으로 다시 획득하고, 입력 전에 snapshot을 다시 읽는다.
     - 에이전트에게는 preempt를 주지 않는다.
  3. **대화 writer**: agent 대화에 turn을 넣을 주체(Chat, TUI, orchestrator). 세부 protocol은
     V01~V03 결과로 확정한다.
- 개입 방식은 두 가지다.
  - "지시만 보내기": hold 없이 다음 turn에 반영한다.
  - "직접 개입": hold를 건다. hold 중 orchestrator의 send, delegate, interrupt는
    `AGENT_HELD_BY_HUMAN`으로 거부하고 queue에 쌓지 않는다. 읽기와 다른 독립 작업은 허용한다.
- hold가 끝나면 `agent.hold_released` 이벤트(사유, 기간, hold 중 생성된 instruction과 session 참조)로
  orchestrator를 깨운다. 사람이 orchestrator 자체를 hold하면 그동안 이벤트를 쌓았다가 해제 시 한
  묶음으로 전달한다.
- 이유: 쌓아 둔 메시지는 개입 전 상태를 기준으로 작성됐다. 그대로 전달하면 사람이 바꾼 방향을 덮어쓸
  수 있다(INV-08). 거부하면 orchestrator가 최신 상태로 다시 판단하게 된다.
- 결과: SPEC의 "한 active controller"와 LIMITATIONS의 "instance 전체 한 controller surface"는 구현
  Task에서 새 계약과 migration으로 대체한다. 다중 사람 접속(T38)과는 별개다.

## AP-D006. 에이전트의 Session 생성

- 상태: accepted (2026-10-15)
- 결정:
  - 에이전트는 Naru MCP로만 DurableSession을 만든다. 예: dev server, ansible, managed worker.
  - Naru가 project, task, run, agent, 목적, 명령, 포트 바인딩을 먼저 기록한 뒤 같은 idempotency key로
    Host Session을 만든다.
  - cwd는 project `realpath` 안으로 제한한다.
  - 바인딩이 없는 Session은 reconciler가 찾아 표시한다.
  - 에이전트에게 DS CLI credential을 직접 주지 않는다.
- 결과: Host의 `session:create:arbitrary` 정책을 agent principal 범위로 여는 방식은 Phase 2 보안
  검토에서 확정한다.

## AP-D007. 검증 기간의 사용량과 운영 한도

- 상태: accepted (2026-10-15)
- 결정: 검증과 개발 기간에는 Codex, Claude, OmO를 실제 모델로 넉넉히 사용한다. 운영 한도(예산, 동시
  실행, heartbeat, hold 유예와 idle 시간)는 개발과 사람 테스트를 마친 뒤 마지막에 정한다.

## AP-D008. Phase 1 검증 방식과 위임

- 상태: accepted (2026-10-15)
- 결정:
  - 런타임별 검증은 별도 spike branch와 worktree에서 수행한다. Codex 계열은 사용자가 Sol 또는
    Astra로 실행하고, Claude와 OpenCode 계열은 integration이 위임한다.
  - 운영 Host, Naru, Gateway와 전역 daemon은 건드리지 않는다. Host 검증은 격리 Host에서 한다.
  - 원문 로그는 저장소 밖 owner-only 디렉터리에 두고, 저장소에는 redacted 보고서와 재현 스크립트만
    둔다.
  - 판정은 설치 버전에서 재현한 동작만으로 한다.

## AP-D009. Native subagent는 L1·L2 관찰용으로 유지하고 강제 억제를 주장하지 않는다

- 상태: accepted (2026-10-15, Gate 1 근거: V04, V05, V12)
- 근거:
  - Claude는 L1·L2가 PASS이고 L3·L4는 FAIL이다. `--disallowedTools Task Agent`로 subagent tool을 제거할
    수 있다.
  - Codex는 L1·L2가 PASS이고, 실행 중인 child에 직접 입력하거나 steer하는 것은 거부된다. 기능
    플래그를 꺼도 실제 spawn이 성공했다.
  - OmO child는 L1~L3가 PASS이고 독립 PTY가 없다.
- 결정:
  - 일반 작업에는 native subagent를 쓰고 관찰 수준은 `transcript`로 기록한다.
  - 실행 중 사람이 직접 개입해야 하거나(L3) 독립 터미널이 필요한(L4) 작업은 Skill 지침에 따라 Naru
    managed agent로 보낸다.
  - Codex에서는 native 억제를 보안 강제 수단으로 주장하지 않는다. 지침은 강제 수단이 아니라고 명시한다.
    Claude의 tool 제거는 managed 세션 설정에서 선택적으로 쓴다.
  - Agent Teams(Claude)는 interactive 전용이고 실험적이므로 오케스트레이터 기반에 쓰지 않는다.

## AP-D010. 관리형 세션 간 통신은 Naru MCP 경로를 기본으로 한다

- 상태: accepted (2026-10-15, 근거: V06, V08). 일반 Pane 적용 범위는 사용자 확인 대기다.
- 결정:
  - managed 세션 사이의 메시지는 `delegate` 같은 Naru MCP 도구로 보낸다. Naru가 발신자 신원
    (capability), 원문, 원본 지시 ID를 기록한다.
  - managed Claude 세션에서는 native cross-session을 다음과 같이 차단하고 subagent 메시징은 유지한다.
    - inbound는 `crossSessionInbound: "refuse"`로 막는다.
    - 발신은 PreToolUse hook으로 막되, SubagentStart로 수집한 agent ID만 허용한다.
  - 사용자가 만든 일반 Claude Pane은 바꾸지 않는다(권고, 사용자 확인 대기).
- 이유: native 메시징은 발신자가 스스로 정한 이름이고 원본 지시를 담을 필드가 없으며, 기본 설정에서는
  Naru를 거치지 않고 작업을 만들 수 있다.

## AP-D011. 관리형 런타임과 대화 writer

- 상태: accepted (2026-10-15, Gate 1 근거: V01~V03, V11, V12). Claude runner를 DurableSession에서
  실행하는 방식은 V11(Codex)과 같은 구조다. 동작 여부는 AP-T14 구현 테스트에서 확인한다.
- 공통:
  - 런타임의 동시 입력 중재는 믿지 않는다. Claude, OpenCode, Codex 모두 동시 입력이 진행 중인 turn에
    합쳐지거나 유실됐다.
  - 그래서 Naru가 agent 대화마다 single writer를 강제한다.
  - 사람 개입 hold(AP-D005)도 같은 writer gate에서 처리한다.
- Claude:
  - 관리형 세션은 Claude Agent SDK runner로 실행한다. runner는 DurableSession PTY에서 관찰용
    console을 소유한다.
  - protocol은 PTY를 거치지 않고 pipe와 owner-only socket으로 주고받는다.
  - TUI 전환은 stop 후 resume(B안)이다. turn을 끝내거나 interrupt한 뒤 runner를 종료하고, 기존 Claude
    Pane resume(D023)으로 연다. `SessionStart` resume이 같은 ID로 확인된 뒤에만 입력을 연다. 실패하면
    rollback한다.
  - `--bg`와 `claude attach`는 쓰지 않는다.
  - Chat 이력은 SDK의 공식 history API로 다시 읽는다.
- OpenCode:
  - Naru가 별도 `opencode serve`를 띄우고, 같은 세션에 `opencode attach` TUI를 DurableSession PTY로
    붙인다. 이렇게 하면 GUI와 TUI가 live로 공존한다.
  - 쓰기는 Naru proxy의 gate만 통과시킨다. 신원과 이벤트는 Naru plugin(`OPENCODE_CONFIG_CONTENT`)으로
    받는다. 운영 `/omo/` adapter는 바꾸지 않는다.
- Codex:
  - 공유 app-server와 relay의 single-writer proxy(A안)를 기본으로 한다. 기존 Codex Pane의 relay에 GUI
    channel을 추가하면 실제 TUI와 Chat이 같은 thread를 live로 공유한다.
  - proxy의 기본값은 deny다. 분류된 read와 ID만 지정한 resume만 허용한다.
  - 승인 응답은 writer에게만 허용한다. writer 이전은 turn 경계나 명시적 interrupt 뒤에만 한다.
  - B안(app-server 종료 → resume)은 crash와 이전 실패 때의 복구 경로로 둔다.
  - headless 관리형 agent는 Host가 소유한 app-server와 redacted lifecycle console 구조(V11)로 실행한다.
    console은 TUI가 아니라 관찰용 console로 표시한다.
- 역할별 model은 항상 명시한다. Claude는 사용자 settings 없이 실행하면 기본값이 haiku가 된다.

## AP-D012. Claude Agent SDK 공급 방식

- 상태: accepted (2026-10-15, 사용자 결정 B)
- 결정:
  - Claude Agent SDK는 사용자가 Claude CLI처럼 따로 설치하는 runtime 구성요소로 둔다.
  - Naru는 설정된 경로에서 SDK를 동적으로 불러오고, `ClaudeSdkPort` 뒤에서만 쓴다.
  - 저장소, lockfile, 배포물에는 포함하지 않는다. optional platform binary는 설치하지 않고 기존 CLI를
    `pathToClaudeCodeExecutable`로 쓴다.
  - 업데이트는 `update-agent-clis` 흐름에 추가한다.
- 배경: SDK는 독점 라이선스이고 약 230MB 바이너리가 딸려 있다. Chat 이력을 공식 경로로 다시 읽는 기능은
  SDK에만 있다. A(CLI만)와 C(포함)는 채택하지 않았다.

## AP-D013. Gate 1에서 사용자 확인이 필요한 항목

- 상태: accepted (2026-10-16, 사용자 확인). 1~3은 기본값대로 두고, 4는 AP-D020으로 바꿨다.
- 1. OmO child 이력(V12): OmO가 끝난 subagent 세션을 10분 뒤 삭제한다.
  - 기본값: Naru는 저장하지 않는다. 실시간 관찰만 하고, 나중에 검토가 필요한 작업은 Naru managed agent로
    보낸다.
  - 대안: 완료 시 이력을 export한다. 이 경우 AP-D002의 예외가 된다.
- 2. 관리형 OpenCode 세션이 운영 `/omo/` 목록에도 보이는 문제.
  - 기본값: 허용하고 "Naru 관리" 표시를 붙인다.
  - 대안: data dir을 분리한다. 이 경우 provider에 다시 로그인해야 한다.
- 3. native cross-session 차단 범위(V06).
  - 기본값: managed 세션에만 적용한다. 일반 Claude Pane은 그대로 둔다.
- 4. 관리형 Claude 세션이 사용자 global settings와 hook을 불러올지(V03).
  - 기본값: 불러오지 않는다. `--setting-sources project,local`과 Naru 설정만 주입한다.
- 공지: agent 신원은 같은 OS 사용자 권한 아래의 책임 추적 수단이며 격리 장치가 아니다(V13).

## AP-D014. 보조 에이전트는 관찰만 하고, 통제가 필요한 일은 새 관리형 세션으로 보낸다

- 상태: accepted (2026-10-15, 사용자 승인). 재검증 V04b·V05b를 근거로 AP-D009의 L3·L4 판단을 대체한다.
- 근거:
  - Claude는 TUI 안에서 실행 중인 보조 에이전트에 입력할 수 있다(V05b). API 경로로는 할 수 없다(V05).
  - Codex는 TUI에서 보기만 되고, 직접 입력은 Codex가 막아 두었다(V04b).
  - OmO는 API로 직접 입력이 되지만, 끝난 child를 10분 뒤 삭제한다(V12).
- 결정안:
  - Naru는 보조 에이전트를 부모 에이전트 아래에 **관찰 전용**으로 표시한다(L1 lifecycle, L2 transcript).
    Naru Chat에서 보조 에이전트에게 입력하는 기능은 만들지 않는다. 사람의 개입이 꼭 필요하면 각
    런타임의 TUI를 그대로 쓴다(Claude만 가능). 그래서 Claude 관리형 세션을 TUI 모드로 강제하지 않는다.
  - 보조 에이전트가 한 일은 부모 에이전트의 책임으로 기록한다. Naru provenance의 단위는 관리형 세션이다.
  - Skill 지침:
    - 보조 에이전트는 한 Task 안의 짧고 읽기 위주인 하위 작업에 쓴다. 예: 조사, 분석, 초안, 테스트 실행.
    - 다음 경우에는 Naru `delegate`로 새 관리형 세션을 띄운다:
      - 자기 완료 조건이나 review가 필요한 별도 작업
      - 오래 걸리는 작업
      - 공유 코드, branch, worktree를 바꾸는 작업
      - 사람의 결정, 터미널 입력, 수동 테스트가 필요한 작업
      - 다른 런타임이나 model이 필요한 작업
      - 재시작이나 인계를 견뎌야 하는 작업
  - 지침은 강제 수단이 아니다. native 억제를 보안 통제로 주장하지 않는다(AP-D009 유지).
- 남은 일: `skills/naru-orchestration`(AP-T16)에 반영한다.

## AP-D015. Claude끼리의 메시지는 Naru bridge 아래에서 native로 보낸다

- 상태: accepted (2026-10-15, 사용자 방향 승인과 V06b PASS). AP-D010의 "managed 세션에서는 native
  cross-session 차단"을 대체한다. Codex↔Claude 같은 런타임 간 통신은 계속 Naru MCP로 한다.
- 결정: Naru가 띄우는 관리형 Claude 세션에는 세션별 capability를 가진 bridge hook을 넣는다.
  - 보내는 쪽 `PreToolUse(SendMessage)`: 받는 쪽이 관리형 세션인지, hold 중이 아닌지 Naru가 확인한다.
    허가하면 원문, 보낸 쪽, 받는 쪽, 원본 지시를 위임 기록으로 남긴다. 원본 지시는 보낸 쪽이 맡은 Task에서
    정한다.
  - 받는 쪽 `UserPromptSubmit`: 허가 기록과 보낸 쪽 PID(`uds` 소켓, `verifiedPeerPid`)가 맞을 때만
    통과시키고, 전달을 기록한다.
  - Naru에 닿지 못하면 보내기와 받기 모두 거부한다(fail-closed).
  - 관리형 세션의 inbound는 `accept`로 둔다. 쉬고 있는 TUI와 runner 세션을 native 메시지가 바로 깨운다.
  - 보조 에이전트 메시징(`recipient_kind: agent`)은 bridge를 거치지 않는다.
- 구현(2026-10-15):
  - Core의 `authorizeNativeMessage`와 `deliverNativeMessage`
  - hook-only socket tool, `agent-hook-cli` bin, `naruClaudeHookSettings`
  - v20 `agent_native_messages`와 channel `native-message`
  - 관리형 세션의 native 이름은 `naru-<agent session ID 앞 12자>`다.
  - 원본 지시는 보낸 쪽의 진행 중 Task가 있으면 그 Task의 것을, 없으면 그 에이전트에게 적용되는 최신 사용자
    지시를 쓴다. 둘 다 없으면 거부한다.
  - 실제 Claude 세션 3개로 V06c 5단계가 모두 통과했다.

## AP-D016. Naru MCP L2~L6의 세부 범위: worktree, fast-forward merge, 사람 채널

- 상태: accepted (2026-10-16, 사용자 확인). L6 merge 방식은 AP-D019로 바꿨다.
- 배경: AP-D004가 L1~L6을 정했고, 사용자는 L5·L6을 포함하라고 했다(K2). merge 방식과 main 보호는
  아직 정하지 않았다.
- 결정(기본값):
  - L5 worktree(`create_worktree`, project orchestrator):
    - 위치와 이름
      - 위치: project 옆 `<project>-<slug>-<task 앞 8자>`
      - branch: `naru/<slug>-<task 앞 8자>`, project의 현재 HEAD에서 만든다.
    - 경로는 realpath 기준으로 승인된 project root 안이어야 한다.
    - 만든 worktree는 Naru project로 연결한다. 같은 저장소 묶음에 보인다. branch는 Task의 artifact로
      남는다.
    - 그 worktree는 부모 project에 묶인다. 부모 project의 에이전트는 그 안에서 공유 프로세스 등을 쓸 수
      있다. 다른 project의 에이전트는 쓸 수 없다.
  - L5 Pane(`open_pane`, orchestrator·worker·specialist):
    - Files·Docs Pane만 연다. 접힌 채 들어가고 제목에 `· agent`를 붙인다.
    - Docs는 `docs/` 아래 문서만 연다. 경로는 기존 문서·파일 reader로 project 안인지 확인한다.
    - terminal은 기존 `start_process`를 쓴다.
  - L6 merge(`merge_task`, project orchestrator):
    - 조건: merge gate가 열려 있어야 한다(정확성·의도 리뷰 통과, 막는 Handoff 없음). 대상은 Task의
      최신 branch artifact다.
    - 대상 branch는 project 경로에 checkout된 branch다. 그 checkout에 추적 파일 변경이 있으면 거부한다.
    - `git merge --ff-only`만 쓴다.
      - merge commit을 만들지 않고, 사람의 checkout에 충돌을 남기지 않는다.
      - 갈라진 branch는 worktree에서 rebase하고 다시 리뷰받은 뒤 merge한다(A15).
    - push는 하지 않는다. 원격 저장소 변경은 사용자 승인 경계다.
    - 결과 commit을 Task의 artifact로 남긴다.
    - 한계: 에이전트는 native git으로 이 규칙을 우회할 수 있다(AP-D004). Naru는 project에 hook을
      설치하지 않는다. 설치하려면 project별 사용자 승인이 필요하다.
    - git 명령 하나는 8초 안에 끝나야 한다(agent socket idle 시간보다 짧게). 큰 저장소의 worktree 생성은
      이 시간을 넘을 수 있다.
  - L3 agent(project orchestrator):
    - `list_agents`, `get_task_detail`로 상태를 본다.
    - `interrupt_agent`는 작업자·리뷰어·전문가의 turn만 멈춘다. 사람이 hold했거나 대화 writer가 사람이면
      거부한다.
  - L4 사람 채널:
    - Handoff가 요청되면 Naru가 Web Push를 보낸다. 내용은 ID와 종류만 담는다. 사람이 최근 활동 중이면
      보내지 않는다.
    - 알림을 열면 그 project의 Inbox 항목이 열린다. project 없는 전역 Handoff는 아직 push하지 않는다.
  - L2 범위:
    - 에이전트는 자기 project와 묶인 worktree의 공유 프로세스만 목록으로 보고, 관찰하고, 입력하고,
      정지한다.
    - 사람이 직접 연 terminal Pane은 에이전트에게 보이지 않는다. 화면 내용이 민감할 수 있기 때문이다
      (AP-D003).
    - 제어권은 사람이 hold하고 반환한다. 에이전트는 Handoff로 요청한다.
- 대안:
  - Naru 신원으로 `--no-ff` merge commit을 만든다.
  - worktree 위치를 설정으로 지정한다.
  - merge 뒤 push한다. 사용자 승인 없이는 하지 않는다.

## AP-D017. orchestrator가 대화를 쓰는 동안의 도구 승인

- 상태: accepted (2026-10-16, 사용자 확인). 승인 대기 알림은 AP-D021로 더했다.
- 배경:
  - 관리형 에이전트의 도구 승인 요청은 대화 writer만 답할 수 있었다.
  - orchestrator는 승인에 답하는 도구가 없다. 그래서 orchestrator가 writer일 때(자율 진행)는 첫 명령이나
    편집 요청에서 에이전트가 멈췄다. AP-T18 실제 모델 인수를 준비하다가 확인했다.
- 결정(기본값):
  - Naru MCP 도구는 사람의 승인을 묻지 않는다. Core가 역할, scope, hold를 이미 판단한다.
    - Claude: 주입 settings의 `permissions.allow`에 `mcp__naru`를 넣는다.
    - Codex: relay가 `naru` 서버의 MCP 사용 확인에 직접 답한다.
  - 작업자와 전문가는 작업 디렉터리 안의 파일 편집을 묻지 않는다(Claude `acceptEdits`).
    - orchestrator와 리뷰어는 기본 모드다.
    - 범위는 Claude가 정한 작업 디렉터리다. main 반영은 리뷰와 merge gate가 지킨다(AP-D016).
  - 그 밖의 요청(명령 실행, 권한 확대 등)은 사람이 정한다.
    - 요청에는 무엇을 하려는지(도구와 명령 또는 경로, 300자)가 붙는다. 화면에만 보이고 저장하지 않는다.
    - 사람은 대화를 넘겨받지 않아도 Agent Panel과 Inbox에서 답한다(기기 lease 필요). TUI에서 먼저 답하면
      두 번째 답은 무시된다.
    - project의 `.claude/settings*.json` 권한 규칙(사용자가 관리)은 그대로 적용된다. 자주 쓰는 명령은
      거기서 미리 허용할 수 있다.
- 하지 않은 것:
  - 승인 대기 Web Push(Handoff push와 같은 방식으로 추가할 수 있다)
  - Codex의 sandbox·approval policy 변경. Codex는 profile의 기존 설정을 따른다.
- 대안:
  - 명령도 project 단위로 자동 허용한다(사용자가 project별로 켬).
  - 모든 편집을 묻는다(자율성은 낮아진다).

## AP-D018. OpenCode 관리형 어댑터는 v0에서 미룬다

- 상태: accepted (2026-10-16, 사용자 확인). AP-T15("구현 여부와 범위는 V12 결과로 정한다")의 결정이다.
- 근거(V12):
  - OpenCode는 공식 `serve` API와 `attach`로 진짜 live 공유가 되는 유일한 런타임이다.
  - 관리형으로 만들려면 다음이 필요하다.
    - Naru가 띄우는 별도 `opencode serve`
    - 세션별 신원을 위한 plugin(`OPENCODE_CONFIG_CONTENT`)
    - 동시 write를 막을 Naru proxy. TUI(`attach`)도 이 proxy를 거쳐야 하므로 새 local HTTP listener가
      생긴다.
  - 사용자 결정이 남아 있다(AP-D013 1·2): OmO가 10분 뒤 지우는 child 이력, 운영 `/omo/` 목록에 관리형
    세션이 보이는 문제.
  - A01~A16 인수 시나리오는 OpenCode를 요구하지 않는다. Claude와 Codex 관리형 경로로 모두 다룬다.
- 결정안:
  - v0에서는 OpenCode 관리형 어댑터를 만들지 않는다.
  - 운영 `/omo/`는 지금처럼 그대로 쓴다.
  - Naru Agent Platform의 런타임은 Claude와 Codex다. `AgentRuntimeSchema`의 `opencode` 값은 계약에
    남긴다. 이 값으로 등록할 수 있지만 Naru가 실행하지는 않는다.
- 다시 열 조건:
  - 사용자가 AP-D013 1·2를 정한다.
  - OmO 관리형 세션이 필요한 실제 작업이 생긴다.
  - proxy listener의 보안 검토를 마친다.

## AP-D019. merge_task는 merge commit으로 통합한다

- 상태: accepted (2026-10-16, 사용자 결정). AP-D016의 L6 merge 방식(`--ff-only`)을 대체한다. 다른 L6
  조건(merge gate, 깨끗한 checkout, push 없음, 결과 commit artifact)은 그대로다.
- 배경: 사용자는 merge도 에이전트에게 맡기는 것이 보통이라며 merge commit을 자동으로 만들어도 된다고
  했다. fast-forward만 하면 먼저 통합된 작업이 있을 때마다 rebase와 재리뷰가 필요했다.
- 결정:
  - `git merge --no-ff`로 작업마다 merge commit을 하나 만든다. 메시지는 `Merge <branch>: <작업 제목>`과
    `Naru-Task: <task ID>` trailer다.
  - 갈라진 branch도 충돌이 없으면 바로 통합한다. 재리뷰를 요구하지 않는다.
  - 충돌하면 `git merge --abort`로 사람의 checkout을 merge 전 상태로 되돌리고 거부한다. 거부 메시지에
    충돌 파일(최대 20개)을 담는다. 작업자는 task worktree에서 대상 branch를 merge해 충돌을 풀고, 다시
    리뷰받은 뒤 통합한다. 되돌리기가 실패하면 사람에게 확인하라고 거부한다.
  - commit 신원: Naru의 git은 사용자 global·system config 없이 실행한다(기존 경계). 그래서 신원은 project
    local config, 사용자 `~/.gitconfig`, XDG git config 순서로 `user.name`·`user.email`만 읽는다. 셋 다
    없으면 `Naru <naru@localhost>`다.
  - Naru의 merge는 저장소 hook을 실행하지 않는다(`core.hooksPath=/dev/null`). hook은 서버의 최소 환경에서
    실행돼 실패하거나 의도하지 않은 코드를 돌릴 수 있다.
- 검증: workspace 테스트(merge commit, 신원, hook 미실행, 충돌 abort 뒤 깨끗한 checkout), fake 인수
  A15(충돌 거부 → worktree에서 해결 → 재리뷰 → 통합).

## AP-D020. 관리형 Claude 세션은 사용자 설정을 함께 불러온다

- 상태: accepted (2026-10-16, 사용자 결정). AP-D013 4를 대체한다.
- 배경: 사용자는 개인 설정이 에이전트에도 적용돼야 한다고 했다. AP-D013 4의 기본값은 검증 격리를 위한
  보수적 선택이었고(V03), 운영상 이유는 없었다. 확인 결과 사용자 global hook은 다른 도구의 hook이고 그
  도구의 환경 변수가 없으면 아무것도 하지 않는다.
- 결정:
  - runner와 TUI 모두 `user,project,local` 설정을 불러온다. 개인 skill, plugin, 권한 허용 규칙, hook이
    에이전트에도 적용된다.
  - Naru가 주입하는 flag 설정이 더 높은 우선순위다. 역할별 model, 권한 모드(runner), `mcp__naru` 허용,
    messaging bridge hook은 그대로다. `disableAllHooks: false`를 함께 넣어 개인 설정이 bridge hook을 끄지
    못하게 한다.
  - MCP 서버는 지금처럼 Naru 서버만 쓴다(`strictMcpConfig`). capability가 묶인 `naru` 서버와 이름이
    겹치지 않게 하기 위해서다.
- 영향: 개인 권한 허용 규칙이 있으면 Inbox 승인 요청이 그만큼 줄어든다. 개인 hook이 무거우면 에이전트
  turn도 느려진다.

## AP-D021. 승인 대기는 기존 "입력 필요" 상태와 알림으로 알린다

- 상태: accepted (2026-10-16, 사용자 결정). AP-D017에서 하지 않았던 승인 대기 알림이다.
- 결정:
  - 관리형 에이전트가 사람의 승인을 기다리기 시작하면 그 에이전트 Pane의 활동 상태를
    `interaction-required`로 바꾼다. 승인이 모두 답해지거나 runtime이 끝나면 `idle`로 돌린다.
  - 기존 경로를 그대로 탄다: Pane과 project의 "입력 필요" 표시, Web Push "입력 필요" 알림(사람이 활동
    중이면 생략), 답한 뒤 기기에서 알림 지우기.
  - 알림을 누르면 workspace 대신 에이전트 화면에서 그 에이전트를 연다. Pane의 launch profile이 관리형
    에이전트일 때만 그렇다.
  - 되돌릴 때는 상태가 아직 `interaction-required`일 때만 바꾼다. runtime의 자체 hook이 보고한 다른
    상태는 덮어쓰지 않는다.
- 하지 않은 것: 알림 문구는 기존 일반 문구("N개의 작업에 입력 또는 승인이 필요합니다")다. 무엇을
  승인하는지는 알림에 넣지 않는다(AP-D003, 기존 push 원칙).

## AP-D022. 에이전트 화면을 관제실, 대화, 흐름으로 다시 만든다

- 상태: accepted (2026-10-16, 사용자 결정). AP-T17 화면을 바꾼다.
- 배경: 사용자가 테스트 앱에서 AP-T17 화면을 써 보고 거부했다.
  - 채팅이 카드 목록이라 실제 에이전트와 대화하는 느낌이 없었다.
  - 오케스트레이션을 어디서 시작하는지 보이지 않았다.
  - 전체 작업 상황을 한눈에 보는 시각화가 부족했다.
- 결정: 사용자가 승인한 Figma 시안 v1("Naru 에이전트 UX 재설계 v1")대로 만든다.
  - 관제실: 맡기기 입력창 하나가 시작점이다. 지표, project별 작업 흐름 그래프, 나를 기다리는 것, 에이전트,
    타임라인을 둔다.
  - 대화: 사람과 오케스트레이터의 요청은 말풍선, 에이전트의 답은 글이다. 도구 호출과 생각은 회색 한 줄로
    접는다. 승인은 대화 안에서 답하고, 이어받으면 구분선 한 줄로 보인다. 화면에 writer, hold 같은 설계
    용어를 쓰지 않는다.
  - 흐름: 한 project의 단계별 작업 그래프와 선택한 작업의 기록, 산출물, 병합 조건.
- 계약: 읽기 API 두 개를 더한다(추가형, ARCHITECTURE §6.6.1).
  - `GET /api/agent/board`: 모든 project를 한 번에 읽는다. 지시 원문은 넣지 않는다.
  - `GET /api/agent/agents/:id/instructions`: 대화의 요청에 누가 했는지 붙이는 데 쓴다. 원문은 이미
    저장된 지시다(AP-D002). 새로 저장하는 것은 없다.
- 하지 않은 것: 화면에 없는 기능은 만들지 않았다.
  - 승인의 "이 세션에서는 항상 허용", 첨부, `@` 멘션, 토큰·비용 지표는 런타임이나 Naru에 그 기능이 없다.
  - hold 자동 반환 시간은 설정값이라 화면에는 "한동안"으로 쓴다.

## AP-D023. 관리형 에이전트는 사용자 자신의 권한 모드로 시작한다

- 상태: accepted (2026-10-16, 사용자 결정). AP-D017을 구현하면서 정했던 역할별 권한 모드를 바꾼다.
- 배경: 테스트 앱에서 오케스트레이터가 셸 명령마다 승인을 물었다. Naru가 관리형 Claude를 사용자의 auto
  모드보다 엄격한 모드(작업자 `acceptEdits`, 그 밖 `default`)로 띄웠기 때문이다. 사용자는 이를 예상하지
  않았다. [HUMAN_IN_THE_LOOP.md](HUMAN_IN_THE_LOOP.md) 사례 1.
- 결정:
  - Naru는 Claude의 권한 모드를 정하지 않는다. 사용자 settings의 `defaultMode`, 없으면 auto(쓸 수 있을
    때)로 시작한다. 사용자의 Claude, Naru의 TUI 실행과 같다. Codex는 원래 사용자 config의 승인 정책을
    그대로 쓴다.
  - Naru의 승인 요청은 그 모드가 묻는 것만 받는다. 런타임이 제안하면 "이 세션에서는 항상 허용"을 고를 수
    있다. Claude는 SDK가 제안한 규칙을 session 범위로만 적용하고, Codex는 `acceptForSession`이다. 사용자
    설정 파일은 바꾸지 않는다.
  - 오케스트레이터의 파일 편집을 막지 않는다. 오케스트레이터의 핵심은 다른 에이전트에게 맡기는 것이라고
    역할 지침에 쓴다. 지시 파일, 계획, 결정 근거 문서는 직접 써도 된다.
  - 이 사례를 사람의 개입 원칙에 넣고, 같은 실수를 하지 않도록 에이전트 공통 지침에도 넣는다.
- 계약: `AgentApprovalDecision`에 `approve-session`, 승인 대기 항목에 `sessionAllow`를 더한다(추가형).
- 영향: 승인 요청이 크게 줄어든다. auto 모드의 판단 모델이 위험하다고 본 동작은 에이전트에게 거부로
  돌아가고, 에이전트가 사람에게 넘길지 판단한다.

## AP-D024. 사용자 권한 모드를 Naru가 읽어 명시적으로 넘긴다

- 상태: accepted (2026-10-16). AP-D023의 구현 방법을 바로잡는다. 결정의 내용(사용자 자신의 모드)은 같다.
- 배경: AP-D023은 권한 모드를 넘기지 않으면 Claude가 사용자 설정이나 auto로 시작한다고 보았다. 실제
  SDK로 확인하니 아니었다(`experiments/naru-agent-spikes/auto-mode-probe`, 저장소 밖).
  - 새 세션에 auto를 넘기면 auto로 시작한다. 명령 3개를 묻지 않았다.
  - 이어 가는(resume) 세션에 모드를 넘기지 않으면 그 대화의 이전 모드(default)를 그대로 쓴다.
  - 이어 가는 세션에 auto를 넘기면 auto가 된다.
  - 테스트 앱의 에이전트는 모두 이어 가는 세션이라 계속 default였고, 승인을 계속 물었다.
- 결정:
  - Naru가 사용자 모드를 읽어 runner와 TUI 양쪽에 명시적으로 넘긴다. 읽는 순서는 project의
    `.claude/settings.local.json`, `.claude/settings.json`, 사용자 `~/.claude/settings.json`의
    `permissions.defaultMode`이고, 없으면 auto다. CLI의 `manual`은 SDK의 `default`와 같다.
  - `bypassPermissions`는 Naru가 적용하지 않는다. `dontAsk`는 Host가 실행하는 runner의 plan이 아직
    받지 않는다. 둘 다 알 수 없는 값과 같이 auto로 둔다.
  - 이미 떠 있는 에이전트는 다시 시작할 때 새 모드를 받는다.

## AP-D025. 에이전트의 질문은 대화에 그대로 보이고, 대화로 답하면 에이전트가 스스로 거둔다

- 상태: accepted (2026-10-16, 사용자 결정). 테스트 앱 피드백이다.
- 배경:
  - 대화 화면이 에이전트의 질문(`request_human_handoff`, `propose_design_change`)을 회색 도구 줄
    "사람에게 물음"으로 접어서, 무엇을 묻는지 보이지 않았다.
  - 사용자가 대시보드 대신 대화에서 답하면 질문은 대시보드에 계속 열려 있었다. 사람이 따로 닫는 버튼
    대신, 에이전트가 스스로 거둬야 한다는 것이 사용자 결정이다.
- 결정:
  - 대화에서 질문은 접지 않는 카드다: 종류, 질문, 선택지, 추천. 열려 있으면 "답하기"로 바로 답한다.
  - 사람이 대화에 쓴 turn에, 그 에이전트가 물은 질문이 아직 열려 있으면 Naru가 표시된 메모
    (`[Naru] Your question to the person is still open …`)를 붙여 보낸다. 그 메시지가 답이면 에이전트가 그
    답대로 하고 `cancel_handoff`로 거둔다. 공통 지침에도 같은 규칙을 넣었다.
  - 사람의 말은 그대로 기록한다(AP-D002). 메모는 에이전트에게만 가고 대화 화면에서는 숨긴다.

## AP-D026. 맡긴 일 중심 화면과 기본 개입 지점

- 상태: accepted (2026-10-16, 사용자 결정). 구현 전이다. 화면은 Figma 시안 v2("시안 v2" 페이지)다.
- 배경: 테스트 앱에서 맡긴 일이 끝까지 진행됐지만, 대시보드에는 작업 1개의 진행과 완료만 보였다. 에이전트의
  진행 보고는 한 번뿐이었고, 사람이 개입할 지점이 여러 화면에 흩어져 있었다.
- 결정:
  - 대시보드의 단위는 사람이 맡긴 일(원래 사용자 지시) 하나다. 모든 일은 맡김, 계획, 작업, 검증, 내 확인,
    병합, 완료 단계를 지난다. 사람이 할 일은 그 단계 안에 버튼으로 둔다.
  - 기본으로 멈춰서 기다리는 단계는 병합 전 확인이다. 계획은 바로 시작한다. 의도 계약 승인은 그대로다.
  - 개발 서버 미리보기는 내부망에 여는 것을 기본으로 한다. 공개 인터넷에는 열지 않는다. 어떤 주소와 경로로
    여는지는 구현 때 구체 계획을 만들어 따로 승인받는다(네트워크 노출 경계).
  - "지금 하는 일" 줄은 런타임의 실시간 도구 사용을 받아 도구 이름과 짧은 대상까지 보여 주고, 저장하지
    않는다.

## AP-D027. 계획 먼저, 완료하면 정리, 작업공간 세로 목록

- 상태: accepted (2026-10-16, 사용자 결정). 구현 전이다. 화면은 Figma 시안 v3("시안 v3" 페이지)다.
- 배경: 사용자는 일을 맡길 때 먼저 계획을 받아 여러 번 주고받으며 고친 뒤 시작하고, 써 본 뒤에도 피드백을
  여러 번 주고받는다. 시안 v2에는 이 주고받기가 빠져 있었다. 또 에이전트가 늘면서 사람은 Pane 하나씩만
  조작하게 됐고, 가로 탭으로는 프로젝트에 떠 있는 프로세스를 한눈에 볼 수 없었다.
- 결정:
  - 일을 맡기는 기본 방식은 "계획 먼저"다. AP-D026의 "계획은 바로 시작한다"를 바꾼다. 오케스트레이터가
    계획서를 올리고, 사람이 부분마다 의견을 달거나 대화로 고치면 버전이 쌓인다. 사람이 "이 계획으로 시작"을
    눌러야 작업자가 붙는다. 맡기는 입력창에서 그 일만 "바로 진행"으로 바꿀 수 있다.
  - 써 본 뒤 주는 피드백은 항목으로 나눠 항목마다 확인한다. 끝난 일도 다시 열어 다음 라운드로 이어 간다.
  - 사람이 일을 완료하면(병합 전 확인 뒤 병합, 또는 병합할 것이 없는 일의 완료) Naru가 그 일의 작업자와
    리뷰어 세션을 정리한다. 대화 기록은 남고 나중에 이어 갈 수 있다. 오케스트레이터는 여러 일을 동시에
    맡으므로 세션을 이어 간다.
  - 작업공간 화면의 가로 탭을 세로 목록으로 바꾼다. 위에서부터 작업공간들, "작업공간 추가", 구분선, 개별
    Pane 순서로 두고 두 부분을 따로 나누어 보이지 않는다. 작업공간은 사람이 만들고 고치고 지우는 보기이고,
    이미 있는 Pane을 자유롭게 배치한다. 같은 Pane을 여러 작업공간에 둘 수 있고, 작업공간에서 빼도 Pane은
    꺼지지 않는다.
  - 기본 작업공간은 왼쪽 Claude, 오른쪽 메인 Codex, 아래 터미널이다.
- 구현 전에 확인할 것:
  - 이미 쓰는 프로젝트의 지금 배치를 첫 작업공간으로 남길지, 기본 배치로 바꿀지(사람이 정한 배치를 바꾸는
    일이므로 묻는다). 저장된 배치를 옮기는 일은 데이터 마이그레이션 승인 경계다.
  - 완료한 일의 작업 브랜치와 워크트리를 어떻게 할지는 정하지 않았다. 정할 때까지 남겨 둔다.

## AP-D028. 메뉴 하나, 대화는 Pane, 맡긴 일 작업공간

- 상태: accepted (2026-10-16, 사용자 결정). 구현 전이다. 화면은 Figma 시안 v3의 V3-C·D·G·M2·M4다.
- 배경: AP-D027로 에이전트가 작업공간의 개별 Pane이 되면서, "에이전트 › 대화" 화면과 작업공간이 같은
  에이전트를 두 번 보여 주게 됐다.
- 결정:
  - 위쪽 메뉴는 "관제실 | 작업공간 | 흐름" 하나다. "작업공간 | 에이전트" 전환과 에이전트 화면의 왼쪽
    레일을 없앤다. 처음 여는 화면은 관제실이다.
  - "대화" 화면을 따로 두지 않는다. 에이전트는 작업공간의 개별 Pane이고, Pane 안에서 대화 화면(사람 말풍선,
    접힌 회색 도구 줄)으로 보인다. 에이전트마다 Pane은 하나다.
  - 일을 시작하면 Naru가 그 일의 에이전트를 모은 작업공간을 자동으로 만든다. 일이 완료되면 함께 정리되고,
    다시 열면 다시 생긴다.
  - 세로 목록 순서는 사람이 만든 작업공간, "작업공간 추가", 맡긴 일 작업공간, 구분선, 개별 Pane이다.
    AP-D027의 순서에 맡긴 일 작업공간을 더한 것이다.
  - 휴대폰에서도 세 메뉴를 쓸 수 있어야 한다.
- 시안에서 제안한 것(사용자 확인 전):
  - 휴대폰에서 세 메뉴를 햄버거에 넣지 않고 위쪽에 늘 보이게 둔다. 360px에도 들어가고, 주 메뉴가 한 번에
    보인다. 햄버거에는 프로젝트 전환과 설정을 둔다. 기다리는 일 수는 관제실 메뉴의 숫자로 보인다.
  - 맡긴 일 작업공간에 "내 작업공간으로 저장"을 두어, 일이 끝난 뒤에도 남기고 싶은 배치를 사람이 만든
    작업공간으로 옮긴다.
  - 작업자 Pane의 입력창에 쓰는 것은 사람의 개입이다(AP-D005 사람 개입 hold, AP-D011 대화 writer).
