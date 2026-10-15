# AP-T14 검증: Host PTY에서 실행하는 관리형 Claude 에이전트

- 날짜: 2026-10-15. 환경: macOS arm64, Node 24.19(LTS), 격리 DurableSession Host, 임시 디렉터리.
- 두 가지 방식으로 검증했다.
  - fixture: 모델과 계정 없이 실행했다. SDK 자리에는 같은 export를 가진 스크립트(AP-D012의 port
    형태)를, Claude TUI 자리에는 `SessionStart` 활동 hook을 부르는 stand-in을 두었다.
  - 실제 인수(`SPIKE_REAL=1`): 사용자가 설치한 SDK 0.3.296과 Claude CLI 2.1.296, 사용자 로그인,
    model `claude-opus-5-5`를 썼다.
    - 작업공간은 V03에서 이미 trust된 검증 workspace다. 그래서 trust 대화상자가 뜨지 않았고 키 입력도
      보내지 않았다.
    - 대화 내용은 출력하거나 저장하지 않고, 정해진 단어가 이력에 있는지만 확인했다.
- 운영 instance와 사용자의 실제 Claude 세션은 건드리지 않았다.

## 결과

| 항목                                                             | 근거                                                             | 상태     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | -------- |
| 에이전트 Pane이 작업공간에 접힌 채 들어가고 agent에 묶인다       | `agent-runtime-host.test.ts`, boot spike                         | **PASS** |
| runner가 Host PTY에서 실행되고 Naru에 접속한다(launch 응답 env)  | `agent-runtime-host.test.ts`, boot spike                         | **PASS** |
| Claude 환경에 runner token과 Pane bootstrap이 넘어가지 않는다    | `agent-runtime-host.test.ts`(SDK가 받은 env 확인)                | **PASS** |
| Pane console에는 lifecycle만 나오고 대화 원문이 없다             | `agent-runtime-host.test.ts`                                     | **PASS** |
| turn 중 runtime channel 재시작 뒤 결과 전달                      | `agent-runtime-host.test.ts`, `agent-runtime-supervisor.test.ts` | **PASS** |
| 대기 중인 runner가 Naru process 종료를 넘어 살아 있고 재접속한다 | boot spike, `agent-runtime-supervisor.test.ts`                   | **PASS** |
| stop 뒤 같은 대화로 resume, Pane 재사용                          | `agent-runtime-host.test.ts`, boot spike                         | **PASS** |
| runner → TUI → runner(stop-resume), generation fencing           | `agent-runtime-host.test.ts`, boot spike                         | **PASS** |
| TUI가 다른 대화 ID를 보고하면 runner로 rollback                  | `agent-runtime-host.test.ts`                                     | **PASS** |
| 실제 서버 진입점(`index.ts`)과 HTTP API로 생성·Chat·개입·해제    | boot spike(빌드 산출물과 source 실행 모두)                       | **PASS** |
| Chat turn 재전송이 대화에 두 번 들어가지 않고, stale writer 거부 | `agent-platform-http.test.ts`                                    | **PASS** |
| 실제 SDK runner → 실제 Claude TUI → runner, 대화 기억 유지       | boot spike 실제 인수(`SPIKE_REAL=1`)                             | **PASS** |

boot spike: `tests/spikes/agent-platform/naru-managed-agent-boot.ts`

- 빌드 산출물로 실행한 fixture 결과는 7단계 모두 PASS다: 부팅, 접힌 Pane, Chat 개입·turn·이력, TUI
  개입·해제(generation 2→4→5), Naru 종료 뒤 runner 생존, 재시작 뒤 재접속, stop.
- 실제 인수는 대화 기억 확인을 더한 8단계가 모두 PASS다.
  - 실제 TUI의 `SessionStart`가 Pane 활동 hook으로 resume을 확인했다.
  - 다시 띄운 runner의 SDK가 같은 대화를 이어 첫 답의 단어를 기억했다.

## 이번 검증에서 찾아 고친 문제

1. 새 runner의 이벤트 순번
   - 증상: stop 뒤 다시 실행한 runner의 이벤트가 버려졌다. 새 runner는 1부터 세는데 supervisor는
     이전 runner의 순번을 들고 있었다.
   - 수정: 시작 전 runner가 접속하면 순번과 승인을 초기화한다.
2. 대기 중 runner의 종료
   - 증상: Naru process가 끝나면 대기 중인 runner도 끝났다. 재접속 timer가 `unref` 되어 있어 다른
     handle이 없으면 event loop가 비었다.
   - 실제 SDK에서는 Claude 자식 process가 loop를 붙잡아 드러나지 않았을 수 있다.
   - 수정: timer를 referenced로 둔다. 회귀 테스트는 수정 전 실패, 수정 후 통과를 확인했다.
3. resume한 runner의 대화 확인(실제 인수에서 발견)
   - 증상: TUI에서 runner로 돌아올 때 시간 안에 확인되지 않았다.
   - 원인: 실제 SDK는 첫 입력 전에는 `init`을 보내지 않는다. resume한 대화는 첫 입력 전에도
     `session_title_changed`와 `commands_changed`에 같은 session ID를 실어 보낸다(토큰을 쓰지 않는 probe로
     확인). 또 runner가 resume ID를 미리 들고 있어서 같은 ID를 확인으로 보지 않았다.
   - 수정: session ID가 있는 첫 system 메시지로 대화를 확인한다. 확인 여부는 ID와 따로 기록한다.
4. Node realpath와 socket stat (운영 영향 가능)
   - 증상: 에이전트 Pane이 실행 중일 때 Naru를 재시작하면 Fastify를 만들다가
     `Cannot find module 'ajv/dist/jtd'`로 종료됐다.
   - 원인: Node의 JavaScript `realpathSync`가 cache된 경로 구성요소를 볼 때 process 공용 stat 결과를
     읽는다. 마지막 stat이 socket이나 FIFO면 해석을 일찍 멈춘다. 그래서 Host socket을 `lstatSync`로
     확인한 직후의 지연 `require()`가 pnpm symlink를 풀지 못한 경로로 해석됐다.
   - 재현: Node 24.19와 26.4 모두 최소 재현에서 실패했다.
   - 수정: `lstatSocketSync`(durable-session-client)와 Codex endpoint 확인이 상위 디렉터리를 한 번 더
     stat해, 공용 결과가 socket으로 끝나지 않게 한다. 회귀 테스트(`socket-stat-lazy-require.test.ts`)는
     수정 전 실패, 수정 후 통과를 확인했다.
   - 운영 영향: 기존 운영 경로도 Host socket 확인 직후 지연 `require()`가 오면 같은 조건이 된다.
     운영 반영은 배포 승인이 필요하다.

## 남은 범위와 부산물

- 처음 trust하는 디렉터리에서는 실제 TUI가 trust 대화상자를 띄운다. 이 경우 `SessionStart`가 늦어
  전환이 rollback될 수 있다. 운영 전 사람 테스트에서 확인하고, 필요하면 확인 시간과 안내를 조정한다.
- 실제 인수의 Claude transcript는 검증 workspace 아래(`~/.claude/projects/`의 해당 항목)에 남았다.
  정리가 필요하면 `claude purge`로 그 경로를 지운다.
- main orchestrator(project 없음)의 실행 위치는 AP-T16에서 정한다. 지금 Pane은 project에만 만든다.
- 재시작 후 runner가 돌아오지 않은 에이전트를 찾는 probe는 AP-T10이다. 지금은 이 process에서 끊긴
  경우에만 15초 뒤 `unknown`으로 둔다.
