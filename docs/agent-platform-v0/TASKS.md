# Agent Platform v0 작업 원장

## 상태

- 목표 명세: [SOURCE_SPEC.md](SOURCE_SPEC.md). 결정: [DECISIONS.md](DECISIONS.md).
- integration branch는 `upgrade/orchestration`이다. 런타임 검증은 `spike/*` branch에서 하고 commit으로
  인계한다(`docs/AGENT_COORDINATION.md`).
- 현재 단계: Phase 0 실사와 Phase 1 검증.
- 운영 배포, remote push, 운영 instance 변경은 각각 별도 승인이 필요하다.

## 표기

- `[ ]` 대기
- `[-]` 진행 중
- `[>]` 명시적 다음 작업
- `[~]` 보류
- `[x]` 완료·검증

## Phase 0·1: 실사와 기술 검증

### AP-T01. 착수 문서

- [x] 원문 명세를 보존하고, K1~~K5를 결정 기록(AP-D001~~D008)으로 남기고, 이 원장을 만들고, `AGENTS.md`의
      기준 문서에 등록한다.

### AP-T02. 저장소 실사 (Phase 0)

- [x] [AUDIT.md](AUDIT.md)에 기능별 코드 경로를 `implemented / partial / absent / unclear`로 분류하고,
      설계 변경 후보와 위험을 기록한다. 대규모 refactor는 하지 않는다.

### AP-T03. 코드 수준 검증 (V09, V10, V13, V14)

- [x] V09: DurableSession attach, control, stream, lease와 agent caller E2E(격리 Host). Host 계층은 PASS다.
      Naru 계층 E2E는 AP-T12로 넘긴다.
- [x] V10: 사람 입력과 비밀 입력이 observer, 기록, 로그, LLM 컨텍스트에 남는지 경로를 감사하고,
      secure input을 넣을 위치를 정한다(AP-D003). 실제 PTY의 echo-off 경로는 PASS다.
- [x] V13: Gateway 사용자 인증과 agent 인증의 분리, 내부 서비스 노출 여부. 분석까지 했고 구현은 AP-T11이다.
- [x] V14: 기존 Hook, 세션, 워크플로 데이터의 migration 호환성과 이벤트 중복 처리. 분석까지 했고
      migration 실증은 AP-T09다.
- 완료 조건: [VALIDATION.md](VALIDATION.md)에 항목별 상태, 재현 명령, 증거를 기록한다.

### AP-T04. Codex 런타임 검증 (V01, V02, V04, V11, V08 Codex 측)

- [x] 사용자가 `spike/codex-runtime` worktree에서 Sol 또는 Astra로 실행했다. 과제:
      `assignments/codex-runtime/ASSIGNMENT.md`. 2026-10-15에 인수해 병합했다. worker의 decision request(native
      억제)는 AP-D009로 수락했다.
- 완료 조건: `validation/codex-runtime.md`와 `HANDOFF.yaml`을 commit하고 integration이 인수한다.

### AP-T05. Claude 런타임 검증 (V03, V05, V07)

- [x] `spike/claude-runtime`. 완료 조건: `validation/claude-runtime.md`와 `HANDOFF.yaml`을 commit하고
      integration이 인수한다. 2026-10-15에 인수해 `dd723e7`로 병합했다.

### AP-T06. Claude 메시징 검증 (V06, V08 Claude 측)

- [x] `spike/claude-messaging`. 완료 조건: `validation/claude-messaging.md`와 `HANDOFF.yaml`을 commit하고
      integration이 인수한다. 2026-10-15에 인수해 `979ad21`로 병합했다. Codex↔Claude 왕복은 Codex 결과가
      나온 뒤 integration에서 진행한다.

### AP-T07. OpenCode/OmO 검증 (V12)

- [x] `spike/opencode`. 완료 조건: `validation/opencode.md`와 `HANDOFF.yaml`을 commit하고 integration이
      인수한다. 2026-10-15에 인수해 병합했다.

### AP-T08. Gate 1

- [x] V01~V14 결과를 VALIDATION.md에 통합하고, Capability Matrix를 확정한다. `direction-approved`
      결정을 `accepted`로 확정하고 ARCHITECTURE.md를 작성한다. 사용자 결정이 필요한 항목은 한 번에
      모아서 묻는다.
