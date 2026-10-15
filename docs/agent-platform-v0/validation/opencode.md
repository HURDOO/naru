# V12 OpenCode/OmO 검증 결과

- 일시: 2026-10-15, macOS arm64, Node 24.20.0
- 대상: OpenCode `1.18.35`(`~/.opencode/bin/opencode`), 사용자 설정 plugin `oh-my-openagent@5.1.28`
- 모델: real model `openai/gpt-5.6-luna-fast` (OmO 기본 primary agent `Hephaestus - Deep Agent`가 처리)
- 격리: spike server A, B를 각각 `127.0.0.1` 임의 port와 임의 password로 직접 띄웠다. scratch git repo
  두 개를 썼고 원문 로그는 저장소 밖 owner-only 디렉터리에 두었다. 운영 OmO server, Gateway adapter,
  LaunchAgent, `~/.config/opencode`는 변경하거나 재시작하지 않았다. server B의 plugin과 MCP는
  `OPENCODE_CONFIG_CONTENT`로만 주입했다.
- 재현: `tests/spikes/opencode/README.md`. 판정은 설치 버전에서 재현한 동작만 근거로 한다.

## 요약

| #   | 항목                                      | 상태               | 핵심 근거                                                                                                                                    |
| --- | ----------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `serve` HTTP API와 SSE                    | PASS               | session 생성, `prompt_async`, `/event` SSE(`message.*`, `session.status` busy/idle, `session.idle`), `GET /session/:id/message` 이력         |
| 2   | permission 요청·응답                      | PASS               | 세션 생성 시 permission ruleset(`bash: ask`), `permission.asked` → `POST /permission/:id/reply` → `permission.replied`. 두 번째 응답은 404   |
| 3   | abort/interrupt                           | PASS               | 실행 중인 bash tool에서 `POST /session/:id/abort` 뒤 약 100ms 안에 idle, assistant에 `MessageAbortedError`, 남는 child process 없음          |
| 4   | `opencode attach` TUI live attach         | PASS               | 이력 replay, API가 보낸 turn을 TUI가 256~485ms 안에 렌더, TUI가 보낸 turn을 API의 SSE와 이력이 수신                                          |
| 5   | 동시 write 중재                           | FAIL (native 없음) | busy 중 API와 TUI의 prompt가 모두 수락되어 진행 중인 loop에 합쳐진다. 앞선 prompt의 개별 응답이 사라진다. Naru가 write gate를 둬야 한다      |
| 6   | OmO child trace L1, L2, L3                | PASS               | `session.created`(parentID), `/session/:id/children`, child `message.part.*` live 스트림, child 개별 abort, child 직접 prompt                |
| 6'  | child L4 (PTY)                            | FAIL (해당 없음)   | child는 독립 process나 PTY가 없다(server 내부 실행). TUI attach는 읽기 전용 "Subagent" 보기                                                  |
| 6'' | child 이력 지속성                         | FAIL               | OmO가 완료된 subagent 세션을 10분 뒤 삭제한다(아래 §3). 나중에 이력을 읽을 수 없다                                                           |
| 7   | plugin과 hook 가시성·통제                 | PASS (주의사항)    | `event`, `chat.message`(API·TUI 입력 모두), `tool.execute.before/after`(throw로 거부), `shell.env`, `permission.ask`. hook 순서는 OmO가 먼저 |
| 8   | 세션별 identity·env 주입                  | PARTIAL            | plugin tool의 `ToolContext.sessionID`와 `shell.env`는 세션별로 PASS. MCP는 directory instance 단위 process이고 `_meta`에 세션 정보가 없다    |
| 9   | 공식 API만으로 이력 재구성                | PARTIAL            | top-level 세션은 server 재시작 뒤에도 tool input/output까지 전체 재구성 가능. child는 삭제되고, crash 뒤에는 `running` part가 영구히 남는다  |
| 10  | server crash 중 실행 상태                 | 관찰               | `kill -9` 뒤 bash tool의 child process가 orphan으로 생존. 재시작 뒤 status는 idle이지만 assistant 미완료와 tool `running`이 남음             |
| 11  | OmO team(`team_*`) 메시징                 | NOT TESTED         | tool은 존재한다. tool hook으로 audit/deny할 수 있는 surface만 확인했다(OmO 자체 참가자 검사가 먼저 실행)                                     |
| 12  | DurableSession 아래에서 server와 TUI 실행 | NOT TESTED         | 구조상 일반 PTY process다. 격리 Host 검증은 하지 않았다                                                                                      |

## 1. Server API와 이벤트

- 공식 OpenAPI(`GET /doc`, basic auth 필요)에는 v1 경로(`/session`, `/event`, `/permission` 등)와
  `/api/*` v2 경로가 함께 있다. 이벤트 schema는 94종이다.
