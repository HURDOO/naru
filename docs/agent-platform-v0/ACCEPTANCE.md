# Agent Platform v0 인수 결과 (A01~A16)

- 날짜: 2026-10-15. 기준 branch: `upgrade/orchestration`.
- 판정: PASS, PARTIAL(일부만 확인), FAIL, NOT TESTED
- 증거의 종류
  - 자동: Vitest(전체 964건 통과, 7건 skip), Playwright E2E, 격리 Host 통합 테스트
  - fake 인수: `tests/spikes/agent-platform/acceptance-fake.ts`
    - 빌드한 Naru 서버(운영 진입점), 격리 Host, 실제 git 저장소를 쓴다.
    - 에이전트는 puppet이다. Naru가 전달하는 turn마다 시나리오가 할 일을 정한다. 호출은 에이전트 자신의
      Naru capability로 한다.
  - 실제 모델 인수
    - `tests/spikes/agent-platform/acceptance-real.ts`(Claude, 사용자 로그인)
    - AP-T13 Codex 인수(`gpt-6-astra`)
    - AP-T14 Claude 인수
    - V06c 메시징
- 실제 instance(운영 Naru)는 쓰지 않았다. 운영 배포는 별도 승인이 필요하다.

## 요약

| ID  | 내용                                           | 판정        | 근거                                                                    |
| --- | ---------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| A01 | 기존 passkey, project, TUI, Hook 동작 유지     | **PARTIAL** | 자동 회귀 전체 통과. 운영 instance의 passkey와 Hook 알림은 사용자 확인  |
| A02 | Main → 두 Project Orchestrator 계획            | **PASS**    | fake 인수와 실제 Claude 인수                                            |
| A03 | 사용자 직접 지시가 작업자에게 원본과 함께      | **PASS**    | fake 인수, Core 테스트                                                  |
| A04 | Opus native subagent를 관찰해 표시             | **PASS**    | 실제 Claude 인수(관찰만, AP-D014)                                       |
| A05 | Naru 관리형 subagent가 별도 Host 세션          | **PASS**    | fake 인수, AP-T14 실제 boot 인수                                        |
| A06 | Codex GUI→TUI→GUI writer 충돌 없음             | **PASS**    | AP-T13 실제 Codex 인수                                                  |
| A07 | Claude Chat↔TUI 이력 보호, 실패 시 복구        | **PASS**    | AP-T14 실제 인수(전환), fixture(rollback)                               |
| A08 | `npm run dev`류 공유 프로세스, Run 뒤 유지     | **PASS**    | fake 인수, 실제 Claude 인수                                             |
| A09 | SSH·ansible 입력을 사람에게 넘기고 반환        | **PARTIAL** | hold·secure input은 실제 zsh `read -s`로 PASS. 실제 SSH·ansible은 안 함 |
| A10 | 설계 일탈은 승인 대기, 독립 작업은 계속        | **PASS**    | fake 인수, Core 테스트                                                  |
| A11 | 테스트 통과해도 의도 리뷰 실패면 merge 거부    | **PASS**    | fake 인수(실제 git), Core 테스트                                        |
| A12 | Claude↔Claude native 메시지 추적               | **PASS**    | V06c 실제 Claude 세션 3개                                               |
| A13 | 재시작 뒤 복구, 중복 없음                      | **PASS**    | fake 인수(서버 재시작), AP-T10 테스트, AP-T14 실제 boot 인수            |
| A14 | Manual Test 요청에 환경·절차, 필요한 것만 재개 | **PASS**    | fake 인수, UI sandbox 화면                                              |
| A15 | 다른 worktree 결과를 충돌 없이 통합            | **PASS**    | fake 인수(실제 git, merge commit, 충돌 해결), workspace 테스트          |
| A16 | 미지원을 지원이라 하지 않음, 비공식 API 없음   | **PASS**    | capability 표, 결정 기록 감사                                           |

## 시나리오별

### A01. 기존 기능 유지

