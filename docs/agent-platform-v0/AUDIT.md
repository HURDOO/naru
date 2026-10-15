# Agent Platform v0 저장소 실사 (Phase 0)

- 기준: `upgrade/orchestration` @ `4eb5433` (main과 같음), 2026-10-15
- 범위: SOURCE_SPEC §13의 점검 항목. 실제 instance의 경로, domain, 인증값은 기록하지 않는다.

## 1. 저장소, 빌드, 배포

- 명세의 "Gateway, Naru, DurableSession 세 저장소"는 **하나의 pnpm monorepo**다.
  - `apps/`: `server`, `web`, `durable-session-host`, `workstation-gateway`, `opencode-gateway`, `cli`
  - `packages/`: `contracts`, `domain`, `durable-session-client`, `durable-session-integration`,
    `gateway-verifier`, `tls-material`
  - 그 밖에 `ops/`(Workstation distribution, launchd), `skills/`, `tests/`
- 소스 규모(테스트 제외, 대략): server 21.9k줄, web 12.4k, gateway 6.8k, Host 4.8k, contracts 2.9k,
  domain 2.6k, DS client 1.6k, CLI 1.4k, OpenCode adapter 0.8k
- 도구: pnpm 11.12, Node 24, TypeScript strict, vitest, Playwright
- 표준 진입점: `pnpm format | lint | typecheck | test | build | test:e2e`. 실제 PTY와 실제 CLI를 쓰는
  인수 테스트는 env로 켠다(`DURABLE_SESSION_ACTUAL_PTY`, `NARU_ACTUAL_CODEX` 등).
- 배포:
  - immutable artifact를 plan과 apply로 나누고, exact digest를 승인받은 뒤 적용하며 receipt를 남긴다.
  - Host, Gateway, Naru는 각각 별도 launchd job이고 독립 pin이다(WV0-D014).
  - OmO adapter는 별도 release다(WV0-D013, D015).
- 설치된 런타임(2026-10-15 확인):

  | 런타임      | 버전                             | 설치 형태  |
  | ----------- | -------------------------------- | ---------- |
  | codex-cli   | 0.162.1                          | npm global |
  | Claude Code | 2.1.296                          | npm global |
  | OpenCode    | 1.18.35 + oh-my-openagent 5.1.28 |            |
  | Node        | v24.20.0                         |            |
  | macOS       | Darwin 25.6, arm64               |            |

  인증 방식과 요금제는 비밀값을 열람하지 않기 위해 확인하지 않았다.

- `pnpm install` 직후에는 node-pty `spawn-helper`에 실행 권한이 없을 수 있다. 실제 PTY 검증 전에
  `pnpm workstation:preflight`를 실행한다.

## 2. 기능 실사