- 선행: AP-T02~T07
- 완료(2026-10-15):
  - VALIDATION.md를 통합했다.
  - Capability Matrix(`apps/server/src/agent-runtime/capabilities.ts`)를 확정했다.
  - AP-D002, D004, D005, D009~D011을 accepted로 바꿨다. AP-D012(SDK 공급)는 사용자 결정 B(사용자가 따로 설치)로 확정했다. ARCHITECTURE.md §6을 작성했다.
  - 사용자 확인 항목은 AP-D013에 기본값과 함께 모았다.
  - 남은 NOT TESTED 항목은 구현 Task로 넘긴다: Codex↔Claude 실제 왕복은 AP-T13·T14, 실제 SSH는 A09다.

## Phase 2: 공통 기반

### AP-T09. 계약과 저장소

- [x] `naru-agent/v1` contract(additive)와 DB migration: instruction, intent contract, plan, agent task,
      run, agent session, handoff, event, artifact, shared process, session holder. 기존 migration 전
      backup 계약을 따른다.
- 진행(2026-10-15):
  - 완료: contract, v20 migration(`apps/server/src/agent-platform/migration.ts`), store, 정책 Core,
    단위 테스트 11개(`apps/server/test/agent-platform-core.test.ts`). 테스트 범위는 원본 지시 연결,
    역할과 scope, 사람 hold, idempotency, revision과 cycle, merge gate, 재시작 뒤 `unknown`,
    이벤트 순서와 cursor, project 삭제, v19→v20 backup 뒤 migration이다.
  - 2026-10-15 완료: terminal Session 바인딩(`agent_sessions.pane_id`), SharedProcess와 hold는 AP-T12·T14,
    worktree 연결(`agent_worktrees`)은 AP-T11에서 v20에 더했다. v20은 아직 어느 운영 instance에도 적용되지
    않았다.

### AP-T10. Event Store와 reconciler

- [x] outbox, idempotency, orchestrator별 lease와 revision check, 재시작 reconcile(`unknown` 상태의
      Run은 런타임에 조회한다).
- 진행(2026-10-15):
  - 완료: AP-T09의 전역 순서 이벤트, cursor, idempotency, 재시작 시 `unknown` 처리.
    `OrchestratorWakeups`와 테스트 5개. 다룬 범위는 오케스트레이터별 in-flight turn 하나, 자기 이벤트
    무시, 사람 hold 중 누적, 빈도 제한, cursor 기반 재전달, main 오케스트레이터 범위, 전달 실패 재시도다.
  - 2026-10-15 추가:
    - 실제 OrchestratorInvoker를 연결했다. supervisor가 orchestrator 대화에 wakeup turn을 넣는다(AP-T16).
    - 재시작 reconciler: Naru가 다시 시작하면 runtime이 스스로 상태를 보고한다. 살아 있는 runner와
      Codex relay는 재접속하며 hello로 진행 중·대기·승인 대기를 알린다. 이것이 probe다.
      - 유예 시간 안에 돌아오지 않은 에이전트는 `unknown`이 된다. 그 에이전트의 진행 중 Run도
        `unknown`이 된다. 다른 에이전트의 Run은 그대로 둔다(A13).
      - Claude TUI 형태는 Pane이 살아 있으면 유지한다.
      - 실행 중에 연결이 끊긴 경우도 같은 규칙을 따른다.
    - 바인딩 없는 Session: 에이전트는 Naru를 거쳐서만 Session을 만든다(AP-D006). 공유 프로세스는
      재시작 때 Host Session과 대조해 없으면 `unknown`으로 둔다.

### AP-T11. Agent identity와 Naru MCP

