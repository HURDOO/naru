# Codex 0.162.1 runtime spikes

설치된 CLI의 동작을 조사하는 실행 스크립트다. 제품 코드·의존성·전역 설정을 변경하지 않는다.
판정과 제한은 [검증 보고서](../../../docs/agent-platform-v0/validation/codex-runtime.md)에 있다.

## 전제와 실행

- 저장소 root에서 실행한다. Node **24.20.0**, pnpm **11.12.0**, Codex **0.162.1**에서 검증했다.
- 기존 `pnpm` 의존성이 필요하다. 별도 install/update는 하지 않는다.
- `../../experiments/naru-agent-spikes/codex-runtime/workspace/`는 저장소 밖 scratch Git repo다.
- `../../experiments/naru-agent-spikes/codex-runtime/logs/`는 owner-only 디렉터리다.
  각 실행의 원문·오류·화면·PID·요약은 timestamp 하위 디렉터리에만 저장한다.
- `collect.ts`는 임시 HOME을 사용한다. fake 스크립트는 각 실행의 임시 HOME/CODEX_HOME과
  loopback synthetic Responses 서버를 사용한다. real 스크립트는 기존 기본 인증을 사용하고
  `[naru-spike]`로 시작하는 영속 thread를 남긴다. 인증 파일은 복사하지 않는다.
- npm Codex launcher는 native process를 자식으로 띄운다. crash 검증은 이 자식을 직접 소유해야
  하므로 macOS arm64 설치에서 native executable을 찾아 실행한다. 다른 설치에서는
  `NARU_SPIKE_CODEX`에 native executable 경로를 지정한다.
- node-pty `spawn-helper`의 owner 실행 비트가 빠진 설치에서는 이 worktree의 helper만 복구한다.
  설치된 CLI나 공유 runtime은 수정하지 않는다.

처음 실행할 때 scratch 저장소를 준비한다:

```sh
umask 077
mkdir -p ../../experiments/naru-agent-spikes/codex-runtime/workspace
git -C ../../experiments/naru-agent-spikes/codex-runtime/workspace init
```

Node 24가 PATH에 있을 때:

```sh
node --import tsx tests/spikes/codex-runtime/collect.ts
node --import tsx tests/spikes/codex-runtime/classify.ts
node --import tsx tests/spikes/codex-runtime/shared.ts
node --import tsx tests/spikes/codex-runtime/approval.ts
node --import tsx tests/spikes/codex-runtime/resume.ts
node --import tsx tests/spikes/codex-runtime/inventory.ts
node --import tsx tests/spikes/codex-runtime/child-tui.ts
node --import tsx tests/spikes/codex-runtime/messaging.ts
node --import tsx tests/spikes/codex-runtime/durable.ts
```

기존 Node 24 launcher도 사용할 수 있다:

```sh
node ops/workstation/dev/run-node24.mjs --import tsx tests/spikes/codex-runtime/shared.ts
```

실제 모델 사용은 명시적인 gate가 필요하다. 이번 assignment에는 사용 승인이 포함돼 있다.

```sh
NARU_SPIKE_REAL_MODEL=1 node --import tsx tests/spikes/codex-runtime/subagents.ts
NARU_SPIKE_REAL_MODEL=1 node --import tsx tests/spikes/codex-runtime/messaging.ts --real
```

| 스크립트                       | 범위                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `collect.ts`, `classify.ts`    | 설치 버전·feature·JSON schema·TS binding과 method 분류                                               |
| `shared.ts`                    | V01, X1: 실제 remote TUI, 화면에 live delta 표시, writer gate, 완료/interrupt 전환, native 동시 입력 |
| `approval.ts`                  | V01, K1: MCP 승인·elicitation broadcast, 중복 응답, gate, 재시작 뒤 MCP 이력                         |
| `resume.ts`                    | V02, K1: 서로 다른 app-server 간 GUI/TUI 전환, API pagination, TUI kill·app-server crash             |
| `subagents.ts`, `child-tui.ts` | V04, X2: 실제 native 자식의 L1/L2/L3와 model catalog                                                 |
| `inventory.ts`                 | V04/V08: 합성 모델의 실제 spawn 호출, 설정 억제 여부, 독립 root 메시징 거부                          |
| `messaging.ts`                 | V08, K2/K3: thread별 MCP env/process, 원문·provenance 왕복                                           |
| `durable.ts`, `console.ts`     | V11: 격리 Host PTY, 별도 protocol/console, control·reconnect·restart                                 |

