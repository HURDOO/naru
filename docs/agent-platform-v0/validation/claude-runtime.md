# Claude 런타임 검증: V03, V05, V07, 추가 조사 a~d

- 검증일: 2026-10-15
- 대상: Claude Code CLI 2.1.296(npm global, macOS arm64), Claude Agent SDK 0.3.296
  (`claudeCodeVersion` 2.1.296, SDK의 `pathToClaudeCodeExecutable`로 같은 CLI 사용)
- 실행: 저장소 스크립트는 Node.js 24.20.0. SDK 스크립트는 저장소 밖 scratch 디렉터리에서 실행했다.
- 인증: 현재 로그인된 사용자 구독 계정(OAuth). 인증 정보는 복사하거나 바꾸지 않았다.
- 격리: 저장소 밖 scratch git repo를 작업 디렉터리로 썼다. `--setting-sources project,local`로 사용자
  global settings와 그 hook을 제외했고, 부모 Claude Code·Naru·Codex 환경 변수 없는 최소 env를 썼다.
  운영 Naru, Host, Gateway는 사용하거나 변경하지 않았다.
- 원문 증거: 저장소 밖 owner-only `experiments/naru-agent-spikes/claude-runtime/logs/`에 stream-json,
  PTY 화면, hook payload가 있다. 이 문서에는 구조, 순서, 판정만 옮긴다.
- 재현: `tests/spikes/claude-runtime/README.md`

판정은 설치 버전에서 재현한 동작만 기준으로 한다. 문서에만 있는 내용은 근거로만 인용한다.

## 요약

| 항목                | 상태    | 핵심 결과                                                                                                                          |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| V03 resume 왕복     | PASS    | print/SDK → TUI `--resume` → print/SDK에서 같은 session ID와 이력이 이어진다                                                       |
| V03 동시 writer     | FAIL    | CLI가 같은 session의 동시 writer를 막지 않는다. turn이 비결정적으로 사라진다                                                       |
| V03 live attach     | PARTIAL | `--bg` session만 `claude attach`로 live attach된다. 여러 attach는 입력 칸을 공유한다. print/SDK session은 attach할 수 없다         |
| V03 쓰는 중 관찰    | PASS    | 공식 `getSessionMessages`가 진행 중인 turn을 message 단위로 증분 반환한다(print writer 기준)                                       |
| V05 L1 lifecycle    | PASS    | `task_started/progress/updated/notification`, `SubagentStart/Stop` hook, 부모 `tool_use_id`, `agent_id`                            |
| V05 L2 transcript   | PASS    | `--forward-subagent-text`에서 자식 message가 `parent_tool_use_id`와 함께 실시간 도착한다. 사후에는 `getSubagentMessages`           |
| V05 L3 interactive  | FAIL    | client가 실행 중인 subagent에 직접 보낼 경로가 없다. 메시지는 main thread로 간다. `stopTask`는 확인하지 못했다                     |
| V05 L4 PTY          | FAIL    | subagent는 같은 process 안에서 실행된다. 독립 process나 PTY가 없다                                                                 |
| V05 억제            | PASS    | `--disallowedTools Task Agent`로 subagent tool이 제거된다                                                                          |
| V07 Agent Teams     | PARTIAL | interactive TUI의 in-process teammate만 동작한다. print/SDK에서는 일반 subagent로 실행된다. split pane은 tmux가 없어 NOT TESTED    |
| (a) TUI prompt 원문 | PASS    | `UserPromptSubmit` hook payload에 `prompt` 원문과 `prompt_id`가 TUI와 print 모두에서 온다                                          |
| (b) 세션별 MCP·env  | PASS    | session마다 별도 MCP process가 뜨고 `--mcp-config`의 server env를 받는다. process env도 상속된다                                   |
| (c) 이력 재구성     | PASS    | 공식 SDK `getSessionMessages`·`listSessions`·`getSubagentMessages`로 TUI turn을 포함한 이력을 읽는다                               |
| (d) model ID        | PASS    | `opus`·`fable`·`sonnet`·`haiku`가 각각 `claude-opus-5-5`·`claude-fable-5-1`·`claude-sonnet-5-5`·`claude-haiku-5-5`로 실제 실행됐다 |

