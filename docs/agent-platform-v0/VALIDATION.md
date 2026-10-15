# Agent Platform v0 검증 매트릭스 (Phase 1)

## 환경과 판정 기준

- 환경(2026-10-15): macOS Darwin 25.6 arm64, Node v24.20.0, codex-cli 0.162.1, Claude Code 2.1.296,
  OpenCode 1.18.35 + oh-my-openagent 5.1.28. 기준 commit은 `4eb5433`.
- 상태 정의:
  - `PASS`: 설치 버전에서 재현했다.
  - `PARTIAL`: 일부만 재현했거나 분석만 했다. 남은 범위를 함께 적는다.
  - `FAIL`: 재현해 보니 지원되지 않는다.
  - `NOT TESTED`: 아직 실행하지 않았다.
- 공식 문서에 적혀 있다는 이유만으로 PASS를 주지 않는다. 런타임별 상세 보고서는 각 spike branch의
  `validation/*.md`이며, integration이 인수한 뒤 이 표에 반영한다.

## 요약

| ID  | 항목                                                      | 위치                                                            | 상태                                                                                      |
| --- | --------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| V01 | Codex 공유 App Server와 writer 중재                       | `spike/codex-runtime` (AP-T04)                                  | NOT TESTED (사용자가 실행 예정)                                                           |
| V02 | Codex Stop/Release → TUI Resume → GUI 복귀                | `spike/codex-runtime`                                           | NOT TESTED                                                                                |
| V03 | Claude SDK/CLI ↔ TUI 전환                                 | `spike/claude-runtime` (AP-T05)                                 | 진행 중                                                                                   |
| V04 | Codex native subagent L1~L4                               | `spike/codex-runtime`                                           | NOT TESTED                                                                                |
| V05 | Claude native subagent L1~L4                              | `spike/claude-runtime`                                          | 진행 중                                                                                   |
| V06 | Claude cross-session messaging 감사와 차단                | [claude-messaging](validation/claude-messaging.md)              | **PASS**(로컬: 활성화, 형식, hook 감사·차단, 범위 한정 차단), PARTIAL(hook 없는 TUI 관찰) |
| V07 | Claude Agent Teams                                        | `spike/claude-runtime`                                          | 진행 중                                                                                   |
| V08 | Codex↔Codex, Codex↔Claude 통신                            | [claude-messaging](validation/claude-messaging.md), Codex spike | PARTIAL: Claude↔Claude 관리형 MCP는 **PASS**. Codex 측과 왕복은 NOT TESTED                |
| V09 | DurableSession API, stream, control, lease와 agent caller | 이 branch                                                       | **PASS** (Host 계층), PARTIAL (Naru 계층)                                                 |
| V10 | 비밀 입력 보호                                            | 이 branch                                                       | **PASS** (echo-off 경로), 제한 있음                                                       |
| V11 | App Server process와 DurableSession 연결                  | `spike/codex-runtime`                                           | NOT TESTED                                                                                |
| V12 | OpenCode/OmO attach, SDK, child trace                     | `spike/opencode` (AP-T07)                                       | 진행 중                                                                                   |
| V13 | Gateway 사용자 인증과 agent 인증                          | 이 branch                                                       | PARTIAL (분석)                                                                            |
| V14 | 기존 Hook, 세션, 워크플로 migration                       | 이 branch                                                       | PARTIAL (분석)                                                                            |

## V06, V08 요약 (상세: [validation/claude-messaging.md](validation/claude-messaging.md))

- native cross-session 메시징은 기본으로 켜져 있다. 같은 OS 사용자의 모든 로컬 Claude 세션이 서로를
  보고 메시지를 보낼 수 있다.
- 발신자 신원은 스스로 정한 세션 이름과 OS PID뿐이다. 원본 지시 ID를 담을 구조화 필드도 없다. 기본
  설정에서는 다른 세션의 메시지 하나로 수신 세션이 작업(파일 생성)을 수행했다. 그래서 Naru가 관리하는
  세션 사이의 통신은 **Naru MCP 경로를 기본**으로 한다.
- native는 managed 세션에서만 다음 조합으로 차단한다.
  - inbound는 `crossSessionInbound: "refuse"`로 막는다.
  - 발신은 PreToolUse hook으로 막되, SubagentStart로 수집한 agent ID만 허용한다.
  - `SendMessage`를 permission으로 통째로 deny하면 subagent 메시징까지 끊긴다.
