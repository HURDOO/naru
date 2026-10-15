# Codex runtime 검증 — 0.162.1

검증일: 2026-10-15. 기준 commit `4eb5433`, branch `spike/codex-runtime`.
macOS arm64, Node 24.20.0, pnpm 11.12.0, 설치된 `codex-cli 0.162.1`을 사용했다.
제품 코드는 변경하지 않았다. 원문은 assignment에 지정된 저장소 밖 owner-only logs에 있다.
아래 경로는 그 logs 디렉터리 기준이다.

**권고: A(공유 App Server + 단일 writer proxy)를 기본 후보로 채택하고 B(Stop/Release→Resume)를
복구 경로로 유지한다.** 실제 TUI가 GUI의 응답을 live로 표시하며, proxy가 비소유자의 write와 승인
응답을 차단했다. native 동시 입력은 진행 중인 턴에 합쳐지므로 native 중재만으로는 INV-05를
충족하지 못한다. 이 결과는 ADR의 근거이며 production adapter 구현·배포 승인이 아니다.

## 판정 요약

| 항목      | 판정                                                    | 실제 확인한 범위                                                                                 | 제한·fallback·결정                                                                                          |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| V01       | PASS                                                    | 같은 thread의 실제 TUI/GUI live 관찰, single writer gate, GUI→TUI→GUI, 완료 대기·interrupt       | app-server와 remote TUI는 experimental. version pin과 adapter lease/fencing 설계 필요                       |
| V02       | PASS                                                    | 서로 다른 app-server의 GUI→remote TUI→GUI, invalid ID, TUI kill, app-server crash, API 이력 복원 | crash 중 미완료 assistant delta는 보존되지 않음. 마지막 turn을 interrupted로 복구하고 재확인                |
| V04       | PARTIAL                                                 | L1 lifecycle, L2 실시간 transcript와 API 이력                                                    | L3 직접 입력/steer 거부. L4는 새 TUI로 읽기 전용 관찰만 확인. native 억제 설정을 보안 강제로 사용할 수 없음 |
| V08 Codex | PASS (managed), FAIL (독립 root native 주소 지정 probe) | 실제 모델 두 thread의 MCP 왕복, sender·원문·origin ID, per-thread env/process                    | Claude 왕복은 integration 소유. stub은 production 인증 구현이 아님                                          |
| V11       | PASS                                                    | 실제 격리 Host PTY의 console, observer/control/reconnect/resize/input 격리, Host 종료·재기동     | graceful Host restart만 검증. 운영 Host나 OS reboot/crash 인수는 수행하지 않음                              |
| X1        | PASS                                                    | 실제 TUI 직접 입력의 `turn/start`와 `UserInput` 구조                                             | 원문 기록은 Naru Instruction store의 별도 정책 필요                                                         |
| X2        | PASS (목록), PARTIAL (모델별 실행)                      | `model/list`의 7개 ID, `gpt-6-sol` 실제 성공                                                     | catalog를 계정별 사용 권한·모델 품질 검증으로 해석하지 않음                                                 |