- 단계: Agent Platform을 opt-in(`NARU_AGENT_PLATFORM=1`)으로 넣고, 꺼진 상태와 켜진 상태를 회귀로 확인했다.
- 실제 상태:
  - Vitest 전체가 통과했다.
  - `pnpm test:e2e`는 29건 중 27건이 통과했다. 실패 2건(`mobile-output-copy:13`,
    `terminal-stability:56`)은 2026-10-10 문서에 기록된 기존 전체 실행 flaky다. 둘 다 재실행에서 통과했다.
    기준 commit(`bb98487`)에서도 같은 spec을 돌려 비교했다.
- 남은 작업: 운영 instance에서 Gateway passkey 로그인, 기존 TUI, Hook 알림을 사용자가 확인한다
  ([MANUAL_TESTS.md](MANUAL_TESTS.md) 1).

### A02. 두 project 목표

- fake: main이 두 project에 Project Orchestrator를 만들고 목표를 위임했다. 각 오케스트레이터가 계획과 작업
  2개를 만들었다. 작업의 원본 지시는 사용자의 전역 지시다.
- 실제(Claude):
  - 사용자 전역 지시 한 번으로 실제 main이 다음을 했다.
    - `list_projects`로 project를 찾았다.
    - project마다 오케스트레이터를 하나씩 만들었다.
    - 목표를 위임했다.
  - 실제 오케스트레이터는 각각 계획 1개와 작업 1개를 만들었고, 지시대로 작업자는 띄우지 않았다.
  - 작업의 원본 지시는 사용자 전역 지시였다.
- 인수 중 찾아 고친 결함(이 결과의 전제):
  - main이 project를 찾을 수 없었다 → `list_projects`
  - 오케스트레이터가 main의 위임 원문을 읽을 수 없었다 → `get_delegated_work`

### A03. 사용자 직접 지시와 원본 전달

- fake: 사용자가 alpha에 새 지시를 내렸다. alpha 오케스트레이터가 작업자의 Task에 위임했다.
  작업자는 `get_delegated_work`로 위임 원문과 사용자 원본 지시를 받았다.
- 결함 수정: 작업자는 wakeup을 받지 못했고 위임 원문도 읽을 수 없었다(commit `1ef8b96`).
- 실제 모델로는 하지 않았다(작업자를 띄우는 비용 때문). 판정 근거는 fake와 Core 테스트다.

### A04. native subagent 관찰

- 실제(Claude): Naru가 띄운 실제 작업자에게 Task 도구로 subagent를 쓰라고 했다. turn 동안 Naru runtime
  상태에 child 1개가 보였고, 끝나자 사라졌다.
- 지원 수준: 관찰만 한다(L1 lifecycle). Naru에서 child에게 입력하지 않는다(AP-D014). 화면에는 "보조
  에이전트 N개 실행 중 (관찰만)"으로 표시한다.

### A05. Naru 관리형 subagent

- fake: 오케스트레이터가 `spawn_agent`로 띄운 작업자 4개가 각각 Host 세션(Pane)에서 실행됐다. 부모는
  오케스트레이터로 기록됐다.
- 실제: AP-T14 boot 인수에서 실제 SDK runner가 Host PTY에서 실행되고 재접속했다
  ([validation/agent-runtime-host.md](validation/agent-runtime-host.md)).

### A06, A07. GUI↔TUI

- A06: [validation/codex-adapter.md](validation/codex-adapter.md). 실제 Codex(`gpt-6-astra`)가 다음을
  모두 통과했다.
  - writer가 아닌 TUI 입력 거부
  - TUI로 넘긴 turn의 기록
  - Naru 재시작 뒤 같은 thread로 계속
- A07: [validation/agent-runtime-host.md](validation/agent-runtime-host.md).
  - 실제 SDK runner → 실제 Claude TUI → runner 전환에서 대화 기억이 이어졌다.
  - TUI가 다른 대화를 보고하면 rollback하는 것은 fixture로 확인했다.

### A08. 공유 프로세스