- 같은 SSE에서 기본 흐름이 확인됐다:
  `session.created → message.updated → message.part.updated/delta → session.status(busy) → session.idle`.
  OmO 설치 환경에서는 `tui.toast.show`와 `plugin.added`도 섞여 온다.
- 이력: `GET /session/:id/message`가 role, agent, model, error와 part를 반환한다. part는 text,
  reasoning, `tool`(state: input, output, status, time, title, metadata), step, patch다. Chat GUI를 다시
  구성하는 데 필요한 정보가 공식 API에 모두 있다.
- v2 `POST /api/session/:id/prompt`(`delivery: queue|steer`)는 별도 durable event log
  (`/api/session/:id/history`, aggregate seq)에 `session.next.prompt.admitted/prompted`로 기록된다.
  하지만 90초 이상 지나도 실행되지 않았고, v1 메시지 목록에도 나타나지 않았다. 이 버전에서는 사용할 수
  없는 실험 경로로 판단한다.

## 2. TUI live attach와 writer 중재 (V01 대응)

- `opencode attach <url> --session <id>`(password는 `OPENCODE_SERVER_PASSWORD` env)를 node-pty와
  headless xterm으로 실행했다.
  - 이력 replay: PASS
  - API가 시작한 turn을 TUI가 live로 렌더: PASS (256ms, 485ms)
  - TUI에서 제출한 turn: API SSE가 같은 세션의 `message.*`와`session.idle`을 받고 이력에도 남는다
- **결론: 공유 backend(A안)는 OpenCode에서 native다.** server가 backend이고 TUI와 API가 모두 client다.
- **writer 중재는 없다.** 세션이 bash `sleep 20` turn으로 busy인 동안 다음을 보냈다.
  - API v1 `prompt_async` → 수락
  - TUI 입력 → 수락
  - API v2 queue, steer → 수락(실행되지 않음, §1)

  결과는 다음과 같다.
  - 진행 중이던 turn: tool 실행 뒤 `finish=tool-calls`로 끝났고 최종 응답이 없었다.
  - 그다음 API prompt: 응답이 없었다.
  - 마지막 TUI prompt: 응답했다.

  user 메시지는 모두 이력에 남았지만 모델은 마지막 것에만 답했다. 동시 write는 오류 없이 합쳐진다.
  따라서 GUI와 TUI 동시 연결에서 single writer를 보장하려면 Naru가 write 경로를 gate해야 한다.
  TUI도 HTTP client이므로 Naru proxy 뒤에 두면 gate할 수 있지만, 이 gate 자체는 검증하지 않았다.

- 같은 permission 요청에 두 client가 응답하면 첫 응답만 적용되고 두 번째는 404다. 결정적이다.

## 3. OmO subagent와background child trace (V12 핵심)

| 수준                 | 결과                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 lifecycle         | `task` tool(sync, background 모두)이 child를 만들면 `session.created`가 오고 `info.parentID`가 parent와 일치한다(prompt 뒤 2.2~3.0초). `GET /session/:id/children`도 일치한다. API로 `parentID`를 지정해 child 세션을 직접 만들 수도 있다                                                                                                 |
| L2 transcript        | child의 `message.part.updated/delta`, `session.status`, `session.idle`, `session.error`가 같은 `/event` 스트림에 실시간으로 온다                                                                                                                                                                                                          |
| L3 interactive       | child 개별 `abort`가 약 100ms에 반영되고 parent는 idle로 남는다. 완료된 child 세션에 `prompt_async`로 직접 보낸 메시지에 child가 응답한다                                                                                                                                                                                                 |
| L4 PTY               | 해당 없음. child는 server process 안의 세션이다. `opencode attach --session <child>`는 이력과 live API turn을 렌더하지만 "Subagent (n of m) / Parent·Prev·Next" 보기에서 입력 상자가 없다(TUI 입력 turn이 idle에 도달하지 않음)                                                                                                           |
| background 완료 알림 | OmO가 parent 세션에 **role=user 메시지**(`<system-reminder>[BACKGROUND TASK COMPLETED]…`)를 주입하고 parent가 사용자 입력 없이 새 turn(`background_output`)을 실행한다. part에 `synthetic` 같은 표시가 없어 구조로는 사람 입력과 구분할 수 없다                                                                                           |
| 지속성               | **OmO가 완료된 subagent 세션을 삭제한다.** OmO 5.1.28 dist의 `scheduleSyncSessionDeletion`(sync, 기본 10분)과 background manager(`taskCleanupDelayMs`, 기본 10분, 설정 최소 60초)가 `session.delete`를 호출한다. 실측으로 server A의 child 4개가 완료 수 분 뒤 `NotFound`가 되었고, server log에 삭제 경로(`removing share`) 4건이 있었다 |