- [x] Session별 capability, owner-only UDS, stdio MCP bin, L1~L6 도구(AP-D004), 감사 기록.
- 진행(2026-10-15):
  - 완료:
    - capability: 256-bit token을 쓰고 DB에는 digest만 저장한다. revoke할 수 있다.
    - owner-only `AgentSocketServer`. 기존 Codex integration socket과 보안 helper를 공유한다.
    - stdio MCP bin(`agent-mcp-cli`)과 L1 도구 18개. zod 하나로 입력 검증과 MCP schema를 함께 만든다.
    - 테스트: 신원 바인딩, 권한 거부, 위조 인자와 원문 미노출, revoke, MCP stdio 왕복.
    - 실제 Claude Code 2.1.296 왕복(`tests/spikes/agent-platform/claude-mcp-roundtrip.ts`)이 통과했다.
    - browser HTTP API(사람 행위자)는 `agentPlatform` 의존성을 주입할 때만 등록된다. 읽기에는 세션이
      필요하고, 쓰기에는 CSRF와 사람 기기 lease가 필요하다. 테스트 3개.
  - 2026-10-15 L2~L6 완료(세부 범위 AP-D016, proposed):
    - L2: 공유 프로세스 도구(AP-T12)
    - L3: `spawn_agent`, `list_agents`, `get_task_detail`, `interrupt_agent`
    - L4: Handoff 도구, Handoff 요청 시 Web Push. 알림을 열면 Inbox 항목이 열린다.
    - L5: `create_worktree`, `open_pane`
    - L6: `get_merge_gate`, `merge_task`(fast-forward만, push 없음)
    - 테스트:
      - 실제 git 임시 저장소로 worktree 생성, 승인 root 밖 거부, 권한 거부, worktree scope, merge gate,
        더러운 checkout 거부, fast-forward merge, 갈라진 branch 거부, view Pane
      - supervisor interrupt(실제 runner process)
      - Handoff push(service, app 연결, service worker)
    - 이전 "남음"의 native bridge 시작 경로와 Codex MCP 주입은 AP-T13·T14 때 연결했다.
  - 2026-10-15 결함 수정(AP-T18 준비 중 발견):
    - wakeup turn은 orchestrator에게만 갔다. 그래서 위임받은 작업자가 깨어나지 않았다.
      - 이제 모든 관리형 에이전트를 wakeup에 등록한다.
      - 작업 역할은 자기에게 온 일(자기·자기 Task 위임, 배정, 리뷰, 답이 온 Handoff, hold 반환)에만
        깨어난다(`eventConcernsAgent`).
    - 작업자가 읽을 수 있는 지시는 사람 지시뿐이었다. orchestrator의 위임 원문을 읽을 수 없었다.
      - 이제 `get_delegated_work`가 자기·자기 Task에 온 지시 원문과, 그 지시가 따르는 원본 사용자
        지시를 돌려준다(A03).
  - 2026-10-15 추가: AP-D015 native 메시징 bridge를 구현했다. hook 전용 tool, hook bin, settings builder,
    TUI 직접 입력 기록이 들어갔다. MCP bin은 광고한 tool만 전달한다. 테스트 5개와 V06c 실제 세션 검증이
    통과했다.
    - 완료: Naru 시작 경로에 연결했다. Agent Platform은 `NARU_AGENT_PLATFORM=1`일 때만 켜진다.
    - 완료: Codex MCP 주입은 AP-T13에서 thread별 `mcp_servers.naru` 설정으로 했다.

### AP-T12. 쓰기 권리와 Session 확장

- [x] 사람 기기 lease 범위 조정, Session holder와 hold(AP-D005), 에이전트 Session 생성(AP-D006),
      SharedProcess, secure input(AP-D003). 회귀 검증: reconnect, 단일 controller handoff, 권한 거부.
