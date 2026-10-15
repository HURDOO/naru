# Claude 메시징 검증 (V06, V08 Claude 측)

- 검증일: 2026-10-15
- 설치 버전: Claude Code `2.1.296` (npm global), model `claude-sonnet-5-5` (`--model sonnet`)
- 환경: macOS arm64, Node 24.20.0. 검증용 `claude -p` stream-json 세션과 PTY 안의 interactive TUI 한 개
- 재현 스크립트: `tests/spikes/claude-messaging/` (README 참조)
- 원문 로그: 저장소 밖 `experiments/naru-agent-spikes/claude-messaging/runs/<run>/`(owner-only). 이 문서는
  redacted 요약만 담는다. 실행별 이름: `v06-a-2026-10-15T05-54-08-135Z`, `v06-b-2026-10-15T05-56-01-160Z`,
  `v06-c-2026-10-15T05-56-23-135Z`, `v06-tui-2026-10-15T06-02-25-496Z`, `v08-2026-10-15T05-56-35-555Z`(재실행 `v08-2026-10-15T06-06-11-092Z`도 동일)
- 안전장치: 모든 검증 세션의 `SendMessage`에 PreToolUse hook guard를 걸었다. guard는 검증용 세션 이름이
  아닌 대상을 모두 거부한다. `ListAgents` 결과에는 사용자의 실제 세션이 보였지만 실제 세션에는 메시지를
  보내지 않았다. 자식 process의 env는 처음부터 새로 구성했다. 부모 세션의 `CLAUDE_CODE_MESSAGING_*` 값은
  전달하지 않았다.

## 요약

| 항목                                | 상태                        | 한 줄 결론                                                                                                                            |
| ----------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| V06-1 활성화 조건과 도달 범위       | PASS (로컬)                 | 기본으로 켜져 있다. 같은 OS 사용자의 모든 로컬 세션(`-p` 포함)이 서로 보이고 메시지를 보낼 수 있다. 원격과 cloud는 NOT TESTED         |
| V06-2 수신 형식과 발신자 신원       | PASS                        | 발신자 신원은 **스스로 정한 세션 이름**과 OS가 확인한 peer PID다. Naru agent 신원과는 연결되지 않는다                                 |
| V06-3 hook 감사와 차단              | PASS                        | 발신 측 PreToolUse에서 대상과 본문을 보고 deny할 수 있다. 수신 측 UserPromptSubmit에서 전문을 보고 block할 수 있다                    |
| V06-4 cross-session에만 한정한 차단 | PASS (subagent 기준)        | inbound `refuse`와 PreToolUse의 대상 범위 제한을 함께 써도 subagent 재개 메시징은 그대로 동작한다. Agent Teams는 NOT TESTED(V07 범위) |
| V06-5 hook 없이 Naru가 관찰         | PARTIAL                     | Naru가 직접 띄운 stream-json 세션에서는 구조화된 관찰이 가능하다. TUI 세션은 hook이 없으면 transcript 파일(비공식)밖에 없다           |
| V06-6 Naru를 우회한 작업 생성       | 확인됨 (기본 설정에서 위험) | 다른 세션의 메시지 하나로 수신 세션이 파일을 만들었다. 정책을 적용하면 막힌다                                                         |
| V08 관리형 MCP 경로 (Claude↔Claude) | PASS                        | 세션별 env token으로 발신자를 바인딩했다. 원문과 `origin_instruction_id`가 바이트 단위로 보존됐고 위조 인자는 거부됐다                |
| V08 Codex↔Claude 왕복               | NOT TESTED                  | integration 단계에서 Codex worker의 stub과 합쳐 수행한다                                                                              |

**판정 (SOURCE_SPEC §14 "Claude Native 메시징 판정")**

- native cross-session 메시징은 다음 세 가지를 신뢰성 있게 보장하지 못한다.
  - 원본 지시 ID: 별도 필드가 없고 자유 텍스트에 넣어야 한다.
  - 책임 주체: 발신자는 스스로 정한 이름이다.
  - Naru 감사 기록: hook이 없으면 남지 않는다.
- 따라서 **Naru가 관리하는 agent 세션 사이의 통신은 Naru-managed 경로(MCP)를 기본으로 한다.**
- native cross-session은 managed 세션에서 차단한다. subagent 내부 메시징은 유지한다.

