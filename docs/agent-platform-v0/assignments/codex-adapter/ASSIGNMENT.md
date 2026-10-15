# 과제: AP-T13 Codex 런타임 어댑터 (Phase 3)

```yaml
protocol: naru-coordination/v0
type: task.assigned
taskId: ap-t13-codex-adapter
sender: integration
recipient: codex-adapter-worker
baseSha: fa3e711
branch: feature/ap-t13-codex-adapter
```

## 0. 역할과 범위

- 당신은 Agent Platform Phase 3의 **Codex 어댑터 구현 worker**다. integration(root)은 `upgrade/orchestration`
  브랜치의 Claude Code 세션이다. 메시지 규약은 `docs/AGENT_COORDINATION.md`를 따른다.
- 이번에는 검증이 아니라 **production 품질의 구현과 테스트**를 한다. 직전 검증(V01, V02, V04, V08, V11)의
  결론을 실제 코드로 옮긴다. 검증의 spike proxy와 stub은 참고만 하고, 그대로 가져오지 않는다.
- 이 worktree와 branch만 수정한다. commit만 하고 push하지 않는다.

### 먼저 읽을 것

1. `AGENTS.md`
2. `docs/agent-platform-v0/` 전체. 우선순위는 다음과 같다.
   - `DECISIONS.md`의 AP-D002, D004, D005, D009, D010, D011
   - `ARCHITECTURE.md`의 §1~§6
   - `VALIDATION.md`의 Codex 요약
   - `validation/codex-runtime.md`. 특히 proxy의 허용과 거부 규칙, 승인 broadcast, interrupt 경계,
     MCP 주입 방법을 본다.
3. 기존 코드
   - `apps/server/src/codex-interaction-{relay,guardian,state}.ts`
   - `apps/server/src/codex-integration-launcher.ts`
   - `apps/server/src/integrations/codex/*`
   - `docs/DECISIONS.md`의 D009, D012, D025
4. 이미 만들어진 공통 기반(integration 소유)
   - `apps/server/src/agent-runtime/adapter.ts`: 구현할 인터페이스
   - `apps/server/src/agent-runtime/writer-gate.ts`: 대화 writer reducer. Codex는 `live` 전략이다.
   - `apps/server/src/agent-runtime/capabilities.ts`: Codex 항목
   - `apps/server/src/agent-platform/core.ts`: `recordTuiPrompt`, `registerAgentSession`,
     `issueAgentCapability`, `setHumanHold` 등
   - `apps/server/src/agent-platform/agent-socket.ts`와 `apps/server/src/agent-mcp-cli.ts`: Naru MCP
     bin. Codex thread에 주입할 대상이다.

## 1. 구현 목표

Naru가 관리하는 Codex agent 세션을 다음과 같이 동작하게 한다.

1. **실행**: Host PTY 안의 기존 launcher·guardian·relay 구조 위에서 app-server를 소유한다.
   - TUI가 있는 managed 세션: 실제 `codex --remote` TUI가 PTY의 foreground다.
   - headless managed 세션: PTY에 V11의 redacted lifecycle console을 띄운다.
2. **GUI channel**
   - Naru server가 relay를 통해 같은 app-server에 JSON-RPC client로 붙는다.
   - relay가 Naru보다 오래 살 수 있으므로 **Naru restart 뒤 재연결**되어야 한다. 기존 snapshot 재전송
     방식을 참고한다.
   - 어느 쪽이 연결을 맺을지, 어떤 private UDS를 쓸지는 설계해서 기록한다.
3. **writer gate**(INV-05, `live` 전략)
   - relay가 현재 writer channel만 conversation-write와 승인 응답을 할 수 있게 강제한다.
   - writer와 generation은 Naru의 `writer-gate.ts` 상태가 결정한다.
   - 허용 목록은 기본 deny다. read와 ID만 지정한 resume만 허용한다.
   - 다음은 거부한다: 미분류 method, 설정 변경 resume, 비writer 승인 응답, 이미 소비한 승인 ID.
   - writer 이전은 turn 경계나 명시적 interrupt 뒤에만 한다.
   - interrupt는 lifecycle 이벤트로 active turn을 확인한 뒤 보낸다. V01에서 `-32600` 경계가 관찰됐다.
4. **MCP 신원**
   - `thread/start`(와 resume)의 config로 Naru MCP bin을 주입한다.
   - capability는 그 MCP server의 env에만 넣는다. Codex process env나 TUI env에는 넣지 않는다.
   - resume 때 다시 주입하고, capability 만료와 revoke를 처리한다.