- 관리형 MCP stub은 세션마다 별도 process로 실행돼 세션별 env token으로 발신자를 바인딩할 수 있었다.
  모델이 끼워 넣은 `from` 인자를 client가 그대로 전달하므로 신원은 반드시 server에서 결정한다
  (AP-D004, V13과 일치).
- 아직 열린 항목: TUI 세션에 새 메시지를 알려 turn을 시작시키는 wakeup 경로, Teams teammate 대상의
  허용 방식(V07), 일반 Claude Pane에도 차단을 적용할지(사용자 결정).

## V09. DurableSession 제어권과 agent caller

- 재현: `pnpm exec vitest run --config tests/spikes/vitest.config.ts`
  (`tests/spikes/durable-session/agent-control.spike.test.ts`. in-process SessionService에 fake runtime을
  쓴다.)
- 같은 Host app 아래에서 `agent:*` subject(preempt와 arbitrary 권한 없음)와 사람 subject로 다음을
  확인했다.
  - agent가 profile Session을 만들고, 제어권을 획득하고, 입력할 수 있다.
  - agent의 `preemptControl`은 `CAPABILITY_REQUIRED`로 거부된다.
  - 사람은 observer로 붙은 뒤 preempt할 수 있다. generation이 1에서 2로 올라간다.
  - preempt 뒤 agent의 늦은 입력은 이전 generation이면 `CONTROL_GENERATION_STALE`, 현재
    generation이면 `ATTACHMENT_NOT_CONTROLLER`로 거부된다. PTY에는 도달하지 않는다.
  - 사람이 제어하는 동안 agent의 `acquireControl`은 `CONTROL_HELD`로 거부된다.
  - 사람이 release하면 agent가 새 generation으로 다시 획득하고 입력할 수 있다. PTY에 쓰인 순서는
    agent, 사람, agent였다.
  - agent는 사람의 attachment로 입력하거나 release할 수 없다(`ATTACHMENT_NOT_FOUND`). resume token도
    재사용할 수 없다(`ATTACHMENT_RESUME_REJECTED`).
  - 사람 attachment의 연결이 끊기면 grace(10s) 동안은 `CONTROL_HELD`가 유지된다. grace가 지나면
    Host가 controller를 풀고 generation을 올린다. 그 뒤 agent는 획득할 수 있다.
- 판정:
  - Host 계층은 AP-D005가 기대하는 fencing을 이미 제공한다. **PASS**
  - Host에는 "사람 hold" 개념이 없고 grace가 지나면 제어권을 푼다. 따라서 hold와 그 유예·idle 시간은
    Naru 계층에 둔다(AP-D005와 일치).
  - 운영 Host 등록은 Naru subject 하나만 허용한다. agent subject를 Host가 구분하려면 등록을 변경해야
    한다(AUDIT §5-1). 그래서 Naru 계층 E2E는 AP-T12에서 한다. **PARTIAL**

## V10. 비밀 입력 보호

- 재현: `pnpm workstation:preflight` 후
  `NARU_SPIKE_ACTUAL_PTY=1 pnpm exec vitest run --config tests/spikes/vitest.config.ts`
  (`tests/spikes/durable-session/secret-input.spike.test.ts`. 실제 node-pty에서 `/bin/bash`의
  `read -s` 프롬프트를 쓴다.)
- 결과:
  - echo-off 프롬프트에 controller가 입력한 fixture 비밀값은 agent subject observer의 stream,
    controller stream, Host terminal snapshot, `readEvents` journal 어디에도 없었다.
  - 같은 Session의 echo-on 프롬프트에 입력한 값은 observer stream과 snapshot에 그대로 보였다.
- 코드 감사 결과:
  - 입력 경로는 web의 WS `terminal.input` → Naru `supervisor.write` → Host `sendInput` → PTY다.
    Naru 구조화 로그는 event와 ID만, Host logger는 고정 event 목록만 기록한다. 입력 data를 로그에
    넣는 경로는 없다.
  - Host는 짧은 중복 제거를 위해 입력의 SHA-256 fingerprint를 메모리에 60초 보관한다. salt가 없지만
    디스크에는 쓰지 않는다. secure input을 구현할 때 keyed hash 적용이나 fingerprint 생략을 검토한다.
  - browser 저장소에는 화면 설정, 마지막 project, client ID만 있고 입력 내용은 없다.
  - agent의 LLM 컨텍스트는 관찰(snapshot과 output)로만 terminal 내용을 받는다. 그래서 echo-off 비밀은
    들어가지 않는다. echo-on 비밀은 들어갈 수 있다.