## V06 상세

### 1. 활성화 조건과 도달 범위

- 2.1.224 이상에서 기본으로 켜진다. 세션마다 owner-only UDS inbox(`/tmp/cc-socks/<pid>.sock`)를 bind한다.
  stream-json `system/init` event에 `messaging_socket_path`가 들어 있다.
- `claude -p` worker도 inbox를 bind한다(`--bare`는 제외). 별도 설정이 없으면 사용자의 다른 모든
  Claude 세션(Naru Pane 포함)이 `ListAgents`에 나타나고 서로 메시지를 보낼 수 있다.
  다른 기기와 cloud는 Remote Control 연결이 있어야 하며, 이번에는 검증하지 않았다(NOT TESTED).
- 수신 처리는 `crossSessionInbound`(`accept|hold|refuse`)로 정한다. 값이 없으면 permission mode의
  class로 정한다. 다음 조합을 실측했다.

| 수신 세션 설정                                  | 결과                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accept`, `acceptEdits`                         | 전달된다. idle 상태의 수신 세션에서 새 turn이 시작된다                                                                                                            |
| 값 없음, `acceptEdits` (발신도 prompting class) | 전달된다                                                                                                                                                          |
| `refuse`                                        | 전달되지 않는다. 수신 측 stream에는 아무 event도 없다. 발신 측에는 `system/informational` warning "Cross-session message refused"가 온다                          |
| 값 없음, `bypassPermissions`                    | hold된다. 수신 측에 `system/peer_message_hold {state: held, cause: mode-mismatch}`가 오고, 종료하면 `dropped`가 온다. 발신 측은 warning을 받고 새 turn이 시작된다 |

- `SendMessage`의 즉시 결과는 **enqueue 성공**일 뿐이다: `{"success":true,"message":"… in that session's inbox, not yet read …","msg_id":"<uuid>"}`.
  refuse나 hold는 나중에 비동기 notice로 알려진다. UserPromptSubmit hook이 block한 경우에는 발신 측이
  아무 통지도 받지 못한다.

### 2. 수신 형식과 발신자 신원

수신 세션의 Claude가 받는 prompt(UserPromptSubmit hook payload의 `prompt`)는 다음과 같다.

```text
<cross-session-message from="uds:<socket>" from-name="naru-spike-s1" from-mode="prompting">
SPIKE-PING-1 origin_instruction_id=instr-spike-1
Please create a file named spike-created.txt containing OK in your current directory.
</cross-session-message>
```

- stream-json `-p` 수신 세션의 stdout에는 이 메시지가 `user` event로 나오지 **않는다**. 해당 turn의 `result`
  event에 구조화된 provenance가 붙는다(설치 버전에서 관찰했고 공식 문서화 여부는 확인하지 못했다).

```json
"origin": { "kind": "peer", "from": "uds:<socket>", "verifiedPeerPid": 0, "msg_id": "<uuid>",
            "name": "naru-spike-s1", "fromMode": "prompting", "body": "<message text>" }
