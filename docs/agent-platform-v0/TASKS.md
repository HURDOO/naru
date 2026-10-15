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
  - AP-D002, D004, D005, D009~D012를 accepted로 바꿨다. ARCHITECTURE.md §6을 작성했다.
  - 사용자 확인 항목은 AP-D013에 기본값과 함께 모았다.
  - 남은 NOT TESTED 항목은 구현 Task로 넘긴다: Codex↔Claude 실제 왕복은 AP-T13·T14, 실제 SSH는 A09다.

## Phase 2: 공통 기반

### AP-T09. 계약과 저장소

- [-] `naru-agent/v1` contract(additive)와 DB migration: instruction, intent contract, plan, agent task,
  run, agent session, handoff, event, artifact, shared process, session holder. 기존 migration 전
  backup 계약을 따른다.
- 진행(2026-10-15):
  - 완료: contract, v20 migration(`apps/server/src/agent-platform/migration.ts`), store, 정책 Core,
    단위 테스트 11개(`apps/server/test/agent-platform-core.test.ts`). 테스트 범위는 원본 지시 연결,
    역할과 scope, 사람 hold, idempotency, revision과 cycle, merge gate, 재시작 뒤 `unknown`,
    이벤트 순서와 cursor, project 삭제, v19→v20 backup 뒤 migration이다.
  - 남음: terminal Session 바인딩, SharedProcess, holder는 AP-T12와 함께 추가한다. browser HTTP
    API와 MCP 노출은 AP-T11이다.

### AP-T10. Event Store와 reconciler

- [-] outbox, idempotency, orchestrator별 lease와 revision check, 재시작 reconcile(`unknown` 상태의
  Run은 런타임에 조회한다).
- 진행(2026-10-15):
  - 완료: AP-T09의 전역 순서 이벤트, cursor, idempotency, 재시작 시 `unknown` 처리.
    `OrchestratorWakeups`와 테스트 5개. 다룬 범위는 오케스트레이터별 in-flight turn 하나, 자기 이벤트
    무시, 사람 hold 중 누적, 빈도 제한, cursor 기반 재전달, main 오케스트레이터 범위, 전달 실패 재시도다.
  - 남음: 런타임 조회 reconciler(Phase 3 어댑터의 probe가 필요하다), 실제 OrchestratorInvoker 연결.

### AP-T11. Agent identity와 Naru MCP

- [-] Session별 capability, owner-only UDS, stdio MCP bin, L1~L6 도구(AP-D004), 감사 기록.
- 진행(2026-10-15):
  - 완료:
    - capability: 256-bit token을 쓰고 DB에는 digest만 저장한다. revoke할 수 있다.
    - owner-only `AgentSocketServer`. 기존 Codex integration socket과 보안 helper를 공유한다.
    - stdio MCP bin(`agent-mcp-cli`)과 L1 도구 18개. zod 하나로 입력 검증과 MCP schema를 함께 만든다.
    - 테스트: 신원 바인딩, 권한 거부, 위조 인자와 원문 미노출, revoke, MCP stdio 왕복.
    - 실제 Claude Code 2.1.296 왕복(`tests/spikes/agent-platform/claude-mcp-roundtrip.ts`)이 통과했다.
    - browser HTTP API(사람 행위자)는 `agentPlatform` 의존성을 주입할 때만 등록된다. 읽기에는 세션이
      필요하고, 쓰기에는 CSRF와 사람 기기 lease가 필요하다. 테스트 3개.
  - 남음:
    - L2~L6 도구(DS, managed agent, 사람 채널, Workspace, merge 실행). AP-T12와 Phase 3에서 한다.
    - Naru 시작 경로에 연결하기. 기본은 꺼 두고 opt-in으로 켠다.
    - Codex에서 MCP를 주입하는 방식(V08 Codex)

### AP-T12. 쓰기 권리와 Session 확장

- [ ] 사람 기기 lease 범위 조정, Session holder와 hold(AP-D005), 에이전트 Session 생성(AP-D006),
      SharedProcess, secure input(AP-D003). 회귀 검증: reconnect, 단일 controller handoff, 권한 거부.

## Phase 3: 런타임 어댑터

### AP-T13. Codex 어댑터

- [-] app-server 기반 Chat channel, GUI↔TUI 전환(V01, V02 결과 방식), native child 추적.
- 2026-10-15: 사용자가 실행하는 Sol/Astra worker에게 배정했다. branch `feature/ap-t13-codex-adapter`, 과제
  `assignments/codex-adapter/ASSIGNMENT.md`.

### AP-T14. Claude 어댑터

- [ ] SDK 또는 CLI 기반 Chat channel(V03 결과 방식), GUI↔TUI 전환, native child와 메시징 정책.

### AP-T15. OpenCode 어댑터

- [ ] 구현 여부와 범위는 V12 결과로 정한다.

## Phase 4: 오케스트레이션과 UI

### AP-T16. 오케스트레이터 호출과 Skills

- [ ] Main과 Project orchestrator의 이벤트 기반 turn 트리거, 비차단 Handoff, review와 intent 검사
      경로, `skills/naru-orchestration`.

### AP-T17. 웹 화면

- [ ] Home, Project 그래프, Agent Panel(Chat, TUI, Activity), Inbox, Sessions와 Processes. 모든 조작은
      Core에 연결한다. 1440px, 768px, 360px와 키보드·focus를 확인한다.

## Phase 5: 통합과 실사용 준비

### AP-T18. 인수 테스트 A01~A16

- [ ] fake runtime 기반 자동 E2E, 실제 모델 인수, 사용자 Manual Test 절차.

### AP-T19. 파일럿과 운영 문서

- [ ] 사용자가 지정한 project 하나를 실제로 투입하고, OPERATIONS, LIMITATIONS, 운영 한도를 결정한다
      (AP-D007). 운영 배포는 별도 승인을 받는다.