- fake: 다음이 확인됐다.
  - `keep`인 dev server는 Run이 끝난 뒤에도 실행 중이었다.
  - `run`인 watcher는 Run이 끝나자 정지했다.
- 실제(Claude): 실제 작업자가 `start_process`로 localhost 전용 정적 서버를 띄웠다. 이 서버는 공유
  프로세스(실행 중, port 8765)로 보였고, HTTP 200으로 응답했다.

### A09. 비밀 입력이 필요한 터미널

- 확인한 것:
  - 사람 hold 중에는 에이전트 입력이 거부된다(Core, MCP 테스트).
  - 반환은 명시적 해제, 연결 끊김 유예, idle 세 경우에 일어난다.
  - secure input UI로 넣은 값이 실제 zsh `read -s`에 전달됐다. sandbox의 기록·로그 어디에도 없었다
    ([validation/web-ui.md](validation/web-ui.md)).
  - 에이전트 지침: 비밀번호를 묻는 화면이 보이면 `terminal-control` Handoff를 요청한다(skill).
- 하지 않은 것: 실제 SSH·ansible 대상(시험 대상 서버 필요), 실제 모델이 비밀번호 화면에서 스스로 넘기는지.
- 남은 작업: [MANUAL_TESTS.md](MANUAL_TESTS.md) 6.

### A10. 설계 일탈

- fake: beta 작업자가 `propose_design_change`로 자기 작업을 막았다. 결과:
  - 그 작업의 merge gate에 `open-handoff-design-deviation`이 남았다.
  - 독립 작업 beta-docs는 리뷰 단계까지 진행했다.

### A11. 의도 리뷰가 merge를 막음

- fake: alpha-screen이 진행된 순서는 다음과 같다.
  - 테스트 산출물(종료 코드 0)을 냈다.
  - 의도 리뷰가 실패했다. `merge_task`는 `intent-review-fail`로 거부됐다.
  - 다시 리뷰를 받아 통과한 뒤 통합됐다.

### A12. Claude 간 메시지

- V06c: 실제 Claude 세션 3개가 실제 Core, socket, hook bin으로 다음 5단계를 모두 확인했다
  ([VALIDATION.md](VALIDATION.md) V06b·V06c, AP-D015).
  - 관리 대상끼리: 허가하고, 보낸 쪽·원문·원본 지시를 기록한 뒤 전달
  - 관리 대상이 아닌 세션으로 보내기: 거부
  - hook 없는 세션이 보낸 메시지: 받는 쪽이 막음
  - 받는 쪽이 사람 hold 중: 거부
  - bridge 중단: 보내기·받기 모두 거부(fail-closed)

### A13. 재시작 복구

- fake: 에이전트가 일하는 중에 Naru 서버를 재시작했다.
  - 계획, 작업, 에이전트 수는 그대로였다.
  - 에이전트들은 통합까지 이어 갔다.
- 중복 방지: 같은 idempotency key로 다시 한 command는 한 번만 반영되고, 다른 내용이면 거부된다(Core
  테스트 INV-07).
- AP-T10: 유예 안에 돌아오지 않은 에이전트와 그 Run은 `unknown`이 된다.
- AP-T14 실제 boot 인수: Naru가 종료된 뒤에도 runner가 살아 있었고, 재시작 뒤 다시 붙었다.

### A14. Manual Test 요청

- fake: 작업자가 직접 테스트 요청을 보냈다(준비된 환경: dev server 주소와 확인 명령). 사람이 HTTP로
  "통과"를 결정했다.
  - 그 작업만 다시 진행돼 리뷰로 갔다.
  - 다른 project의 막힌 작업은 그대로였다.
- 화면: Inbox에서 열고 키보드로 결정했다(AP-T17 확인).

### A15. worktree 통합