- 판정: echo-off 경로는 **PASS**다. 제한은 다음과 같다.
  - 프로그램이 직접 출력(echo)하는 값은 secure input으로도 숨길 수 없다. 화면에 비밀 입력 요구가 보이면
    에이전트가 사람에게 넘기는 규칙(AP-D003)과, 사람이 echo-off 프롬프트에 secure input을 쓰는 방식이
    방어선이다.
  - secure input을 넣을 위치: `TerminalPane` 입력 경로에 별도 입력 control을 두고 새 WS frame 유형을
    정의한다. 이 frame은 agent 입력 기록, draft, 보조 입력창 경로에서 제외한다(AP-T12).
- 아직 하지 않은 것: 실제 SSH나 ansible 프롬프트(A09), 웹 UI 경로의 E2E(secure input 구현 뒤).

## V13. Gateway 사용자 인증과 agent 인증

- 사용자 경로(현재):
  1. Gateway passkey와 session에서 짧은 수명의 서명된 app assertion이 발급된다.
  2. Naru가 issuer, audience, owner, Origin, expiry를 검증한다(`gateway-auth.ts`).
  3. Naru가 app 권한을 확인한다.
  4. Naru가 등록된 app credential로 Host capability를 붙여 호출한다.
  - Naru는 loopback이나 고정 private 대역에만 bind하고 wildcard를 거부한다. Host는 owner-only UDS와
    0600 credential을 쓴다.
- agent 경로(제안, AP-D004와 AP-T11):
  - agent는 Gateway를 거치지 않는다. MCP stdio bin이 owner-only UDS로 Naru에 연결한다. 0700
    디렉터리, 0600 socket, `lstat` 검증은 기존 `integrations/codex/server.ts`와 같은 방식이다.
  - Naru가 띄운 agent session마다 짧은 수명의 capability를 발급한다. Claude hook의 Pane/runtime
    capability와 같은 방식이다. Naru가 이 capability로 `actor_id`를 결정한다.
  - browser API와 agent API는 서로 다른 listener에 둔다. 브라우저는 agent 경로를, agent는 브라우저
    경로를 사용할 수 없다.
- 구현 근거(AP-T11): agent capability와 owner-only socket, MCP bin으로 다음을 확인했다.
  - 위조한 `from` 인자 거부, revoke 뒤 거부, 오류 응답에 원문 미노출(`apps/server/test/agent-platform-mcp.test.ts`)
  - 실제 Claude Code 2.1.296에서 위임이 capability의 orchestrator 신원으로 기록됐다
    (`tests/spikes/agent-platform/claude-mcp-roundtrip.ts`, 원문 로그는 experiments에 있다).
  - Codex 주입은 아직 확인하지 않았다(V08 Codex).
- 판정: **PARTIAL**. Claude 경로는 동작하지만, Naru 시작 경로 연결과 Codex 경로가 남았다. 확정된
  제한이 하나 있다. agent는 같은 OS 사용자로 shell을
  실행하므로 owner-only credential을 읽을 수 있다. agent 인증은 책임 추적과 사고 방지 수단이며,
  악성 agent를 가두는 경계가 아니다. 격리가 필요하면 별도 OS 사용자나 sandbox가 필요하고 이는 v0 범위
  밖이다. Gate 1에서 사용자에게 알린다.

## V14. 기존 Hook, 세션, 워크플로 migration

- DB:
  - v19까지 앞으로만 migration하고 backup 계약이 있다. Agent Platform은 v20 이후 additive table로
    추가하고, Pane holder처럼 기존 테이블에 필요한 열은 nullable로 추가한다.
  - 기존 Pane과 Session link, Codex와 Claude session ID는 변환하지 않는다.
- Hook과 이벤트 중복:
  - Codex relay와 hook, Claude hook은 모두 Naru 검증을 거친 뒤 `supervisor.onActivity` 한 곳에서
    WS와 push로 퍼진다.
  - Event Store는 이 지점에 구독으로 붙이고 별도 hook 경로를 만들지 않는다. 이렇게 하면 같은 신호가
    두 번 처리되지 않는다.
  - Inbox push는 기존 project tag와 정리 규칙(D024)과 함께 설계한다.
- 워크플로 화면: project, workspace, layout은 그대로 둔다. 새 화면은 Pane kind가 아닌 별도 화면으로
  시작해 layout schema migration을 피한다.
- 호환성: 새 WS frame은 additive로 추가하고, 기존 사례(D013)처럼 server와 web을 같은 release로
  배포한다.
- 판정: **PARTIAL**(분석). v19 DB fixture로 실제 migration을 실증하는 것은 AP-T09에서 한다.