- 진행(2026-10-15):
  - 완료:
    - SharedProcess
      - v20 `agent_shared_processes`와 에이전트 입력 원문 기록 `agent_shared_process_inputs`
      - Core가 먼저 기록한 뒤 실행기가 접힌 terminal Pane을 만들고 명령을 입력한다(AP-D006).
      - `keep: run`인 process는 Run이 끝나면 정지한다.
      - 재시작 뒤에는 살아 있는 Host session에 다시 붙는다.
    - MCP 도구: `start_process`, `send_process_input`(재전송해도 한 번만 입력), `read_process_screen`
      (headless terminal로 텍스트화, 저장하지 않음), `stop_process`, `list_processes`, `spawn_agent`
      (부모 기록, 자기보다 낮은 역할만).
    - holder와 hold
      - 만든 에이전트만 입력할 수 있다. 사람이 hold하면 입력을 queue에 넣지 않고 거부한다.
      - 반환은 명시적 해제, 기기 연결 끊김 유예, 입력 없는 idle 세 경우에 일어난다(`HoldMonitor`,
        `NARU_AGENT_HOLD_IDLE_MS`, `NARU_AGENT_HOLD_DISCONNECT_MS`). 에이전트 대화와 process 모두 같다.
    - 사람 기기 lease의 범위: 에이전트가 운영하는 Pane에는 lease가 있는 기기도 observer로 붙는다.
      hold하면 에이전트가 먼저 제어권을 놓고 기기가 받는다. 반환 시에는 반대 순서다
      (`PaneControlPolicy`). 에이전트 동작은 lease를 거치지 않는다.
    - secure input의 서버 경계: `terminal.input.secure`
      - bytes는 PTY에만 간다. Naru는 사람이 입력했다는 사실만 hold idle 판정에 쓴다.
    - 테스트
      - Core: 기록 순서, 권한 거부, hold 거부, 재전송, spawn, 자동 반환
      - MCP: runtime 없음과 있음
      - WebSocket: observer → controller → observer, secure input
      - 격리 Host: 실제 shell 실행, 화면 읽기, 입력, hold, 재시작 뒤 재접속, 정지
  - 2026-10-15 완료:
    - secure input 입력 UI: shell terminal Pane 도구 모음의 `비밀 입력`. password 입력란에 넣은 값을
      Enter와 함께 `terminal.input`(`secure: true`)으로 한 번만 보낸다. 값은 React state, draft,
      browser 저장소에 두지 않는다. Claude·Codex Pane에는 두지 않는다. 그곳에서는 입력이 모델 prompt가
      되기 때문이다.
    - Host의 입력 중복 제거 fingerprint를 process별 key의 HMAC으로 바꿨다(V10 감사 후속).
    - 검증: [validation/web-ui.md](validation/web-ui.md)의 secure input 항목. 실제 shell `read -s`
      프롬프트에 전달됐고, 격리 sandbox의 Naru DB·Host 상태·로그 어디에도 값이 없었다.
  - 바인딩 없는 Session은 AP-T10 reconciler가 다룬다.

## Phase 3: 런타임 어댑터

### AP-T13. Codex 어댑터

- [x] app-server 기반 Chat channel, GUI↔TUI 전환(V01, V02 결과 방식), native child 추적.
- 2026-10-15: 처음에는 사용자가 실행하는 Sol/Astra worker에게 배정했다(branch
  `feature/ap-t13-codex-adapter`, 과제 `assignments/codex-adapter/ASSIGNMENT.md`). 사용자 요청으로
  integration이 같은 worktree에서 직접 구현했다.
  - 관리형 Codex 에이전트
    - Codex Pane relay가 runner 역할을 맡는다: thread 소유, thread별 MCP 주입, TUI writer gate, 이벤트
      변환, 이력, 재접속.
    - supervisor는 live 전략을 쓴다.
  - 검증: [validation/codex-adapter.md](validation/codex-adapter.md)
    - 가짜 codex 기반 자동 테스트(기본 suite)가 PASS다.
    - 실제 CLI와 `gpt-6-astra` xhigh 인수가 PASS다.
  - probe는 AP-T10에서 한다.

### AP-T14. Claude 어댑터