- 2026-10-16, AP-D019 뒤 다시 실행(fake, 실제 git): 두 작업이 각자 worktree(`naru/<slug>-<task>`)에서
  commit했다. 둘 다 `docs/plan.md`를 고쳐 일부러 충돌하게 했다.
  - 먼저 리뷰가 끝난 branch는 merge commit으로 main에 들어갔다.
  - 다른 branch는 충돌로 거부됐다. project checkout은 merge 전 그대로였다(`git status` 깨끗함).
  - 작업자가 worktree에서 main을 merge해 충돌을 풀었다. 다시 리뷰받은 뒤 merge commit으로 통합됐다.
  - main에는 두 작업이 모두 있고, push는 하지 않는다.
- 이전 결과(2026-10-15, AP-D016 fast-forward)는 갈라진 branch를 rebase와 재리뷰로 통합했다.

### A16. 정직한 지원 표시

- runtime capability 값은 실제로 검증한 것만 true다(VALIDATION Capability Matrix).
- 하지 않은 것은 문서와 화면에 그대로 적었다.
  - OpenCode 관리형(AP-D018, 미룸)
  - native subagent 직접 입력(AP-D014)
  - Home의 리소스 사용량
- 비공식 API는 쓰지 않는다. 쓰는 경로는 다음뿐이다.
  - Codex app-server JSON-RPC와 TUI
  - Claude Agent SDK와 hook
  - Web Push 표준

## 사용자 결정 뒤 추가 확인 (2026-10-16)

- AP-D021 승인 대기 알림
  - 실제 Claude(`acceptance-real.ts ap17`): 작업자가 `python3 -c …` 명령 승인을 기다리는 동안 에이전트
    Pane이 `interaction-required`였다. 사람이 승인한 뒤 `idle`로 돌아왔다. 이 run은 AP-D020(사용자
    settings 포함) 설정으로 실행했다.
  - UI sandbox: "입력 필요" 알림이 여는 주소로 들어가면 에이전트 화면에서 그 작업자와 승인 대기가 열렸다.
    1440px, 360px에서 확인했고 가로 넘침은 0px다. 로그인 직후 에이전트 API를 아직 모를 때 workspace로
    가던 문제를 이 확인에서 찾아 고쳤다.
  - 실제 Web Push 전달은 기존 활동 알림 경로다. 실제 기기 수신은 사용자 Manual Test 8, 9에서 본다.
- AP-D020 사용자 settings
  - SDK probe: 사용자 source를 넣으면 개인 skill(`update-agent-clis`)과 plugin(`swift-lsp`)이 보였다.
    빼면 보이지 않았다.
- AP-D019 merge commit: workspace 테스트와 fake 인수 A15(위)

## 인수 중 찾은 결함과 수정

| 결함                                                              | 수정                                     | commit    |
| ----------------------------------------------------------------- | ---------------------------------------- | --------- |
| 위임받은 작업자가 깨어나지 않음, 위임 원문을 읽을 수 없음         | 작업 역할 wakeup, `get_delegated_work`   | `1ef8b96` |
| main이 project를 찾을 수 없음, PO가 main의 위임을 읽을 수 없음    | `list_projects`, project 범위 위임 포함  | `defd173` |
| Host 한도 등 Naru 거절이 `INTERNAL`로 감, 원인 기록 없음          | 의미 있는 code, `agent.tool.failed` 기록 | `defd173` |
| 실행하지 못한 에이전트가 `starting`에 머묾                        | `failed`로 바꿔 orchestrator를 깨움      | `defd173` |
| orchestrator가 writer일 때 도구 승인에 답할 주체가 없어 자율 정지 | AP-D017                                  | `9c26819` |

## 남은 위험

- 실제 모델 인수는 비용 때문에 범위를 줄였다.
  - 실제 모델이 계획부터 리뷰와 통합까지 끝까지 가는 흐름은 fake로만 확인했다.
  - 실제 모델의 판단 품질(계획의 적절성, 일탈 제안, 리뷰의 엄격함)은 pilot에서 확인한다(AP-T19).
- 사용자 결정: AP-D013, AP-D016, AP-D017, AP-D018은 2026-10-16에 확인됐다. 바꾼 부분은 AP-D019~D021이다.
- 운영 배포 전 확인이 필요한 수정: Codex relay `/subagents`(d7f3061), Node realpath·socket stat(0183088).