## V03. SDK·print 세션과 TUI 전환

### 왕복: PASS

`v03-resume-roundtrip.ts`의 흐름은 다음과 같다.

1. `-p --session-id <uuid>`로 첫 turn을 실행했다. init의 `session_id`가 요청한 UUID와 같았다.
2. PTY의 TUI를 `--resume <uuid>`로 열었다. 이전 turn이 화면에 렌더됐다. `SessionStart` hook의
   `source`는 `resume`이고 `session_id`는 같았다. TUI turn에서 첫 codeword를 변형(역순 소문자)해
   답했으므로 이력이 실제 context로 이어졌다.
3. TUI를 `/exit`로 종료했다(`SessionEnd` reason `prompt_input_exit`). 이후 `-p --resume`의 init
   `session_id`가 같았고, print turn과 TUI turn의 codeword를 모두 기억했다.

SDK에서도 같은 결과가 나왔다(`sdk/sdk-spike.mjs`, `ONLY=v03`): `query({sessionId})` → CLI
`-p --resume` → `query({resume})`. session ID가 유지되고 두 codeword를 모두 기억했으며
`getSessionMessages`가 7개 message를 반환했다. 기본 resume은 fork하지 않는다.
`--fork-session`과 SDK `forkSession`은 명시적으로 지정했을 때만 새 ID를 만든다.

### 동시 writer: FAIL (native 보호 없음)

`v03-concurrent-writers.ts`를 두 번 실행했다.

- **Case A**: print 두 개가 같은 session을 동시에 resume했다. 두 번 모두 거부나 오류 없이 exit 0이었고
  같은 session ID를 보고했다. 이후 recall 결과는 실행마다 달랐다.
  - 1회차: 기본 codeword와 양쪽 codeword를 모두 기억했다.
  - 2회차: 한쪽 codeword만 기억했고 기본 codeword도 잃었다.
- **Case B**: idle TUI가 session을 연 상태에서 print turn이 추가됐다.
  - TUI 화면은 print turn을 live로 반영하지 않았다.
  - 이어진 TUI turn은 print turn을 모르는 상태로 진행됐다.
  - 이후 resume은 기본과 TUI codeword만 기억하고 print turn을 잃었다. 2회 모두 같았다.

결론: Claude Code는 같은 session ID의 동시 writer를 감지하거나 거부하지 않는다. 두 writer가
겹치면 한쪽 turn이 이력에서 사라질 수 있다. 예외는 `--bg --resume`뿐이다. 실행 중인 background
session을 다시 `--bg --resume`하면 "already running in the background, so this started a copy"라고
알리고 새 session ID로 copy를 만든다. **Naru가 Claude session ID 단위의 writer lock을 강제해야
한다.**

### live attach: PARTIAL

`v03-background-attach.ts`의 결과:

- `claude --bg`는 transient daemon(`claude daemon run`)과 session별 `bg-pty-host`를 띄운다.
  - TUI는 이 daemon 소유 PTY에서 실행된다. DurableSession 밖이다.
  - `claude agents --json --all`에 `kind: background`로 나타난다.
- `claude attach <id>`를 terminal 두 개에서 동시에 열었다.
  - 두 화면 모두 live로 갱신되고 렌더가 같았다.
  - 한쪽에 입력한 draft가 다른 쪽 입력 칸에 그대로 보였다.
  - 다른 쪽에서 제출한 turn의 응답도 양쪽에 보였다.
  - 즉 attach client 사이에 writer 중재가 없다.
- attach를 모두 종료해도 session은 살아 있었다(pid 유지, `status: idle`).
  `claude stop`과 `claude rm`으로 정리했고, 그 뒤 transient daemon은 스스로 종료됐다.

`v03-print-live-attach.ts`의 결과:

- 실행 중인 print session은 `claude agents --json`에 `kind: interactive`, `status: busy`로 나타난다.
  L1 수준의 존재·상태 관찰이 가능하다.