- [x] SDK 또는 CLI 기반 Chat channel(V03 결과 방식), GUI↔TUI 전환, native child와 메시징 정책.
- 진행(2026-10-15):
  - 완료:
    - `ClaudeSdkPort`: 사용자 설치 SDK를 동적으로 불러오는 loader와 신뢰 검사(AP-D012)
    - `ClaudeRunner`: 이벤트 매핑, 승인 callback, interrupt, 공식 이력 pagination, 원문 미보관. fake port 단위
      테스트 4개.
    - 실제 SDK 0.3.296과 CLI 2.1.296 인수(`tests/spikes/agent-platform/claude-runner-sdk.ts`)가 모두
      통과했다: Naru MCP 호출, tool·파일 승인, 생성 중 interrupt, 이력, 같은 대화 resume.
    - runner 프로세스(`claude-agent-runner`)와 runtime 채널을 만들었다.
      - 실행 token은 agent capability와 분리했고, DB에는 digest만 둔다.
      - runner는 재접속하고, 미확인 이벤트를 bounded로 재전송한다.
      - PTY에는 원문 없는 관찰 console만 출력한다.
    - `ManagedAgentSupervisor`
      - writer gate를 강제하고, Core 상태를 반영하고, 승인과 이력을 다루고, wakeup invoker 역할을 한다.
      - 사람 hold는 Core에서 복원한다.
    - 통합 테스트(실제 runner 프로세스와 fake SDK): Naru 재시작 중 끝난 turn의 결과 전달, 재시작 후 사람
      writer 유지.
    - Host PTY 실행(ARCHITECTURE §6.4)
      - 에이전트 Pane(`claude-agent`)은 작업공간에 접힌 채 들어가고 v20 `pane_id`와 `launch_mode`로
        묶인다.
      - launch 응답은 runner channel env만 더할 수 있다.
    - TUI 전환: stop 후 resume, `SessionStart` 확인, rollback, generation fencing.
    - 시작 경로(`NARU_CLAUDE_AGENT_SDK_PATH`)와 browser API를 연결했다: 생성, 실행, 정지, 상태, 이력,
      Chat turn, interrupt, 승인, 개입과 해제.
    - 검증: [validation/agent-runtime-host.md](validation/agent-runtime-host.md)
      - 격리 Host 통합 테스트와 실제 서버 진입점 boot spike가 모두 PASS다.
      - 이 과정에서 네 결함을 고쳤다: 새 runner 순번, 대기 runner 종료, resume 확인, Node realpath와
        socket stat.
    - 실제 인수 PASS: 실제 SDK runner와 실제 Claude TUI 사이의 Host PTY 전환, 왕복 뒤 대화 기억 유지
    - native child: runner 형태에서 실행 중인 보조 에이전트를 runtime 상태에 관찰 전용(L1/L2, AP-D014)으로
      노출한다. TUI 형태에서는 사람이 TUI에서 직접 다루므로 Naru 관찰은 Pane 화면에 맡긴다.
    - 메시징 정책: bridge hook(AP-D015)을 runner와 TUI 두 형태 모두에 넣는다.
  - 남음(다른 Task에서 처리): main orchestrator 실행 위치(AP-T16), 재시작 probe(AP-T10), 처음 trust하는
    디렉터리의 TUI 전환 확인(사람 테스트)

### AP-T15. OpenCode 어댑터

- [x] 구현 여부와 범위는 V12 결과로 정한다.
- 2026-10-15: v0에서는 미루는 결정안을 AP-D018(proposed)로 남겼다.
- 2026-10-16: 사용자가 AP-D018을 확인했다. 결정은 "v0에서는 만들지 않는다"이다. 이 Task는 결정으로
  끝났고, OpenCode 관리형 어댑터는 구현하지 않았다.

## Phase 4: 오케스트레이션과 UI

### AP-T16. 오케스트레이터 호출과 Skills

- [x] Main과 Project orchestrator의 이벤트 기반 turn 트리거, 비차단 Handoff, review와 intent 검사
      경로, `skills/naru-orchestration`.
- 진행(2026-10-15):
  - wakeup
    - orchestrator 역할의 관리형 에이전트는 대화가 준비되면 wakeup 대상에 등록된다. 이벤트 참조만 담은
      turn을 받는다.
    - 실제 runner process로 확인했다: 사용자의 project 지시, hold 중 누적, 해제 시 한 묶음 전달.
    - 결함 수정: runtime 상태 보고(`agent_session.updated`)가 자기 turn마다 자신을 다시 깨우는
      반복이 있었다. 이제 다른 에이전트의 failed·unknown·stopped만 깨운다.
  - `skills/naru-orchestration`: 공통 규칙과 역할별 규칙
    - 다루는 규칙: 사용자 지시 우선, AP-D014 보조 에이전트, 설계 이탈, handoff 품질, 공유 프로세스와
      비밀(AP-D003), hold
    - 관리형 Claude는 runner의 system prompt와 TUI의 `--append-system-prompt`로 같은 지침을 받는다.
    - `SKILL.md`는 서버 지침과 같은지, 본문의 도구가 실제로 있는지 skill 검증기가 확인한다.
  - main orchestrator: 전역 세션이다. Pane은 사람이 고른 host project의 작업공간에 둔다.
  - 비차단 handoff, review, merge gate 경로는 AP-T09·T11의 Core와 도구를 쓴다.
  - 실제 모델로 하는 오케스트레이터 행동 인수(A02, A03 등)는 AP-T18에서 한다.