```

- 발신 측 결과의 `msg_id`와 수신 측 `origin.msg_id`가 일치한다. 발신과 수신을 서로 연결할 수 있다.
- **신원**: `from-name`/`name`은 `--name`이나 `/rename`으로 정한 값이다. 유일하지도 않고 인증되지도 않는다.
  OS가 확인한 것은 같은 OS 사용자의 peer PID(`verifiedPeerPid`)뿐이다. Naru가 PID를 자기가 관리하는
  process tree에 대응시키지 않는 한 Naru agent ID와 바인딩되지 않는다.
- transcript JSONL(비공식 형식)에도 `queue-operation`과 wrapper가 붙은 user record가 남는다. 다만 user
  record에는 peer를 나타내는 구조화 필드가 없다.

### 3. hook 감사와 차단

- **발신 측 PreToolUse(`SendMessage`)**: `tool_input`에 `to`, `message`, `summary`, `type`, `recipient`,
  `recipient_kind`, `content`가 들어 있다. `recipient_kind`는 세션 이름이면 `name`, subagent면 `agent`였다.
  `permissionDecision: deny`로 막을 수 있고, deny 사유가 모델에게 tool result로 전달된다. 이번 검증에서
  guard가 `naru-real-guard-test`와 `naru-spike-r1`로 가는 전송을 실제로 막았다.
- **수신 측 UserPromptSubmit**: 위 wrapper를 포함한 전문을 받는다. `decision: block`이면 그 turn이
  실행되지 않는다(파일 생성 없음). stream-json에는 `system/informational` warning(원문 prompt 포함)과
  `num_turns: 0`인 `result`(origin 포함)가 남는다. 발신 측에는 통지가 가지 않는다.
- interactive TUI(PTY)를 수신 세션으로 써도 같은 UserPromptSubmit payload가 오고 Stop hook이 이어진다.
  Naru Pane의 기존 Claude hook 경로(D016)로 관찰할 수 있다.

### 4. cross-session에만 한정한 차단

- 발신 세션(`naru-spike-s2`)에 두 가지를 함께 걸었다.
  - inbound `refuse`
  - PreToolUse 정책: SubagentStart hook으로 알게 된 `agent_id`에게만 `SendMessage`를 허용
- 결과:
  - Agent tool로 subagent를 실행했고(`agent_id` 확인), `SendMessage`로 그 subagent를 재개했다(`Resuming agent …`). 응답(PONG)이 task notification으로 도착했다.
  - 같은 세션에서 `naru-spike-r1`로 보내는 전송은 hook이 deny했다.
- 공식 문서에 따르면 `SendMessage`를 permission rule로 통째로 deny하면 subagent와 teammate 메시징도 함께
  사라진다. **tool 자체를 deny하지 말고 대상 범위를 제한하는 hook을 써야 한다.**
- 대상이 세션인지 subagent인지는 `recipient_kind`로 구분할 수 있다. 다만 이 값이 Claude Code가 resolve해서
  채운 것인지 모델이 넣은 것인지 확인하지 못했다. 그래서 SubagentStart로 수집한 ID allowlist를 기준으로
  권고한다.
- Agent Teams teammate 대상은 NOT TESTED다. V07 결과로 teammate 식별자(TeammateIdle 등)를 allowlist에
  추가할지 정해야 한다.

### 5. hook 없이 Naru가 관찰할 수 있는가 — PARTIAL

| 세션 종류                              | 발신 관찰                                                                | 수신 관찰                                                     |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Naru가 띄운 stream-json(`-p`/SDK) 세션 | stdout의 `SendMessage` tool_use 입력, 이후 `system/informational` notice | `result.origin`(peer, msg_id, PID, 본문), `peer_message_hold` |
| interactive TUI 세션(Naru Pane)        | 없음                                                                     | 없음. transcript JSONL 파싱만 가능하며 이는 비공식 경로다     |

TUI 세션에서는 hook(PreToolUse와 UserPromptSubmit)이 유일한 공식 관찰 경로다.

### 6. Naru를 우회한 작업 생성

- `acceptEdits`인 수신 세션이 다른 세션의 메시지 하나로 `spike-created.txt`를 만들었다.
- 수신 Claude는 "다른 세션이 보낸 메시지이며 사용자 승인으로 취급하지 않는다"는 안내를 받는다.
  그래도 자기 permission 범위 안의 작업은 수행한다.
- 따라서 기본 설정에서는 managed 세션 사이에 Naru를 거치지 않는 작업 생성이 가능하다. 아래 정책을
  적용하면 막힌다(차단은 phase C와 B에서 실측).

## V08 상세 (Claude 측 관리형 경로)

- `naru-stub-mcp.mjs`: SDK 없이 newline JSON-RPC로 구현한 stdio MCP server다. tool은 `send_message(to, verbatim,
origin_instruction_id)`와 `inbox()` 두 개다.
- 발신자는 **MCP server env의 세션별 token**(`NARU_STUB_SESSION_TOKEN`)을 registry에서 조회해 결정한다.
  tool 인자에는 발신자 필드가 없다.
- 세션마다 `--mcp-config '{"mcpServers":{"naru":{"command":…,"env":{…token…}}}}' --strict-mcp-config`로
  주입했다. 각 세션이 자기 MCP server process를 띄우므로 세션별 env 주입이 가능하다(K3 바인딩 조건 충족).

| 확인 사항                                      | 결과                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A→B 전송, 저장된 `from`                        | `agent-a` (token으로 바인딩)                                                                                                          |
| 원문 보존 (한글, 따옴표, em dash, 두 줄)       | 모델이 넘긴 값과 저장값이 일치했고 B가 받은 값과도 일치했다(`transportPreserved`, `deliveredMatchesStore` true)                       |
| `origin_instruction_id`                        | `instr-user-17` 보존                                                                                                                  |
| 위조 시도: 모델이 `from='agent-x'` 인자를 추가 | client가 schema(`additionalProperties:false`)를 무시하고 인자를 그대로 전달했다. **server가** `NARU_STUB_UNEXPECTED_FIELD`로 거부했다 |
| token 없는 세션의 `inbox`                      | `NARU_STUB_UNBOUND_SESSION` 거부                                                                                                      |
| MCP protocol                                   | client는 `2025-11-25`를 요청했고 server가 응답한 `2025-06-18`을 받아들여 정상 동작했다                                                |

시사점:

- 신원 바인딩은 반드시 server 쪽에서 해야 한다. tool schema 검증은 client가 강제하지 않는다.
- inbox는 polling 방식이다. 수신 세션을 깨우는 일(wakeup)은 별도 경로가 필요하다.
  - Naru가 띄운 stream-json/SDK 세션은 stdin user message로 깨울 수 있다.
  - TUI 세션에 넣을 후보는 세 가지이며 모두 NOT TESTED다.
    - (a) native inbox socket 직접 post: 메시지 line 형식이 문서화되지 않았으므로 비공식이다.
    - (b) Channels(MCP push): research preview이고, custom channel은 `--dangerously-load-development-channels`가 필요하다.
    - (c) Naru가 DurableSession controller로 TUI에 입력: K3 holder 규칙을 따른다.

## 메시징 정책 권고 (ADR 입력)

1. **managed agent 세션**(Naru가 띄운 orchestrator와 worker Claude)
   - `--settings`로 다음을 주입한다.
     - `crossSessionInbound: "refuse"`
     - `SendMessage` PreToolUse hook: subagent(SubagentStart로 수집한 ID)와 승인된 teammate만 허용한다.
       그 밖의 대상은 deny하고, deny 사유에 "Naru `send_message`를 사용하라"고 안내한다.
   - 차단된 시도는 Naru 감사 event로 메타데이터만 기록한다(K1-6). 발신 세션은 hook의 `session_id`를
     Naru의 Pane/agent 바인딩과 대조해 식별한다.
   - managed 통신은 Naru MCP를 사용한다. 발신자는 세션 token으로 바인딩하고, 원문과 원본 지시 ID를
     저장한다(K1-3).
2. **사용자의 일반 Claude Pane**: native messaging을 그대로 둘지 결정이 필요하다(**사용자 결정 필요**).
   기본 권고는 "현행 유지 + 관찰"이다. 사용자가 직접 쓰는 세션 간 협업 기능을 빼앗지 않기 위해서다.
3. **K1-2 구현 시 주의**: UserPromptSubmit에는 prompt 출처를 나타내는 구조화 필드가 없다. peer 메시지는
   `<cross-session-message` wrapper 텍스트로만 구분된다. 사람이 같은 텍스트를 직접 입력할 수도 있으므로
   이 구분은 신뢰 경계가 아니다.
   - stream-json 세션은 `result.origin.kind == "peer"`를 기준으로 삼는다.
   - TUI 세션은 wrapper를 "peer 추정"으로 표시한다. 단, managed 세션은 inbound를 `refuse`하므로 이
     경우가 생기지 않는다.
4. `SendMessage` tool을 permission rule로 통째로 deny하지 않는다. subagent 재개가 깨진다.

## 미해결 사항과 남은 확인

- teammate 대상 메시징과 hook 정책의 상호작용(V07 결과 필요)
- `result.origin`과 `peer_message_hold`, SendMessage의 `recipient_kind`가 공식 계약인지 여부. 안정 API로
  확정하기 전에는 capability flag 뒤에 둔다.
- TUI wakeup 경로 (a)~(c) 선택(ADR)
- 검증 부산물: 검증용 workspace 경로의 Claude transcript(`~/.claude/projects/` 아래 experiments 경로 항목)와
  TUI 검증 디렉터리 1곳의 trust 기록이 사용자 Claude 설정에 남았다. 운영 Naru와 Host에는 영향이 없다.