## 4. Plugin, hook, identity

server B에 `naru-observer-plugin.mjs`와 `naru-stub-mcp.mjs`를 `OPENCODE_CONFIG_CONTENT`로 주입했다.
전역 설정과 merge되어 OmO plugin은 유지됐다.

- `event`: 모든 bus 이벤트(child `session.created` parentID 포함). PASS
- `chat.message`: API 입력, **TUI 입력**(attach한 TUI에서 제출한 prompt), OmO 주입 메시지 모두에서
  sessionID와 함께 발생한다. 출처 client 정보는 없다. OmO 주입은 text의 `<system-reminder>` 접두사로만
  추정할 수 있다.
- `tool.execute.before`: tool 이름과 sessionID를 받는다. throw하면 tool이 `error`가 되고 메시지
  (`NARU_POLICY_DENIED: webfetch`)가 모델에 전달된다. PASS
  - 주의: plugin은 순서대로 실행된다. `team_send_message`는 OmO의 참가자 검사가 먼저 거부해서 Naru
    hook이 호출되지 않았다. 설정으로 주입한 plugin은 OmO 뒤에 놓인다.
- `shell.env`: bash 호출마다 세션별 env를 주입한다(`NARU_SPIKE_SESSION=<sessionID>` 출력 확인). PASS
- plugin tool(`naru_whoami`): `ToolContext.sessionID`, `agent`가 server에서 제공된다. 호출 세션과
  일치한다. PASS. 모델이 주장하는 값이 아니라 server가 바인딩한 identity다.
- stdio MCP: `naru_stub_whoami` 호출은 성공했다. 하지만 `_meta`에는 `progressToken`만 있고 세션 정보가
  없다. MCP process는 directory instance마다 하나다. runtime `POST /mcp`로 추가한 server는 같은
  directory에서만 보이고 다른 directory에서는 보이지 않는다. **MCP만으로는 호출 세션을 식별할 수
  없다.**
- 세션별 permission ruleset(`POST /session`의 `permission`): PASS

## 5. Crash와 복구 관찰 (INV-07)

- bash `sleep 90` 실행 중에 spike server를 `kill -9`했다.
  - tool의 child process가 orphan으로 계속 살아 있었다. spike가 직접 종료했다.
  - 재시작한 server는 해당 세션을 busy로 보고하지 않았다(`/session/status` 비어 있음).
  - 하지만 이력에는 미완료 assistant(`time.completed` 없음)와 tool `running`이 그대로 남았다.
  - 같은 세션에 새 prompt를 보내면 정상 응답한다.
- Naru reconcile 규칙 후보: "status가 idle인데 미완료 assistant나 running part가 남아 있으면
  `interrupted`로 분류한다. 성공이나 실패를 지어내지 않는다."
- 정상 abort(`/abort`)에서는 orphan이 없었다.

## 6. Capability Matrix 초안 (OpenCode 1.18.35 + OmO 5.1.28)

SOURCE_SPEC §7.3 필드 기준이다. 검증하지 못한 값은 보수적으로 둔다.

| 필드                          | 값              | 근거와 조건                                                              |
| ----------------------------- | --------------- | ------------------------------------------------------------------------ |
| `structuredChat`              | `true`          | §1 HTTP API, SSE, 이력                                                   |
| `realTui`                     | `true`          | 공식 `opencode attach` TUI                                               |
| `liveTuiAttach`               | `true`          | §2. 실행 중인 server 세션에 attach하고 live로 렌더                       |
| `safeGuiTuiTransition`        | `false`         | native writer 중재 없음(§2). Naru write gate를 구현·검증한 뒤에만 `true` |
| `nativeSubagentTrace`         | `"interactive"` | L1~L3 PASS, L4 없음. 단 child는 OmO가 10분 뒤 삭제한다                   |
| `nativeCrossSessionMessaging` | `false`         | OmO team 메시징과 completion 주입은 존재하지만 추적·통제를 검증하지 않음 |
| `externalApprovalControl`     | `true`          | permission ask/reply API, 세션별 ruleset, 첫 응답 우선                   |
| `canBridgeToDurableSession`   | `false`         | DS 아래 실행은 NOT TESTED(§12). 구조상 가능해 보임                       |

## 7. 기존 Gateway adapter와의 관계 권고

- 현재 `apps/opencode-gateway`(`/omo/`)는 **사용자가 공식 OpenCode UI를 직접 쓰는 경로**다.
  Gateway assertion을 검증하고 localhost OpenCode에 basic auth로 HTTP, SSE, WS를 중계한다. 이 경로와
  운영 server는 그대로 둔다(WV0-D013/D015 불변).