| 영역    | 기능                                                                                              | 상태                                     | 코드 경로와 근거                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Gateway | passkey, exact Origin, CSRF, source policy                                                        | implemented                              | `apps/workstation-gateway/src/{passkeys,browser-security,security,sessions}.ts`                                                 |
| Gateway | app 경로 routing, dashboard, 서명된 app assertion                                                 | implemented                              | `app-registry.ts`, `assertion-issuer.ts`, `proxy.ts`, `app-dashboard.ts` (WV0-D008)                                             |
| Gateway | 추가 upstream app(OmO)                                                                            | implemented                              | WV0-D011, WV0-D013, `apps/opencode-gateway`                                                                                     |
| Gateway | 비브라우저(agent) 주체 인증                                                                       | absent                                   | Gateway는 브라우저 주체만 다룬다                                                                                                |
| Naru    | Gateway assertion 검증과 app 권한                                                                 | implemented                              | `apps/server/src/gateway-auth.ts`, `packages/gateway-verifier`                                                                  |
| Naru    | bind 제한(loopback 또는 고정 private 대역, wildcard 거부)                                         | implemented                              | `apps/server/src/config.ts` `validateHost`                                                                                      |
| Naru    | Project, ProjectGroup, worktree 연결                                                              | implemented                              | `project-catalog.ts`, `git-metadata.ts`                                                                                         |
| Naru    | Workspace, Pane, versioned layout                                                                 | implemented                              | `database.ts`, `packages/contracts/src/naru-app/v1`                                                                             |
| Naru    | 사람 기기 단위 control-surface lease                                                              | implemented (instance 전체 1개)          | `lease.ts`. 터미널 입력과 HTTP 변경을 모두 `requireSurfaceController`로 통제한다(AP-D005 변경 대상)                             |
| Naru    | Pane activity의 WS와 push fan-out                                                                 | implemented                              | `supervisor.onActivity` → `app.ts`(activity 구독부) → `push-notifications.ts`                                                   |
| Naru    | Codex guardian, app-server, `--remote` TUI relay                                                  | implemented                              | `codex-interaction-{relay,guardian,state}.ts`. client 최대 4개(primary 1 + 보조)                                                |
| Naru    | Codex thread ID 추적과 resume                                                                     | implemented                              | `codex-session-hook*.ts`, `codex-session-tracker.ts`                                                                            |
| Naru    | Claude 관측 hook과 resume                                                                         | implemented                              | `claude-activity-*.ts`, `integrations/claude/port.ts` (D016, D023)                                                              |
| Naru    | Codex와 Claude의 구조화 Chat(GUI) channel                                                         | absent                                   |                                                                                                                                 |
| Naru    | Instruction, Plan, agent Task, Run, Event Store                                                   | absent                                   | 기존 "Tasks" Pane은 문서 작업 원장 뷰어다(`/api/projects/:id/tasks`)                                                            |
| Naru    | agent identity, agent-facing API, MCP                                                             | absent                                   |                                                                                                                                 |
| Naru    | orchestrator 호출(wakeup)                                                                         | absent                                   |                                                                                                                                 |
| DS      | lifecycle, persisted metadata, 재시작 뒤 정직한 stopped                                           | implemented                              | `apps/durable-session-host/src/{session-service,metadata}.ts`                                                                   |
| DS      | observer N개 + controller 1개, request/approve/offer/accept, preempt, release, generation fencing | implemented                              | `packages/domain/src/durable-session/reducer.ts`, `attachment-coordinator.ts`. V09로 재확인                                     |
| DS      | attachment를 app+subject에 바인딩, resume token 회전                                              | implemented                              | `attachment-coordinator.ts`. V09로 재확인                                                                                       |
| DS      | heartbeat 15s, stale 35s, reconnect grace 10s                                                     | implemented                              | `DURABLE_SESSION_LIMITS`, `stream-session.ts`                                                                                   |
| DS      | bounded snapshot과 ordered stream, resync                                                         | implemented                              | DS SPEC §6, DS-A01, DS-A09                                                                                                      |
| DS      | `readEvents`/`waitForEvents` bounded journal(terminal 원문 제외)                                  | implemented                              | `event-journal.ts`                                                                                                              |
| DS      | local CLI와 skill                                                                                 | implemented                              | `apps/cli`, `skills/durable-session`                                                                                            |
| DS      | app 등록별 capability와 scope                                                                     | implemented                              | `app-registry.ts`. 운영 Naru 등록은 subject 1개만 허용한다(`ops/workstation/distribution/configuration.ts`의 Naru registration) |
| DS      | 서명된 integration bootstrap                                                                      | implemented                              | `packages/durable-session-integration`                                                                                          |
| DS      | agent principal, secure input, SharedProcess, MCP                                                 | absent                                   |                                                                                                                                 |
| DS      | 사람 개입 hold                                                                                    | absent (Host 수준에서는 의도적으로 없음) | V09: grace가 지나면 Host가 스스로 제어권을 푼다                                                                                 |
| Web     | Pane workspace(split과 좁은 화면 projection), xterm, Files·Docs·Tasks, PWA·push                   | implemented                              | `App.tsx`(3k줄, URL router 없음), `WorkspaceLayout.tsx`, `TerminalPane.tsx`                                                     |
| Web     | Home, Project 그래프, Agent Panel, Inbox                                                          | absent                                   |                                                                                                                                 |
| 보안    | 구조화 로그의 민감 key redaction, 오류는 type과 code만                                            | implemented                              | `observability.ts`. Host logger는 고정 event와 ID만 기록한다(`logging.ts`)                                                      |
| 보안    | terminal 입력 경로에서 저장과 로그 없음                                                           | implemented                              | WS `terminal.input` → `supervisor.write` → Host `sendInput` → PTY. V10                                                          |
| 보안    | browser 저장소                                                                                    | implemented                              | 화면 설정, 마지막 project, client ID만 저장한다                                                                                 |