재현 명령·전제·정리 절차는 [README](../../../tests/spikes/codex-runtime/README.md)에 있다.
공식 출발 문서는 [Codex App Server](https://learn.chatgpt.com/docs/app-server)다.
판정은 설치 CLI가 생성한 스키마와 실행 결과에 근거하며 공식 문서만으로 PASS를 부여하지 않았다.

## 증거 목록

각 실행의 `summary.json`은 관측값, `*.jsonl`은 private frame, `screen-*.txt`는 실제 xterm/headless
화면이다. 저장소에 transcript나 실제 thread ID·path를 복제하지 않는다.

| 항목                   | 성공 실행 디렉터리                         | 주요 파일                                                                                             |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| V01, X1                | `shared-2026-10-15T06-24-56.036Z/`         | `proxy.jsonl`, `gui.jsonl`, `native-a.jsonl`, `native-b.jsonl`, `screen-live.txt`, `screen-final.txt` |
| V01 승인, K1 도구 이력 | `approval-2026-10-15T06-24-58.846Z/`       | `first.jsonl`, `second.jsonl`, `proxy.jsonl`, `history.jsonl`                                         |
| V02, K1                | `resume-2026-10-15T05-59-00.259Z/`         | `gui-a.jsonl`~`gui-d.jsonl`, `api-history-pages.json`, `screen-tui-resumed.txt`                       |
| V04, X2                | `subagents-2026-10-15T06-05-47.016Z/`      | `native.jsonl`, `child-observer.jsonl`                                                                |
| V04 설정, V08 native   | `inventory-2026-10-15T06-12-52.648Z/`      | `*-tool-schema.json`, `cross-thread-tool-outputs.json`, `model.jsonl`                                 |
| V08 fake               | `messaging-fake-2026-10-15T06-08-56.068Z/` | `messaging.jsonl`, `mailbox.json`, `mailbox.json.processes.jsonl`                                     |
| V08 real               | `messaging-real-2026-10-15T06-03-24.910Z/` | `messaging.jsonl`, `mailbox.json`, `mailbox.json.processes.jsonl`                                     |
| V11                    | `durable-2026-10-15T06-06-45.276Z/`        | `host-operations.jsonl`, `console-snapshot.txt`, `gui.jsonl`, `recovered.jsonl`                       |
| V04 child TUI          | `child-tui-2026-10-15T06-23-01.582Z/`      | `proxy.jsonl`, `child-tui-live.txt`, `child-tui-final.txt`                                            |
| schema                 | logs root                                  | `version.txt`, `features.txt`, `schema/`, `types/`, `method-classification.json`                      |

앞선 실패 실행도 지우지 않고 보존했다. 최종 판정은 위 성공 실행을 기준으로 한다. initial
`node-pty` helper 실행 비트 누락, remote TUI의 `--no-daemon` 충돌, npm launcher의 자식 소유권,
Host PTY의 다른 cwd, additional_tools 형식 등 harness 결함을 수정한 뒤 관련 검증을 재실행했다.
crash 주입 중 남았던 검증 전용 native 자식은 고유 fixture socket/cwd로 소유권을 확인해 종료했다.

## V01 — 공유 backend와 writer

1. GUI가 persistent thread를 생성하고 첫 turn을 완료한다.
2. 실제 `codex --remote unix://<private-relay> resume <thread-id>` TUI가 같은 thread에 붙는다.
3. GUI가 slow turn을 시작한다. GUI와 TUI 양쪽에 `turn/started`, `item/agentMessage/delta`,
   `turn/completed`가 전달된다. 완료 **전** snapshot에서 GUI가 받은 synthetic 응답 marker가
   실제 TUI 화면에도 존재했다 (`tuiLiveGuiDelta=true`). 모조 renderer를 TUI로 사용하지 않았다.
4. 서로 다른 두 JSON-RPC client가 같은 thread에 `turn/start`하면 두 번째 요청은 오류 없이
   **동일 active turn ID**를 돌려주며 두 입력이 그 턴에 들어갔다. TUI는 사용 중인 턴의 사용자 입력을
   자체 보류할 수 있다. 이 TUI 동작을 server 차원의 writer mutex로 간주하지 않는다.
5. proxy 활성화 뒤 observer의 `turn/start`, 변경 override를 가진 `thread/resume`, 미분류 method,
   settings write를 `-32071 NARU_SPIKE_WRITER_REQUIRED`로 거부했다. read와 ID만 지정한 resume는
   허용했다. 진행 중 handoff는 거부하고 `turn/completed` 후 허용했다.
6. GUI→TUI→GUI 뒤 같은 thread ID와 이력이 유지됐다. 명시적 interrupt 경로도 `interrupted` 완료
   이벤트를 기다린 뒤 이전에 성공했다. `turn/start` RPC 응답만 받은 직후에는 아직 active turn이
   없어 interrupt가 `-32600`으로 실패할 수 있었다. adapter는 lifecycle 이벤트로 상태를 확인해야 한다.

승인 probe에는 **MCP tool 사용 승인**과 **그 tool의 form elicitation** 두 요청이 있었다. 둘 다
같은 request ID로 두 client에 broadcast됐다. 첫 응답이 처리된 뒤 다른 client의 중복 응답에는
별도 JSON-RPC 오류가 관측되지 않았고 양쪽에 `serverRequest/resolved`가 왔다. 응답 경쟁의 모든
스케줄에서 어느 쪽이 이기는지는 검증하지 않았다. proxy는 비소유자 응답과 이미 소비한 ID의 중복
응답을 차단했고 승인 대기 중 이전도 거부했다. command/file/permissions approval은 생성 스키마에
있지만 각각의 실제 요청을 재현한 것은 아니다.

proxy는 검증용 channel identity와 메모리 writer/generation을 사용한다. production에서는 인증된
Naru agent/session과 연결을 묶고 thread 범위·generation·중단/재연결·pending request를 지속적으로
조정해야 한다. method 목록 전체를 허용하지 않는다. client가 임의로 제시한 header는 production
권한의 근거가 될 수 없다. 이 prototype을 production 보안 모듈로 그대로 채택하지 않는다.

## V02 / K1 — 전환, 실패와 이력

GUI app-server를 종료한 뒤 새 app-server의 실제 remote TUI가 같은 ID를 resume해 새 turn을 수행했고,
이를 종료한 다음 세 번째 app-server의 GUI가 TUI의 사용자 입력과 응답을 API로 읽었다. 1 turn에서
2 turns로 늘어난 이력과 thread ID가 일치했다.

| 실패/경계                                  | 관측                                             | 복구 정책 근거                                                                       |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 첫 turn 저장 전 다른 client의 resume       | `-32600`, rollout 없음                           | 새 thread의 저장 완료를 확인한 뒤 observer attach; 자동으로 다른 ID를 만들지 않음    |
| 없는 UUID resume                           | `-32600`                                         | 기존 유효 thread 이력은 유지. 원래 ID로 rollback 가능                                |
| remote TUI만 turn 도중 SIGKILL             | app-server의 turn은 `completed`                  | TUI 종료를 agent 중단으로 해석하지 않음. 소유한 backend도 quiesce/release해야 B 전환 |
| app-server native process SIGKILL          | 동일 ID resume 성공; 마지막 turn은 `interrupted` | 중복 실행 없이 사용자에게 중단을 표시하고 다음 지시로 계속                           |
| crash 시 이미 보인 partial assistant delta | 복구된 마지막 turn에는 userMessage만 존재        | delta를 durable 완료 응답으로 약속하지 않음. Naru Run/event의 상태 복구와 구분       |

**K1 판정: 테스트한 텍스트 대화·MCP tool 이력은 app-server API만으로 재구성 가능하다.**
`thread/read(includeTurns=true)`와 `thread/resume`으로 복원했고 기본 `historyMode`는 `paginated`였다.
`thread/turns/list(limit=1, sortDirection="asc", itemsView="full")`의 cursor를 따라 두 페이지를
읽어 두 turn의 `userMessage`와 `agentMessage`를 복원했다. 별도 승인 실험에서는 재시작 뒤
`mcpToolCall`의 `arguments`, `status`, `result`, `error`, `durationMs` 등이 포함됐다.
rollout 파일을 직접 파싱하지 않았다.

전체 Chat을 첫 `thread/resume`의 제한된 turns만으로 그리면 안 된다. API pagination을 사용하고
cursor를 opaque하게 취급해야 한다. 미완료 delta·재생 중 승인 request·외부 이미지 파일·모든 tool
종류의 영속성을 일반화하지 않는다. Naru의 원본 Instruction, provenance, 승인 결정, Run 상태는
대화 transcript와 별개로 저장해야 한다. transcript 사본 DB가 반드시 필요하다는 근거는 발견하지
못했으나 crash 중 보인 모든 바이트까지 보존하는 제품 요구는 별도 결정이다.

## V04 — native subagent

실제 `gpt-6-sol` 부모에게 한 자식을 생성해 진행 메시지 → 짧은 sleep → 완료를 수행하게 했다.

| 수준           | 판정                                  | 설치 버전 증거                                                                                                                                                        |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 lifecycle   | PASS                                  | 부모 `item/started`·`item/completed`의 `subAgentActivity`, `kind=started/completed`, `agentThreadId`, `agentPath`; 자식 resume의 `parentThreadId`와 `source.subAgent` |
| L2 transcript  | PASS                                  | 자식 ID로 `thread/resume` 구독, `item/agentMessage/delta`, `commandExecution`, `turn/completed`; 자식 이력 API 조회                                                   |
| L3 interactive | FAIL (직접 API 경로)                  | `canAcceptDirectInput=false`; 실행 중 `turn/start`, 올바른 active turn ID의 `turn/steer` 모두 `-32600`                                                                |
| L4 PTY         | PARTIAL / controller capability false | 새 remote TUI는 자식 응답을 표시했지만 입력을 전송하지 않았음. 자식 소유 독립 PTY/controller attach 성공이 아님                                                       |

추가 synthetic native child를 실제 remote TUI로 resume해 응답을 표시했다. TUI에 직접 입력한 문장은
child `turn/start`로 전송되지 않았고 이력에도 없었다. API 직접 입력도 `-32600`이었다. 여기서 만든
PTY는 관찰자가 새로 띄운 TUI의 PTY이며 원래 native child의 독립 PTY를 발견한 것이 아니다.
또한 최초 activity 직후 resume가 `-32603`으로 실패한 경우가 있어 실제 child 실행 준비를 확인한 뒤
구독해야 한다.

부모에 자식 `thread/started`가 반드시 broadcast되는 것으로 가정하면 안 된다. 실제 발견 경로는
`subAgentActivity`였다. `thread/closed` 이벤트는 관측되지 않았으므로 종료 판단은 activity의
`completed`와 turn 상태로 해야 한다. 부모 native collaboration 메시징과 GUI의 자식 직접 입력은
별개의 기능이다. 부모를 통한 간접 개입을 L3 직접 입력 성공으로 계산하지 않았다.

`features list`는 `multi_agent` stable/true, `multi_agent_v2` stable/false,
`agent_message_board` under-development/false를 보였다. 실제 synthetic Responses의
`input[type=additional_tools]`에는 `collaboration.spawn_agent`, `send_message`, `followup_task`,
`interrupt_agent`, `list_agents`, `wait_agent`가 노출됐다.

**native 억제는 검증 실패다.** thread config의 `features.multi_agent=false`와
`features.multi_agent_v2=false`, 또는 `features.code_mode_host=false`를 조합해도 이 도구들이
남았고 synthetic model의 실제 spawn 호출로 자식이 생성됐다. `agents.max_threads=1`,
`agents.max_depth=1`에서도 한 자식 생성은 가능했다. 이 마지막 probe는 동시 자식 여러 개나 깊이 2의
한도 자체를 검증한 것이 아니므로 해당 한도가 전부 무시된다고 단정하지 않는다. 실제 모델의
도구 존재 응답도 AVAILABLE이었으나 모델 자기 보고만으로 판정하지 않았다.

Native는 **L2 관찰을 허용하는 작업**의 후보로 유지할 수 있다. 사용자가 자식에게 직접 개입하거나
독립 PTY가 필요한 작업은 Managed worker를 사용한다. 강제 native 차단이 필요한 모드에는 아직
검증된 차단 수단이 없으므로 단순 프롬프트를 보안 통제로 표현하지 않는다.

## V08 / K2 / K3 — Codex 통신과 MCP 주입

native `collaboration.list_agents`의 범위는 해당 root tree이며 tool schema의 send target은 agent
ID 또는 task path다. 서로 독립된 root thread의 UUID를 `collaboration.send_message`의 target으로
보내는 실제 synthetic 호출은 agent-not-found로 실패했고 수신 thread에 메시지가 없었다.
이 결과를 모든 개발 중 native messaging 기능의 부재 증명으로 확대하지 않는다. 공식적으로
검증된 독립 세션 handoff 경로는 이번 결과에 없다.

Managed probe는 같은 app-server의 두 실제 모델 thread가 `naru_stub.send_message`와 `inbox`를
사용했다. 두 turn 모두 completed였고 4개 MCP tool item을 관측했다. sender는 각각 process env에서
결정되고, Greek 문자와 literal newline escape를 포함한 synthetic 원문 및 original instruction ID가
왕복 후 일치했다. fake variant에서는 실제 newline도 보존됐다.

| 주입 범위                                                         | 결과                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 임시 CODEX_HOME의 `[mcp_servers.naru_stub]`                       | 승인/elicitation probe에서 로드·실행 성공                                                        |
| `thread/start.config["mcp_servers.naru_stub"]`의 command/args/env | 성공. 전역 설정 수정 없음                                                                        |
| thread A/B에 서로 다른 synthetic sender/token env                 | PID 및 token digest가 각각 달랐음                                                                |
| 동일 config와 token을 가진 thread C/D                             | PID는 달랐고 digest는 같았음; app-server 전체 단일 MCP process가 아님                            |
| 실행 중 MCP config 교체·외부 credential 갱신                      | NOT TESTED                                                                                       |
| `-c mcp_servers={}`로 기존 MCP 전체 제거                          | 제거 보장 안 됨. real 환경에서 다른 startup status도 나타남; empty map을 disable로 사용하지 않음 |

K2/K3에 필요한 세션별 env/process 주입은 가능하다. 다만 재시작 후 resume 때 secret 주입을 다시
구성하는 정책, capability 만료, mailbox ACL·감사·idempotency는 Naru 구현 과제다. JSON stub은 두
tool의 transport/provenance 재현용이며 production 데이터 저장소가 아니다. Claude 측 재사용용 tool
interface와 환경변수는 README에 있다. Codex↔Claude 실왕복은 이번 worker 범위에 포함되지 않는다.

## V11 — DurableSession bridge 설계 메모

기존 Host fixture 패턴으로 임시 data/socket/credential을 만들고 실제 NodePty runtime 안에서
`console.ts`를 실행했다. 이 process가 private UDS app-server를 소유하고 별도 RPC client로 lifecycle
event **이름만** console에 쓴다. GUI는 UDS로 직접 요청한다. PTY stdin은 console에서 소비되며
protocol에 전달되지 않는다.

- observer 입력은 `ATTACHMENT_NOT_CONTROLLER`, 이전 generation 입력은 `CONTROL_GENERATION_STALE`.
- request→approve→accept 인계 후 controller generation 2, authoritative geometry 90×25.
- disconnect→resume 뒤 controller 유지와 resume token 회전.
- JSON처럼 보이는 PTY 입력 후에도 임의 turn은 생기지 않고 GUI turn은 completed.
- snapshot에는 lifecycle event와 입력 무시 표시가 있으며 모델 응답 원문은 없음.
- 격리 Host close→같은 fixture 재기동 후 metadata는 stopped/runtimeId=null.
- 새 app-server에서 같은 Codex thread를 resume하고 마지막 GUI 입력을 읽음.

기존 relay에 GUI channel을 추가하면 실제 TUI를 계속 소유한 채 A 전환을 구현할 수 있다. headless
agent는 이 실험처럼 Host-owned process + UDS + redacted console로도 관찰 가능하다. console은
`OBSERVED_TRANSCRIPT`/event console로 표시해야 하며 실제 Codex TUI라고 부르지 않는다. 두 구조
모두 Host의 controller와 Codex conversation writer를 별도 소유권으로 관리해야 한다. PTY controller
인계만으로 JSON-RPC writer 권한이 이전되는 것은 아니다.

## X1 / X2

실제 TUI의 사용자 입력은 `turn/start`를 통과했다. params에는 `threadId`, `input`,
`clientUserMessageId` 및 model/effort/approval/sandbox/collaboration 등 선택적 override 필드가 있다.
text input item은 `{type:"text", text, text_elements}` 형태다. TUI가 내부 용도의 임시 structured
thread에도 `turn/start`를 보낼 수 있으므로 주 thread ID와 source를 구별해야 한다. Naru는 이
boundary에서 사용자 지시를 기록할 수 있지만 transport 재시도와 실제 turn ID를 연결하고,
관찰용 구조화 로그에 원문을 넣지 않아야 한다. typed-but-not-submitted 입력은 관측하지 않는다.

`model/list(includeHidden=false)` 결과는 아래와 같았다.

| model ID        | default | 이번 실제 turn 실행           |
| --------------- | ------- | ----------------------------- |
| `gpt-6.1-sol`   | true    | NOT TESTED                    |
| `gpt-6-astra`   | false   | NOT TESTED                    |
| `gpt-6-sol`     | false   | PASS, native child와 MCP 왕복 |
| `gpt-6-luna`    | false   | NOT TESTED                    |
| `gpt-5.6-sol`   | false   | NOT TESTED                    |
| `gpt-5.6-terra` | false   | NOT TESTED                    |
| `gpt-5.6-luna`  | false   | NOT TESTED                    |

기본 Pane의 모델 비지정 정책(D025)을 변경하지 않는다. 이 목록은 SOURCE_SPEC의 역할별 후보를
설정할 때의 catalog이며 성능·가격·권한 비교가 아니다.

## Capability Matrix 초안

```typescript
const codex01621 = {
  structuredChat: true,
  realTui: true,
  liveTuiAttach: true,
  safeGuiTuiTransition: true,
  nativeSubagentTrace: "transcript",
  nativeCrossSessionMessaging: false,
  externalApprovalControl: true,
  canBridgeToDurableSession: true,
} as const;
```

이 값들은 **이번 검증 조건을 충족하는 adapter 후보**의 capability다. `safeGuiTuiTransition`은
proxy gate + quiesce + resume 확인이 있을 때만 true다. `liveTuiAttach`는 공유 backend의 일반
부모 thread를 의미한다. `externalApprovalControl`은 재현한 MCP 승인/elicitation에 한정하며 모든
approval 종류의 완전한 지원을 의미하지 않는다. 자식은 L2, independent PTY와 직접 입력은 false다.

## 검증 gate와 integration에 남기는 일

변경 파일 prettier, 전체 lint/typecheck, staged index와 Git history를 대상으로 한 public scan을
실행한다. 실행 결과는 `docs/agent-platform-v0/assignments/codex-runtime/HANDOFF.yaml`에 기록한다.
제품 코드/공통 fixture/계약/`docs/TASKS.md`는 integration 소유로 유지했다.

남은 결정: A adapter의 실제 lease/fencing·reconcile, native L2/Managed 구분 UX, 강제 native 차단이
필수인 모드의 정책. 별도 [decision request](../assignments/codex-runtime/DECISION_REQUEST.yaml)에
native 억제의 범위를 기록했다. 이 worker는 기능 축소나 비공식 rollout 파싱을 도입하지 않았다.

## V01 method 분류 — 설치 생성물 전체

`collect.ts`의 experimental JSON Schema에는 client method **170개**, 생성 TS binding에는
**173개**가 있다. TS에만 있는 legacy `getAuthStatus`, `getConversationSummary`, `gitDiffToRemote`
세 개도 아래에 포함한다. 생성기 간 불일치를 숨기지 않고 `classify.ts`가 기록한다.

분류는 안전 정책 초안이며 각 method를 전부 실행했다는 뜻이 아니다. `read`도 해당 thread/OS
사용자의 인가가 필요하다. 특히 config·account·filesystem read를 browser에 무조건 공개하지 않는다.
proxy는 `proxy.ts`의 작은 allowlist만 허용하고 나머지를 기본 거부한다. `thread/resume`는 ID와
history paging만 지정하면 구독, config/model/cwd/history/path override를 동반하면 write로 취급한다.

| 분류                               | 설치 스키마 method (전체)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| privileged / settings / unverified | `account/bedrock/checkGovCloudRequirements`, `account/bedrock/discover`, `account/bedrock/setup`, `account/gatewayOAuth/cancel`, `account/gatewayOAuth/login`, `account/gatewayOAuth/read`, `account/login/cancel`, `account/login/start`, `account/logout`, `account/rateLimitResetCredit/consume`, `account/sendAddCreditsNudgeEmail`, `account/workspaceMessages/read`, `externalAgentConfig/detect`, `externalAgentConfig/import`, `externalAgentConfig/import/readHistories`, `externalAgentConfig/import/recordHistory`, `feedback/upload`, `getAuthStatus`, `marketplace/add`, `marketplace/remove`, `marketplace/upgrade`, `mcpServer/oauth/login`, `memory/reset`, `mock/experimentalMethod`, `plugin/install`, `plugin/reconcile`, `plugin/share/checkout`, `plugin/share/delete`, `plugin/share/save`, `plugin/share/updateTargets`, `plugin/uninstall`, `project/create`, `project/delete`, `project/import`, `project/move`, `project/update`, `remoteControl/client/list`, `remoteControl/client/revoke`, `remoteControl/disable`, `remoteControl/enable`, `remoteControl/pairing/start`, `remoteControl/pairing/status`, `remoteControl/status/read`, `rollout/compress`, `threadSection/create`, `threadSection/delete`, `threadSection/update`, `userVerification/cancel`, `userVerification/delete`, `userVerification/enroll`, `userVerification/status`, `userVerification/verify`, `windowsSandbox/readiness`, `windowsSandbox/setupStart` |
| read                               | `account/rateLimits/read`, `account/read`, `account/usage/read`, `app/installed`, `app/list`, `app/read`, `collaborationMode/list`, `config/read`, `configRequirements/read`, `environment/info`, `environment/status`, `experimentalFeature/list`, `fs/getMetadata`, `fs/readDirectory`, `fs/readFile`, `fuzzyFileSearch`, `getConversationSummary`, `gitDiffToRemote`, `hooks/list`, `mcpServerStatus/list`, `memory/status`, `model/list`, `modelProvider/capabilities/read`, `permissionProfile/list`, `plugin/installed`, `plugin/list`, `plugin/read`, `plugin/search`, `plugin/share/list`, `plugin/skill/read`, `project/list`, `project/read`, `server/diagnostics`, `skills/list`, `thread/attachment/list`, `thread/attachmentOwner/list`, `thread/backgroundTerminals/list`, `thread/goal/get`, `thread/items/list`, `thread/list`, `thread/loaded/list`, `thread/queue/list`, `thread/read`, `thread/realtime/listVoices`, `thread/search`, `thread/searchOccurrences`, `thread/timeline/list`, `thread/turns/list`, `threadSection/list`                                                                                                                                                                                                                                                                                                                                                                                                          |
| execution / external-effect        | `command/exec`, `command/exec/resize`, `command/exec/terminate`, `command/exec/write`, `fs/copy`, `fs/createDirectory`, `fs/remove`, `fs/writeFile`, `mcpServer/resource/read`, `mcpServer/tool/call`, `process/kill`, `process/resizePty`, `process/spawn`, `process/writeStdin`, `thread/backgroundTerminals/clean`, `thread/backgroundTerminals/terminate`, `thread/shellCommand`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| settings                           | `config/batchWrite`, `config/mcpServer/reload`, `config/value/write`, `environment/add`, `experimentalFeature/enablement/set`, `skills/config/write`, `skills/extraRoots/set`, `thread/memoryMode/set`, `thread/settings/update`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| subscription (params-sensitive)    | `fs/unwatch`, `fs/watch`, `fuzzyFileSearch/sessionStart`, `fuzzyFileSearch/sessionStop`, `fuzzyFileSearch/sessionUpdate`, `mcpServer/event/stream/start`, `mcpServer/event/stream/stop`, `thread/resume`, `thread/unsubscribe`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| handshake                          | `initialize`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| conversation-write                 | `review/start`, `thread/approveGuardianDeniedAction`, `thread/archive`, `thread/attachment/add`, `thread/attachment/remove`, `thread/compact/start`, `thread/decrement_elicitation`, `thread/delete`, `thread/fork`, `thread/goal/clear`, `thread/goal/set`, `thread/increment_elicitation`, `thread/inject_items`, `thread/metadata/update`, `thread/name/set`, `thread/prediction/request`, `thread/queue/add`, `thread/queue/delete`, `thread/queue/reorder`, `thread/queue/start`, `thread/queue/update`, `thread/realtime/appendAudio`, `thread/realtime/appendSpeech`, `thread/realtime/appendText`, `thread/realtime/start`, `thread/realtime/stop`, `thread/revert`, `thread/section/move`, `thread/start`, `thread/unarchive`, `turn/interrupt`, `turn/settings/update`, `turn/start`, `turn/steer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

server request 응답은 client method 분류와 별개다. JSON-RPC `{id,result}` 또는 `{id,error}`이므로
method 문자열만 검사해서는 writer gate를 구현할 수 없다.

| ServerRequest method                                                                                                                                        | 권한 분류·실행 범위                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `mcpServer/elicitation/request`                                                                                                                             | approval-response. tool 사용 승인과 form elicitation 둘 다 실제 검증               |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `applyPatchApproval`, `execCommandApproval` | approval-response. schema 확인, 개별 실행 NOT TESTED                               |
| `item/tool/requestUserInput`, `item/tool/call`                                                                                                              | interactive/tool response. pending ID와 thread 범위 필요, 개별 실행 NOT TESTED     |
| `account/chatgptAuthTokens/refresh`, `attestation/generate`                                                                                                 | runtime/credential response. 일반 conversation writer에 공개 금지, 실행 NOT TESTED |
| `currentTime/read`                                                                                                                                          | runtime response. 일반 승인과 구별, 실행 NOT TESTED                                |

gate는 writer·generation·pending request ID·resolved 상태를 함께 추적하고 중복 응답을 제거해야 한다.
`initialized`는 handshake notification이며 일반 mutating method와 구분한다.