- `claude attach <session-id>`는 "No job matching"으로 실패했다. print/SDK session에는 TUI live
  attach가 없다.

### 다른 writer가 쓰는 동안의 관찰: PASS (message 단위)

`sdk-spike.mjs ONLY=observe`에서 SDK writer가 6번의 tool 호출 turn을 진행하는 동안 별도 루프가
0.7초마다 `getSessionMessages`를 호출했다. 결과 이전의 message 수가 0→1→4→…→19로 증가했고 최종
20이었다. token streaming은 아니지만 GUI가 다른 writer의 진행을 read-only로 관찰할 수 있다.
TUI writer의 증분 기록 시점은 따로 측정하지 않았다. 이력에 반영되는 것은 왕복 검증으로 확인했다.

## V05. Claude native subagent

`v05-subagent-trace.ts`에서 general-purpose subagent가 `ls`, `Read`, `git log`를 실행했다.
2회 실행 결과가 같았다.

| 수준           | 상태 | 증거                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 lifecycle   | PASS | `system/task_started`(`task_id`, `tool_use_id`, `subagent_type`, `prompt`, `spawn_depth`, `is_backgrounded`), `task_progress`, `task_updated`, `task_notification`. `SubagentStart/Stop` hook에 `agent_id`·`agent_type`이 있고 Stop에는 `agent_transcript_path`·`last_assistant_message`도 있다. Start와 Stop의 `agent_id`가 일치한다                                                                           |
| L2 transcript  | PASS | `--forward-subagent-text`(SDK `forwardSubagentText`)에서 자식 message 6~8개가 모두 `parent_tool_use_id = task tool_use_id`를 가졌다. 첫 자식 event는 task 시작 직후, 마지막은 Task tool_result 직전에 도착했다. 사후에는 `listSubagents`와 `getSubagentMessages`가 자식 transcript를 반환했다                                                                                                                   |
| L3 interactive | FAIL | subagent 실행 중 stream-json으로 보낸 user message는 `UserPromptSubmit`이 되어 main thread에 반영됐다(최종 답에 marker 포함). 자식 transcript에는 반영되지 않았다. 다음 두 가지는 확인하지 못했다(NOT TESTED). 첫째, SDK `stopTask(task_id)`는 background subagent 실행 중 호출했으나 subagent가 먼저 끝나 control 응답 전에 query가 닫혔다. 둘째, model이 `SendMessage`로 대신 전달하는 경로는 시험하지 않았다 |
| L4 PTY         | FAIL | subagent 실행 중 CLI process의 자손은 hook shell뿐이었다. 별도 Claude process나 PTY가 없다                                                                                                                                                                                                                                                                                                                      |
| 억제           | PASS | `--disallowedTools Task Agent`면 init tools에 Task가 없고 같은 지시에도 `task_started`가 발생하지 않는다                                                                                                                                                                                                                                                                                                        |

P0 판정에 비춘 결론은 다음과 같다.

- L1과 L2가 공식 이벤트로 확보되므로 Claude native subagent는 **Native 유지 후보**다.
- 다만 사용자가 실행 중인 자식에게 직접 개입하거나 독립 PTY로 관찰해야 하는 작업(L3, L4)은 Naru
  Managed Subagent로 보내야 한다.
- 필요하면 `--disallowedTools Task Agent`로 native를 끌 수 있다.

## V07. Agent Teams