- Naru 관리형 OpenCode 에이전트에는 **별도 Naru-launched `opencode serve`**를 권고한다. 가능하면
  agent·project별로 하나씩 두고, DurableSession 세션에서 실행해 console을 관찰할 수 있게 한다. 이유:
  - plugin(`OPENCODE_CONFIG_CONTENT`)으로 identity tool, policy hook, `shell.env`를 사용자 전역 설정을
    바꾸지 않고 주입할 수 있다.
  - process lifecycle, reconcile, PID 정리를 Naru가 소유한다.
  - 운영 `/omo/` server의 재시작이나 설정 변경 없이 독립적으로 운영할 수 있다.
- 주의: 모든 server가 같은 OpenCode data dir(SQLite)를 공유한다. Naru가 만든 세션은 같은 project의
  `/omo/` UI 목록에도 보인다. 이 상태가 허용 가능한지, 아니면 data dir을 분리할지는 결정이 필요하다.
  data dir을 분리하면 provider credential 위치도 함께 바뀌므로 복사 금지 원칙과 충돌할 수 있다.
- TUI가 필요하면 Naru Pane(DS PTY)에서 `opencode attach`를 Naru proxy URL로 실행하고, proxy에서
  writer gate를 강제한다(Phase 3에서 검증).
- identity 바인딩은 MCP가 아니라 **Naru plugin tool**(`ToolContext.sessionID`)을 1차로 쓴다.
  MCP를 쓴다면 OpenCode server와 MCP를 agent별로 분리하는 경우에만 세션 식별이 성립한다.

## 8. Phase 3 어댑터 구현 권고 수준

**"선택 어댑터, 구현 가치 높음"**으로 권고한다. API, 이벤트, permission, abort, child trace,
plugin 확장점이 공식 경로로 충분하다. 다만 다음 네 가지를 선행 조건으로 둔다.

1. Naru write gate(proxy)로 GUI와 TUI의 single writer를 보장한다.
2. OmO child 세션 삭제에 대한 정책을 정한다(아래 결정 후보).
3. plugin hook 순서상 OmO가 먼저 실행되는 상황에서 policy 강제를 어떻게 보장할지 정한다.
4. crash 뒤 `interrupted` 분류 reconcile을 구현한다.

## 9. 미지원·fallback 정리

- native writer 중재 없음 → Naru proxy gate. 검증 전에는 GUI와 TUI 중 한 경로만 write 허용으로 운용한다.
- child L4 PTY 없음 → 실시간 관찰은 L2 이벤트로 하고, 개입은 API(abort, 직접 prompt)로 한다.
  "PTY attach"라고 표시하지 않는다.
- child 이력이 10분 뒤 삭제됨 → 아래 결정 전까지 child는 "live 관찰 전용, 사후 이력 보장 없음"으로 표시한다.
- MCP 세션 식별 불가 → plugin tool이나 `shell.env` token을 쓴다.
- v2 queue/steer API 미실행 → 사용하지 않는다.

## 10. root 결정 후보

1. **OmO child 이력 삭제 vs K1-7.** 선택지:
   - (a) child는 live 관찰만 하고 lifecycle과 ID만 기록한다(이력 손실을 허용).
   - (b) background만 `taskCleanupDelayMs`를 늘린다(sync는 설정 불가로 보임, 미검증).
   - (c) child 완료 시점에 Naru가 export한다. transcript 저장이므로 K1-7 예외 결정이 필요하다.
   - (d) Naru-managed child를 사용한다(OmO `task` 대신 Naru `spawn_managed_agent`).
2. **사람 입력과 주입 메시지 구분.** runtime 이력의 user 메시지는 출처를 알 수 없다. K1-2(관리형 세션의
   TUI 입력 기록)는 plugin `chat.message`나 proxy 계층에서 기록해야 한다. 구분은 휴리스틱이다.
   proxy 기록이 더 정확하다.
3. **공유 data dir.** Naru-launched server의 세션이 `/omo/` UI에 보이는 것을 허용할지 정한다.

## 증거 (저장소 밖 owner-only 로그 디렉터리의 파일명)

- `openapi.json`(설치 server의 `/doc`), `server-*.log`, `server-b-*.log`
- `v12-api.jsonl`, `v12-attach.jsonl`, `v12-children.jsonl`, `v12-identity.jsonl`(HTTP, SSE 원문)
- `attach-1-replay.txt`, `attach-2-api-turn.txt`, `attach-3-tui-turn.txt`, `attach-4-overlap.txt`,
  `attach-existing-*.txt`(TUI 화면)
- `plugin.jsonl`(hook 메타데이터, 원문 없음), `mcp.jsonl`(MCP `_meta` key)
- OmO cleanup 근거: `~/.cache/opencode/packages/oh-my-openagent@5.1.28/.../dist/index.js`의
  `TASK_CLEANUP_DELAY_MS`, `scheduleSyncSessionDeletion`, `taskCleanupDelayMs`