## 3. 기존 데이터와 migration

- SQLite migration은 v1~v19다. 버전은 앞으로만 올라가고, 더 새로운 버전을 만나면 시작을 거부한다.
  migration 전 backup 계약이 있다(`database-backup.ts`).
- Pane과 Host Session의 연결은 `pane_session_links`, 런타임 대화 식별자는
  `panes.codex_session_id`와 `panes.claude_session_id`에 있다.
- Agent Platform 데이터는 새 테이블로 추가한다. 기존 Pane, Session, hook 데이터는 변환하지 않는다.
  사용자가 만든 기존 Pane을 관리형 agent session으로 자동 승격하지 않는다.
- workspace layout은 `LAYOUT_SCHEMA_VERSION`과 `migrateLayout`으로 버전을 관리한다. 새 Pane kind를
  만들면 layout과 web consumer migration이 따라온다.

## 4. 이전 GUI/TUI 실험 자료

- D009: 원격 TUI의 `/resume` picker가 보조 WebSocket으로 `thread/list`를 읽고, 기본 연결에서
  `thread/resume`을 보낸다. relay는 연결별 request ID를 분리한다. app-server 하나에 client 여러 개가
  붙는 것은 이미 실증됐다. 같은 thread에 동시에 쓰는 경우는 검증되지 않았다(V01).
- 명세 §7.2의 "서로 다른 App Server 간 동일 세션 동시 writer 불가"라는 사용자 사전 검증 기록은
  저장소에 남아 있지 않다(unclear). V01과 V02에서 다시 확인한다.

## 5. 설계 변경 후보와 위험

1. **Host 수준의 agent 주체**: 운영 Host 등록은 Naru subject 하나만 허용한다. 두 가지 선택지가 있다.
   - (a) agent 전용 Host app 등록을 따로 둔다. 별도 credential을 쓰고 preempt와 arbitrary 권한을 주지
     않으므로 Host가 직접 강제한다.
   - (b) Naru의 단일 subject를 유지하고 Naru가 강제한다.
   - 권고는 (a)다. distribution reconfigure 대상이며 운영 적용에는 승인이 필요하다.
2. **LeaseManager 범위 축소**: 지금은 instance 전체의 HTTP 변경과 터미널 입력을 한 lease로 통제한다.
   사람 기기 lease로 좁히고 agent 경로를 분리해야 한다(AP-D005).
3. **Event Store를 붙일 위치**: activity는 `supervisor.onActivity` 한 곳에서 WS와 push로 퍼진다.
   Event Store는 검증이 끝난 이 지점에 구독으로 붙인다. hook 경로를 하나 더 만들지 않으면 이벤트
   중복이 생기지 않는다. Inbox 알림을 push에 추가하면 기존 project별 tag(D024)와의 관계를 설계해야
   한다.
4. **"Tasks" 이름 충돌**: 기존 Tasks Pane은 문서 원장 뷰어다. 도메인 이름은 `agent_tasks`로 하고 UI
   명칭도 구분한다.
5. **Web 구조**: URL router가 없고 `App.tsx`가 크다. 새 화면은 분리된 module로 추가하고, 기존
   workspace는 Sessions 화면으로 유지한다. 화면 전환 방식은 AP-T17 전에 결정한다.
6. **같은 OS 사용자 경계**: 에이전트는 Host와 Naru를 실행하는 OS 사용자와 같은 권한으로 shell을
   실행한다. 그래서 owner-only credential 파일도 읽을 수 있다. agent identity 바인딩은 책임 추적과
   사고 방지 수단이지 악성 에이전트를 가두는 경계가 아니다(DS SPEC §2.2, §11).
7. **자기 호스팅**: 개발 세션이 운영 Host의 PTY 안에서 실행된다. 운영 배포는 이 세션을 종료시킨다.
   모든 검증은 격리 instance에서 한다.
8. **실험적 인터페이스**: Codex app-server는 `[experimental]`이고 Claude의 background와 messaging은
   새 기능이다. 버전별 Capability Matrix로 관리하고, 버전이 바뀌면 다시 검증한다.