- 활성화는 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`(env 또는 settings `env`)로 한다. 공식 문서는
  experimental이며 기본 비활성이라고 설명한다.
- **print 모드**(SDK와 같은 경로)에서 teammate를 만들라고 지시했다.
  - team 디렉터리가 생기지 않았다.
  - 이름 붙인 agent는 일반 subagent(`local_agent`)로 실행됐다.
  - 문서의 "non-interactive와 SDK에서는 teammate를 만들지 않는다"는 설명과 일치한다.
- **interactive TUI**(PTY)에서 같은 지시를 했다.
  - in-process teammate `scout`가 생겼고 agent panel에 `main`과 `scout`가 표시됐다.
  - team config에는 `team-lead`, `scout` 두 member가 있었다.
  - 추가 Claude process는 없었다(in-process).
  - `SubagentStart/Stop` hook이 teammate에도 발생했다. 이번 흐름에서 `TeammateIdle`은 0회였다.
  - 종료 후 team config 디렉터리는 사라졌다.
  - teammate transcript는 공식 `getSubagentMessages`로 사후에 읽을 수 있었다(11 message).
- teammate와 직접 대화하는 방법은 TUI agent panel 선택이나 split pane뿐이다. 외부 client가 특정
  teammate에게 공식적으로 메시지를 넣을 경로는 확인되지 않았다. mailbox JSON 파일을 직접 쓰는
  방식은 내부 형식이므로 비공식 경로로 보고 시험하지 않았다.
- split pane 모드는 tmux가 설치돼 있지 않아 NOT TESTED다.

결론은 SOURCE_SPEC §8.2와 같다. Agent Teams는 사용자가 interactive Claude Pane 안에서 직접 고르는
하위 작업 도구로만 쓴다. Naru Main/Project Orchestrator의 기반 기술이나 SDK 기반 GUI 경로로 쓰지
않는다.

## 추가 조사

### (a) TUI 직접 입력 원문: PASS

- `UserPromptSubmit` hook payload는 `session_id`, `transcript_path`, `cwd`, `prompt_id`,
  `permission_mode`, `hook_event_name`, `prompt`로 구성된다.
- `prompt`는 print와 interactive TUI 모두에서 제출 원문 그대로였다.
- TUI에서 `/exit` 같은 slash command는 이 hook을 발생시키지 않았다.
- 참고(시험하지 않음): SDK 타입의 `SDKMessageOrigin`에는 `{ kind: "human" }`·`peer` 등 user message
  provenance 필드가 있다.

K1-2의 "관리형 세션에서 TUI 입력 원문 기록"은 기존 D016 관측 hook에 `prompt` 필드를 추가하는
방식으로 구현할 수 있다. 다만 D016 계약은 현재 원문을 버리므로 새 결정이 필요하다.

### (b) 세션별 MCP와 신원 token 주입: PASS

`x-mcp-identity.ts`의 결과:

- 동시에 실행한 두 session에 `--mcp-config` server `env`로 서로 다른 token을 넣었다.
  - 각 session의 `whoami`는 자기 token hash만 반환했고 상대 hash는 보이지 않았다.
  - stub process pid도 서로 달랐다. session마다 MCP server process가 따로 뜬다.
- token을 Claude process env에만 넣어도 MCP server가 상속했다.
- SDK도 `mcpServers` 옵션의 stdio server에 `env`를 받는다. 이 경로는 타입 정의로 확인했고 실행
  검증은 CLI 경로로 했다.

설계 시 주의할 점:

- process env로 넣으면 agent의 Bash tool에도 그 값이 상속된다. per-server `env`로 넣으면 Bash에는
  직접 노출되지 않는다.
- 그래도 같은 OS user의 process이므로 강한 경계는 아니다. 신원은 서버 측 session binding으로
  검증해야 한다(SOURCE_SPEC §11).

### (c) 공식 API만으로 이력 재구성: PASS

공식 SDK export `listSessions`, `getSessionInfo`, `getSessionMessages`, `listSubagents`,
`getSubagentMessages`를 사용했다.

- V03 왕복 session을 `getSessionMessages`로 읽은 결과 TUI turn을 포함한 8개 user/assistant message가
  나왔다.
  - entry key: `message`, `parent_agent_id`, `parent_tool_use_id`, `session_id`, `timestamp`, `type`,
    `uuid`
- `listSessions({ dir })`는 workspace session 목록을 반환한다.
  - key: `sessionId`, `createdAt`, `lastModified`, `firstPrompt`, `summary`, `customTitle`, `gitBranch`,
    `cwd`, `fileSize`, `tag`
- SDK는 내부적으로 JSONL transcript를 읽고 `parentUuid` chain으로 대화를 구성한다. 하지만 이것은
  공식 SDK 함수의 계약이다. Naru가 JSONL을 직접 파싱할 필요는 없다.

K1-7의 "에이전트 대화는 Naru가 저장하지 않고 런타임 API로 다시 읽는다"는 Claude에서 성립한다.
동시 writer로 갈라진 이력에서는 어느 branch가 선택되는지 Naru가 통제할 수 없다. 이 점은 writer
lock의 또 다른 근거다.

### (d) 실제 사용 가능한 model ID: PASS

SDK `supportedModels()`가 alias별 resolved model을 반환했고, CLI로 각각 실제 turn을 실행했다.

| alias                        | resolved model      | 실제 실행 |
| ---------------------------- | ------------------- | --------- |
| `opus`                       | `claude-opus-5-5`   | 성공      |
| `fable`                      | `claude-fable-5-1`  | 성공      |
| `sonnet`                     | `claude-sonnet-5-5` | 성공      |
| `haiku`                      | `claude-haiku-5-5`  | 성공      |
| 기본값(사용자 settings 제외) | `claude-haiku-5-5`  | 성공      |

이 밖에 `claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-8/4-7/4-6`,
`claude-sonnet-4-6`, `claude-haiku-4-5-20251001`이 목록에 있었다. 모두 effort level을 보고했지만
4-6 계열은 `xhigh`가 없다.

사용자 settings를 제외하면 기본 model이 `claude-haiku-5-5`가 된다. 따라서 Naru가 띄우는 관리형
세션은 역할별 model을 명시해야 한다. SOURCE_SPEC §3.2의 Sol, Astra, Luna는 Claude model이
아니므로 Codex 쪽 검증 대상이다.

### 외부 승인 제어 (참고)

SDK `canUseTool` 콜백으로 `permissionMode: "default"`의 Bash 실행을 host가 결정했다. 첫 호출은
거부했고(`permission_denials` 1건) 두 번째는 허용했다. 승인 요청을 Naru Inbox로 보내는 경로의
기술적 근거가 된다. CLI `--permission-prompts host`와 `--permission-prompt-tool`도 같은 계층이다.

## Claude Code 2.1.296 Capability Matrix 초안

SOURCE_SPEC §7.3 필드를 보수적으로 채웠다. 조건부 지원은 `false`로 두고 비고에 범위를 적는다.

| 필드                          | 값             | 비고                                                                                                                    |
| ----------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `structuredChat`              | `true`         | SDK `query`와 CLI `-p --input-format/--output-format stream-json`                                                       |
| `realTui`                     | `true`         | 기존 Naru Claude Pane(DurableSession PTY)                                                                               |
| `liveTuiAttach`               | `false`        | `--bg` session만 `claude attach` 가능. daemon 소유 PTY라 DS 밖이고 attach 간 입력 중재가 없다. SDK/print session은 불가 |
| `safeGuiTuiTransition`        | `false`        | native lock이 없다. Naru writer lock과 Stop→Resume으로만 안전하다(아래 권고)                                            |
| `nativeSubagentTrace`         | `"transcript"` | L1, L2 실시간. L3, L4 미지원                                                                                            |
| `nativeCrossSessionMessaging` | 미평가         | V06 담당 검증 결과를 따른다                                                                                             |
| `externalApprovalControl`     | `true`         | SDK `canUseTool`(허용·거부 확인), CLI `--permission-prompt-tool`                                                        |
| `canBridgeToDurableSession`   | `false`        | TUI는 DS PTY에서 동작한다. SDK protocol process를 DS에 연결하는 방식(관찰용 console 분리)은 시험하지 않았다             |

## GUI↔TUI 전환 권고

A안(공유 backend에서 single writer)은 Claude에 해당하는 공식 경로가 없다.

- SDK와 TUI는 별도 process이고 같은 session을 동시에 쓰면 turn이 사라진다.
- `--bg`와 attach는 TUI끼리만 공유하고 구조화된 writer를 제공하지 않는다.

**B안(Stop/Release → Resume)을 Naru writer lock과 함께 채택하는 것을 권고한다.**

1. `GUI_ACTIVE`: Naru가 Claude session ID 단위 writer lock을 GUI에 준다. SDK `query({resume})`
   process가 유일한 writer다.
2. `SWITCH_REQUESTED → QUIESCING`: 진행 중인 turn의 `result`를 기다리거나 사용자가 명시적으로
   `interrupt()`한다. 응답 중 강제 kill은 하지 않는다.
3. `WRITER_RELEASED`: query를 닫고 process 종료를 확인한 뒤 lock을 TUI로 넘긴다.
4. `TUI_RESUMING → TUI_ACTIVE`: 기존 D023 경로로 Claude Pane을 `--resume <id>`로 시작한다.
   `SessionStart`(`source: resume`, 같은 `session_id`)를 확인한 뒤에만 입력을 연다.
5. 역방향: TUI가 idle(`Stop` 이후 새 `UserPromptSubmit` 없음)인지 확인한다. Pane runtime을 정상
   종료(`SessionEnd`)하고 lock을 GUI로 넘긴 뒤 SDK로 resume한다. init의 `session_id` 일치를
   확인한다.
6. 실패: resume 확인이 시간 안에 오지 않거나 process가 즉시 종료되면 `ROLLBACK`으로 lock을 이전
   쪽에 돌려준다. 같은 ID로 다시 resume할 수 있으며, 이력은 런타임 transcript에 남는다.
7. 관찰: writer가 아닌 쪽 화면은 `getSessionMessages`를 polling해 read-only로 갱신한다(message 단위).

`--fork-session`과 `--bg` 경로는 Naru 관리형 세션에서 사용하지 않는다. `--bg`는 DS 밖의 PTY이고
attach 간 입력 중재가 없어 INV-03과 INV-05를 만족하지 못한다.

## ADR에 영향을 주는 발견

1. Claude 세션은 native writer 보호가 없다. Naru가 session ID 단위 single-writer lock을 강제해야
   하며, 이는 K3 대화 writer의 근거다.
2. GUI↔TUI는 B안이다. 이력 조회와 관찰은 공식 SDK 함수만으로 가능하므로 K1-7(transcript 비저장)이
   성립한다.
3. `UserPromptSubmit.prompt`로 TUI 직접 입력 원문을 얻을 수 있다(K1-2). D016 계약 변경과 관리형
   세션 한정 opt-in이 필요하다.
4. per-session MCP server env로 agent 신원 token을 주입할 수 있다(K2/K3). Bash 상속을 피하려면
   process env가 아니라 server `env`를 쓴다.
5. native subagent는 L1/L2 공식 이벤트가 있어 Native 유지 후보다. L3/L4가 필요한 작업은 Managed로
   보낸다. `--disallowedTools Task Agent`로 억제할 수 있다.
6. Agent Teams는 interactive 전용 실험 기능이라 오케스트레이터 기반에서 제외한다.
7. 관리형 세션은 model을 명시해야 한다(기본값은 사용자 settings 유무에 따라 바뀐다). 사용자 global
   hook이 관리형 세션에도 실행된다. Naru가 settings source를 어떻게 정할지 결정해야 한다(사용자
   결정 후보).
8. `claude agents --json`은 같은 사용자의 모든 활성 Claude session(interactive/background)의
   `sessionId`, `pid`, `cwd`, `status`를 반환한다. reconcile용 L1 신호가 될 수 있지만, Naru가 띄우지
   않은 사용자 session도 포함하므로 binding된 session만 필터해야 한다.

## 미해결

- SDK `stopTask`로 실행 중인 subagent를 중단하는 동작을 확정하지 못했다. 시험한 background
  subagent가 먼저 끝났다.
- model이 `SendMessage`로 background subagent에 대신 전달하는 경로와 V06 메시징 정책 사이의 관계는
  V06 결과와 함께 판단한다.
- TUI writer의 transcript 증분 기록 시점, SDK protocol process의 DurableSession 연결(Claude판 V11),
  Agent Teams split pane(tmux 필요)은 NOT TESTED다.
- spike session은 사용자 Claude 상태 디렉터리에 대화 기록을 남겼고, scratch workspace의 folder trust가
  기록됐다. 정리가 필요하면 `claude purge`로 해당 경로를 지운다.
