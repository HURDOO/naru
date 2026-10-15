# AP-T13 검증: Naru가 관리하는 Codex 에이전트

- 날짜: 2026-10-15. 환경: macOS arm64, Node 24.19, Codex CLI 0.162.1, 격리 DurableSession Host.
- 두 가지 방식으로 검증했다.
  - 자동 테스트(`agent-runtime-codex.test.ts`, 기본 `pnpm test`에 포함)
    - 가짜 `codex`(app-server와 TUI 역할)를 쓴다.
    - 실제 launcher, relay, guardian, Host PTY, runtime channel, supervisor를 그대로 거친다.
  - 실제 CLI 인수(`agent-runtime-codex.actual.acceptance.test.ts`, `NARU_ACTUAL_CODEX`로 켬)
    - 설치된 Codex와 사용자 로그인을 쓴다.
    - model은 `gpt-6-astra`, reasoning은 codex-main profile의 xhigh다.
    - 작업공간은 이전 검증에서 이미 trust된 workspace다.
    - 대화 원문은 출력하지 않고 marker 단어만 확인했다.

## 결과

| 과제 조건(ASSIGNMENT §4)                                                    | 자동     | 실제 CLI       |
| --------------------------------------------------------------------------- | -------- | -------------- |
| 같은 thread를 Naru channel과 실제 TUI가 공유한다                            | **PASS** | **PASS**       |
| writer가 아닌 쪽의 turn 시작과 승인 응답을 거부한다                         | **PASS** | **PASS**(turn) |
| writer 이전: turn 경계(live)와 interrupt                                    | **PASS** | **PASS**(경계) |
| Naru 재시작 뒤 relay 재접속과 writer 재전달                                 | **PASS** | **PASS**       |
| thread별 MCP capability 바인딩(Codex env에는 없음), Naru MCP 도구 호출 왕복 | **PASS** | **PASS**       |
| TUI 직접 입력 기록(한 번만), 다른 thread로의 resume 거부                    | **PASS** | **PASS**(기록) |
| 이력 pagination(`thread/turns/list`, opaque cursor)                         | **PASS** | **PASS**       |
| native subagent 관찰(L1/L2)                                                 | **PASS** | NOT TESTED     |
| 승인 중계(writer만 응답, 중복 응답 제거)                                    | **PASS** | PASS(MCP 도구) |
| probe(`unknown`·`interrupted`를 성공으로 바꾸지 않음)                       | AP-T10   | AP-T10         |
| 기존 Codex Pane 회귀                                                        | **PASS** | -              |

실제 CLI 인수는 54초에 모두 PASS했다.

## 구조

- 관리형 Codex 에이전트는 Codex Pane(`codex-agent`)이다. Host에서는 `codex-main` profile과
  integration policy로 실행하므로 Host와 배포 설정은 바뀌지 않는다.
- launch 응답은 runtime channel의 socket과 token만 더한다. token은 relay 프로세스에만 있고, Codex와
  그 도구의 환경에는 들어가지 않는다.
- relay는 runner 역할도 맡는다.
  - plan을 받아 thread를 만들거나 resume한다. 이때 `config["mcp_servers.naru"]`와
    `developerInstructions`(역할 지침)를 넣는다.
  - 실제 TUI를 `resume <thread>`로 붙인다.
- TUI에서 오는 frame은 relay가 Naru의 writer로 거른다.
  - writer가 TUI가 아니면 대화 쓰기는 `-32001`로 거부하고, 승인 응답은 버린다.
  - 다른 thread로 resume하는 요청은 항상 거부한다.
- supervisor는 Codex에 live 전략을 쓴다. writer가 바뀌거나 relay가 재접속하면 현재 writer를 알린다.

## 남은 범위

- headless(TUI 없는) 관리형 Codex는 만들지 않았다. Codex의 장점이 같은 thread의 live GUI+TUI이므로 TUI를
  항상 둔다.
- 승인 종류 중 `item/permissions/requestApproval`은 Naru가 권한을 넓히지 않는다(빈 grant). 사람은 TUI에서
  결정한다. form elicitation은 내용 없이 수락한다. 개별 실행은 NOT TESTED다.
- 재시작 probe와 Run 상태 대조는 AP-T10에서 한다.