### AP-T17. 웹 화면

- [x] Home, Project 그래프, Agent Panel(Chat, TUI, Activity), Inbox, Sessions와 Processes. 모든 조작은
      Core에 연결한다. 1440px, 768px, 360px와 키보드·focus를 확인한다.
- 완료(2026-10-15):
  - 화면: 기존 작업공간 옆의 `에이전트` 탭(`AgentView`, `AgentOverview`).
    - 전체 현황(Home): 프로젝트별 작업 수, 결정 대기, 에이전트와 사람 hold 수, Main Orchestrator
      시작·대화, 전 프로젝트 결정 대기.
    - 프로젝트 개요: Project Orchestrator 시작·대화, 프로젝트 지시 원문 기록과 최근 지시, 의도 계약
      (제안 승인과 현재 계약), 활성 계획, 의존 단계별 작업 그래프. 작업 노드에서 실행, 리뷰, 산출물,
      병합 조건, 기다리는 결정을 연다.
    - Agent Panel: 상태와 writer, 개입(Chat·TUI)과 반환, 지시만 보내기, 승인 대기, 대화(런타임 이력을
      다시 읽음)와 활동(맡은 작업, 상위·하위 에이전트, native 보조 에이전트 관찰, 이벤트) 탭. TUI는
      작업공간의 실제 Pane을 연다.
    - Inbox, 공유 프로세스(개입, 반환, 정지, 터미널 보기).
  - 서버 추가: `GET /api/agent/tasks/:id`(작업과 Run, 리뷰, 산출물, 병합 조건),
    `GET /api/agent/events?latest=1`(최신 page), project 응답의 `pendingIntentContract`. 모두
    추가형이라 기존 consumer는 그대로다.
  - 검증: [validation/web-ui.md](validation/web-ui.md). 격리 sandbox(가짜 runtime)에서 1440px, 768px,
    360px, 키보드·focus, 동적 resize를 확인했다.
  - 남음(AP-T18·AP-T19): Home의 리소스 사용량과 최근 성과 요약은 아직 수집하지 않는다(화면에 그렇게
    표시한다). 실제 Codex 이력이 화면에 그려지는지는 실제 모델 인수에서 확인한다.

## Phase 5: 통합과 실사용 준비

### AP-T18. 인수 테스트 A01~A16

- [x] fake runtime 기반 자동 E2E, 실제 모델 인수, 사용자 Manual Test 절차.
- 결과: [ACCEPTANCE.md](ACCEPTANCE.md)
  - 14개 PASS, 2개 PARTIAL(A01 운영 instance 확인, A09 실제 SSH·ansible)
  - 사용자 절차: [MANUAL_TESTS.md](MANUAL_TESTS.md)
  - 실제 모델(Claude, 사용자 로그인): A02, A04, A08 PASS. A02·A08 run에서는 도구 승인 요청이 한 건도
    없었다. Naru 도구는 묻지 않는다(AP-D017).