`summary.json`의 관측값을 보고서와 비교한다. 실패한 probe는 `failure.txt`와 비영(非零) 종료 코드를
남긴다. false가 예상되는 capability도 있으므로 **종료 코드 0이 모든 capability의 PASS를 뜻하지
않는다**. 생성 스키마 자체도 public API 안정성의 보장은 아니다.

## MCP stub 재사용

`naru-stub.ts`는 newline-delimited JSON-RPC를 사용하는 stdio MCP server다. 의존성 추가 없이
Node 24 + 기존 tsx로 실행한다. `initialize`, `tools/list`, `tools/call`을 제공한다.

```text
send_message(to: string, verbatim: string, origin_instruction_id: string)
inbox()
```

`send_message`는 `{id, sender, to, verbatim, origin_instruction_id}`를 그대로 저장·반환한다.
`sender`는 tool 인수가 아닌 process의 `NARU_STUB_SENDER`에서 결정한다. `inbox`는 그 sender에게
온 메시지들을 반환하며 읽어도 삭제하지 않는다. 문자열을 요약하거나 줄바꿈·Unicode를 정규화하지 않는다.
반환값은 MCP `content[0].text`에 JSON으로 들어 있다.

| 환경변수             | 의미                                                            |
| -------------------- | --------------------------------------------------------------- |
| `NARU_STUB_MAILBOX`  | 임시 JSON mailbox의 절대 경로. 서로 통신하는 process가 공유     |
| `NARU_STUB_SENDER`   | 이 process의 synthetic agent identity                           |
| `NARU_STUB_TOKEN`    | env 격리 확인용 임의 fixture 값. SHA-256만 diagnostic에 반환    |
| `NARU_STUB_ELICIT=1` | 승인 검증용. 실제 저장 대신 synthetic `elicitation/create` 발행 |

thread 시작 때 `config["mcp_servers.naru_stub"]`에
`{command, args, env: {NARU_STUB_MAILBOX, NARU_STUB_SENDER, NARU_STUB_TOKEN}}`를 전달한다.
`messaging.ts`에 실행 가능한 예제가 있다. app-server 시작 시 `-c mcp_servers.naru_stub.command=...`,
`-c mcp_servers.naru_stub.args=...`, `-c mcp_servers.naru_stub.env.KEY=...` 또는 격리
`config.toml`의 `[mcp_servers.naru_stub]`를 사용할 수 있다. `approval.ts`는 config.toml 경로를
실제로 검증한다. CLI dotted override의 임의 조합 전체를 검증했다는 뜻은 아니다.

MCP process는 thread마다 별도로 생성됐다. 같은 설정·token 값의 두 thread도 PID가 달랐다.
이는 **사용자 계정·OS 보안 격리**를 의미하지 않는다. stub의 sender와 token은 재현용이며 production
인증·권한·idempotency·감사 저장소 구현이 아니다. 같은 OS 사용자가 mailbox를 수정할 수 있다.

## 종료와 보존

정상/실패 종료의 `finally`에서 직접 생성한 TUI, app-server, fixture Host, loopback server만 닫는다.
app-server 종료가 지연되면 직접 소유한 ChildProcess에만 SIGKILL을 사용한다. TUI kill과 app-server
crash는 `resume.ts`의 명시적인 실패 주입이다. 전역 daemon 명령·이름 기반 kill·service restart는 없다.

원문과 임시 root는 삭제하지 않는다. `owned-pids.jsonl`은 이번 실행이 소유한 process와 고유 socket을
기록한다. 외부에서 script를 강제 중단했다면 PID 재사용 여부와 해당 fixture socket/cwd를 확인한 뒤
그 process만 회수해야 한다. `naru-stub.ts`의 lock directory 제거는 메시지 저장 동기화의 일부다.

기본 `pnpm test`가 이 파일들을 수집하지 않도록 `.test.ts` 이름을 쓰지 않는다.
