# Agent Platform v0 결정 기록

목표 명세 원문은 [SOURCE_SPEC.md](SOURCE_SPEC.md)다. 아래 결정은 원문과 기존 Naru·DurableSession·Workstation
계약 사이의 충돌을 해소한다. 완료된 기존 결정은 소급 수정하지 않는다. 기존 계약을 대체하는 부분은
해당 구현 Task에서 versioning, consumer 호환성, migration과 함께 적용한다.

상태 값은 세 가지다.

- `direction-approved`: 사용자가 방향을 승인했다. 세부 계약은 Gate 1(AP-T11)의 검증 증거로 확정한다.
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

- 상태: direction-approved (2026-10-15)
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

- 상태: direction-approved (2026-10-15)
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

- 상태: direction-approved (2026-10-15)
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