- 진행(2026-10-15):
  - fake runtime 인수: `tests/spikes/agent-platform/acceptance-fake.ts`
    - 빌드한 Naru 서버(운영 진입점), 격리 Host, 실제 git 저장소로 실행한다.
    - 에이전트는 puppet이다. Naru가 전달하는 turn마다 시나리오가 tool 호출을 정한다. 호출은 에이전트
      자신의 capability로 한다.
    - A02, A03, A05, A08, A10, A11, A13, A14, A15와 hold 반환이 PASS다.
  - 인수 준비 중 찾아 고친 결함:
    - 작업 역할 wakeup과 위임 원문 읽기(별도 commit)
    - main orchestrator가 project를 찾을 수 없었다 → `list_projects`
    - project orchestrator가 main의 project 위임을 읽을 수 없었다 → `get_delegated_work`가 자기 project에
      온 지시도 돌려준다.
    - Host 한도 같은 Naru 거절이 에이전트에게 `INTERNAL`로 갔다 → 의미 있는 code로 전달한다.
    - 예상하지 못한 tool 실패가 어디에도 기록되지 않았다 → `agent.tool.failed`(tool 이름과 오류 종류만)
    - 실행하지 못한 에이전트가 `starting`·`unknown`에 머물렀다 → `failed`로 바꿔 orchestrator를 깨운다.
    - orchestrator가 writer일 때 도구 승인에 답할 주체가 없어 자율 진행이 멈췄다 → AP-D017(proposed).
      - Naru MCP 도구는 묻지 않는다. 작업 역할은 편집을 묻지 않는다.
      - 명령 승인은 요약과 함께 Inbox와 Agent Panel에 보인다. 사람이 대화를 넘겨받지 않고 답한다.
      - 화면 확인: UI sandbox, 1440px·360px. 요청 요약 "Bash: pnpm test"가 보였다. Inbox에서 답한 뒤 승인
        대기 0건이었고 writer는 orchestrator로 돌아갔다.
  - `pnpm test:e2e`: 29건 중 27건이 PASS다. 실패 2건(`mobile-output-copy:13`, `terminal-stability:56`)은
    문서에 기록된 기존 전체 실행 flaky다. 둘 다 재실행에서 통과했다. 기준 commit에서도 같은 spec을 돌려
    비교했다.

### AP-T19. 파일럿과 운영 문서

- [-] 사용자가 지정한 project 하나를 실제로 투입하고, OPERATIONS, LIMITATIONS, 운영 한도를 결정한다
  (AP-D007). 운영 배포는 별도 승인을 받는다.
- 2026-10-15: [OPERATIONS.md](OPERATIONS.md) 초안과 [LIMITATIONS.md](LIMITATIONS.md)를 썼다.
  - 남은 사용자 결정: pilot project, 운영 한도(동시 에이전트, 예산, wakeup 빈도)
  - 남은 승인: 운영 배포
- 2026-10-16: 사용자가 AP-D013, AP-D016, AP-D017, AP-D018을 확인했다. 바꾼 것은 새 결정으로 구현했다.
  - AP-D019: merge commit으로 통합, 충돌은 되돌리고 거부
  - AP-D020: 관리형 Claude가 사용자 settings를 함께 불러옴
  - AP-D021: 승인 대기를 기존 "입력 필요" 상태와 알림으로 알림
  - 사용자 요청: 운영에 바로 넣기 전에 별도 테스트 앱(기존 Gateway 아래 별도 route)으로 며칠 쓴 뒤
    main에 합친다. 배포 계획과 승인은 별도다.
  - 테스트 앱 준비(배포 전):
    - distribution이 Agent Platform을 켤 수 있게 했다(WV0-D016).
    - 이 branch로 artifact를 빌드했다. 독립 instance intent(같은 Gateway에 별도 app으로 묶음, 자체 Host와
      DB)와 운영 Gateway reconfigure intent를 만들고 read-only plan을 돌렸다.
    - 운영 reconfigure plan은 Gateway와 Naru만 재시작한다. Host는 재시작하지 않는다.
    - 설치 plan은 Claude Agent SDK가 아직 설치되지 않아 blocked다(사용자 설치, AP-D012).
    - 2026-10-16 사용자 지시로 배포했다.
      - Claude Agent SDK 0.3.300을 사용자 전역 npm에 설치했다(optional binary 없이).
      - 테스트 instance(build `5c0def2`)를 설치했다. doctor는 25/25 healthy이고, Agent Platform이 켜졌으며
        v20 table이 생겼다.
      - 운영 Gateway에 `/naru-next` route를 더했다(reconfigure). Gateway와 Naru만 재시작했고 Host는 그대로
        였다. 운영 doctor는 29/29 healthy다. 인증 없는 요청은 다른 앱처럼 Gateway가 401로 막는다.
    - 남은 것: 사용자가 며칠 쓰며 확인(MANUAL_TESTS), 고칠 것 반영(테스트 instance는 Naru만 upgrade), 그 뒤
      main merge와 운영 반영 승인