5. **이벤트 → Core와 어댑터 이벤트**
   - `turn/started`와 `turn/completed`(outcome 포함)
   - 승인 요청과 해소(`approval-requested`, `approval-resolved`)
   - native child 시작과 종료(`subAgentActivity`의 L1, L2)
   - 주 thread에서 TUI가 직접 보낸 `turn/start`의 텍스트를 `user-prompt` 이벤트로 낸다. 이를 Core의
     `recordTuiPrompt`로 기록한다(AP-D002). 내부 임시 thread는 제외한다.
   - 이벤트와 로그에는 원문을 넣지 않는다. 기록은 Instruction store만 한다.
6. **이력**: `readHistory`는 `thread/turns/list` pagination으로 구현한다. cursor는 opaque로 다룬다.
   Naru는 transcript를 저장하지 않는다.
7. **재시작 probe**: `probe(threadId)`는 app-server의 thread 상태로 `running`, `idle`, `missing`,
   `unknown` 중 하나를 돌려준다. crash 뒤 마지막 turn이 `interrupted`면 성공으로 간주하지 않는다.
8. **기존 동작 보존**(INV-10)
   - 사용자가 만든 기존 Codex Pane(`codex-main`, `codex-quick`)의 동작, D009 activity, push 알림,
     `/resume` picker, hook은 바뀌지 않아야 한다.
   - managed 기능은 managed 세션에서만 켜지게 additive로 넣는다.
   - integration IPC에 새 메시지를 추가하면 versioning과 구 consumer 호환성을 설명한다.

## 2. 소유 경로

- worker 소유
  - `apps/server/src/agent-runtime/codex/**`(신규)
  - Codex relay, guardian, launcher, `integrations/codex/*`의 additive 변경
  - 관련 테스트(`apps/server/test/*codex*`, 신규 `agent-runtime-codex*.test.ts`)
- integration 소유
  - `apps/server/src/agent-platform/**`, `apps/server/src/agent-runtime/{adapter,writer-gate,capabilities}.ts`
  - `packages/contracts/**`, DB migration, `docs/agent-platform-v0/{DECISIONS,ARCHITECTURE,TASKS}.md`
  - root `package.json`과 lockfile
  - 이 경로를 바꿔야 하면 `DECISION_REQUEST.yaml`에 이유와 제안 diff를 남기고 다른 작업을 계속한다.
- 운영 instance, launchd, distribution 설정(Host profile 추가 포함)은 바꾸지 않는다. 필요한 Host
  profile이나 설정은 설계와 테스트 fixture로 준비하고, 운영 적용 절차는 HANDOFF에 적는다.

## 3. 안전

- 이 Codex 세션은 운영 Naru Host PTY 안에서 실행된다. 운영 Naru, Host, Gateway, 전역 daemon, 그리고
  직접 띄우지 않은 process를 건드리지 않는다.
- 테스트는 격리 Host fixture와 fake model(`apps/server/test/codex-acceptance-fixture.ts` 패턴)을 기본으로
  한다. real model은 써도 되지만, 기본 `pnpm test`에 포함되지 않게 env로 켠다.
- 원문 로그는 저장소 밖 `../../experiments/naru-agent-spikes/codex-adapter/`(owner-only)에 둔다.
  token, 실제 path, transcript는 커밋하지 않는다.

## 4. 완료 조건

- 위 1~8을 자동 테스트로 증명한다. fake model 기반이어야 하고 기본 `pnpm test`에 포함되어야 한다.
  - 같은 thread를 GUI channel과 실제 TUI가 공유한다.
  - 비writer의 turn 시작과 승인 응답이 거부된다.
  - writer를 turn 경계와 interrupt 두 방식으로 이전한다.
  - Naru restart 뒤 GUI channel이 재연결된다.
  - MCP capability가 thread별로 바인딩된다. Naru MCP로 `delegate`를 기록하는 왕복을 포함한다.
  - TUI 직접 입력이 기록되고, 내부 thread는 제외된다.
  - 이력 pagination이 동작한다.
  - probe가 `unknown`이나 `interrupted`를 성공으로 바꾸지 않는다.
  - 기존 Codex Pane 회귀가 없다.
- real CLI 인수 테스트를 하나 둔다(`NARU_ACTUAL_CODEX` 같은 env gate). 결과를 보고서에 기록한다.
- `pnpm format`(변경 파일), `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm public:scan`을 모두 통과한다.
- `docs/agent-platform-v0/assignments/codex-adapter/HANDOFF.yaml`에 다음을 기록한다.
  - 구현 범위, 테스트 결과, 남은 범위
  - 운영 적용에 필요한 설정 변경(Host profile 등)과 승인 경계
  - `capabilities.ts`의 Codex 항목에 제안하는 변경(예: Naru가 enable한 기능)
- 막히면 `DECISION_REQUEST.yaml`(`canContinue` 포함)을 남기고 독립 작업을 계속한다. 완료하지 않은 작업을
  완료로 쓰지 않는다.
