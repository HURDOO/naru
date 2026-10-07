# DurableSession v0 기술 아키텍처

> 상태: **구현된 public v0 아키텍처**
>
> 제품 계약: `SPEC.md`
>
> 교차 topology: `../workstation-v0/ARCHITECTURE.md`
>
> 유지 상태 원장: `../workstation-v0/TASKS.md`

## 1. 설계 원칙

1. PTY와 canonical terminal state의 owner는 Naru나 Gateway가 아니라 per-user
   DurableSession Host다.
2. Core domain은 Fastify, WebSocket, SQLite row, Naru Pane과 Codex를 import하지 않는다.
3. protocol identity와 optimistic fencing을 모든 transport보다 먼저 정의한다.
4. browser identity, app authorization과 Host capability를 서로 다른 경계로 유지한다.
5. transcript가 아닌 bounded current state와 bounded event stream만 보존한다.
6. process persistence가 없는 실패를 숨기지 않고 runtime incarnation으로 구분한다.
7. public schema와 state transition을 먼저 고정한 뒤 compatibility adapter로 Naru를 옮긴다.

## 2. 목표 dependency topology

```text
packages/contracts
  durable-session/v0 schemas + DTOs
              |
              v
packages/domain
  pure lifecycle/control/capability reducers and policies
              |
              +-------------------------+
              |                         |
              v                         v
apps/durable-session-host       packages/durable-session-client
  private UDS + PTY + state       transport-neutral typed client
              ^                         |
              |                         v
              |                    apps/cli
              |
              +--- registered app adapters
                         |
                  apps/server (Naru)
```

허용 dependency는 contracts → pure domain → Host/adapters/client 방향이다. Host는 Gateway cookie,
passkey, Naru Pane과 Codex를 모르고, client는 Naru Web module을 import하지 않는다. repository의
기존 `packages/contracts/src/index.ts`와 root package 설정은 integration owner가 순차적으로
namespace/export를 연결한다.

## 3. 물리적 module 목표

```text
packages/contracts/src/durable-session/v0/**
packages/domain/src/durable-session/**
packages/durable-session-client/**
apps/durable-session-host/**
apps/cli/**

apps/server/src/durable-session/**       # Naru compatibility/application adapter
apps/server/src/integrations/codex/**    # Naru-owned optional semantic integration
```

파일명은 구현 중 조정할 수 있지만 위 import와 ownership 경계는 decision 변경 없이 뒤집지 않는다.
`packages/contracts`, root manifest/tsconfig/workspace와 `pnpm-lock.yaml`은 공용 충돌 지점이므로
worker가 동시에 수정하지 않고 integration owner만 갱신한다.

## 4. Core domain model

### 4.1 aggregate

`Session` aggregate는 최소 다음 값을 가진다.

- immutable `sessionId`, creation metadata와 bounded redacted command reference
- lifecycle, `sessionRevision`, optional current `runtimeId`
- authoritative terminal `{ cols, rows }`
- current `controllerAttachmentId | null`, `controllerGeneration`
- runtime-scoped next `sequence`
- pending control requests와 최대 하나의 active offer
- registered attachments와 bounded queue/resync state
- optional redacted integration activity

`Runtime`과 `Attachment`는 `Session`의 identity를 공유하지 않는다. 새 process는 같은 Session 안에서
새 runtime을 만들며, 새 attach는 valid grace resume이 아니면 새 attachment를 만든다.

### 4.2 pure transition API

pure reducer는 현재 aggregate, command, monotonic clock/input identity를 받아 새 state와 effect
목록을 반환한다. effect 예시는 `spawn`, `kill`, `resizePty`, `writePty`, `persistMetadata`,
`emitEvent`, `closeAttachment`다. reducer가 process, socket, DB나 timer를 직접 호출하지 않는다.

각 mutating command는 필요한 조건을 명시한다.

- lifecycle: expected `sessionRevision`와 필요 시 expected `runtimeId`
- control: expected `controllerGeneration`, attachment identity와 capability
- input/resize: current runtime, generation, controller attachment
- resume: single-use token binding, app/subject와 expiry

condition failure는 stable stale/denied error이며 부분 effect를 만들지 않는다.

## 5. Host 내부 경계

```text
private UDS transport
        |
authorization + schema boundary
        |
SessionService orchestration
   |         |           |            |
domain    RuntimePort  TerminalPort  MetadataRepository
reducer      |            |              |
           node-pty    emulator/ring   SQLite/private state
        |
attachment fan-out + timer/liveness coordinator
```

### 5.1 transport와 caller context

- Host는 per-user private UDS를 기본 endpoint로 사용한다.
- handshake는 registered app credential을 검증하고 app ID, subject, capability, scope, expiry로
  immutable caller context를 만든다.
- schema parse 전후에 frame, string, array와 rate limit을 적용한다.
- 한 connection이 여러 Session attachment를 multiplex할 수 있으며 `attachmentId`로 분기한다.
- transport close는 Session stop이 아니라 attachment grace 시작이다.

Host lifecycle seam은 private UDS 위의 HTTP/1.1로 다음처럼 encode한다.

- socket parent는 owner-only `0700`, socket은 owner-only `0600`이며 TCP listener를 만들지 않는다.
- `GET /healthz`는 process/protocol 생존, `GET /readyz`는 metadata와 operation 수락 가능 상태를
  transport envelope version 1로 반환한다. private UDS 안의 두 probe에는 app credential을 요구하지
  않는다.
- `POST /v0/operations`는 `Authorization: Bearer <registered-app-credential>`과
  `X-Durable-Session-App-Id`를 받고, body는 strict `{ callerContext, request }` envelope다. 인증된
  operation 결과는 public protocol v0 response 그대로 HTTP 200에 싣고, endpoint/body/concurrency처럼
  public request ID를 확정할 수 없는 transport 실패만 HTTP 4xx/5xx transport envelope로 반환한다.
- body bytes, header 수, 동시 request 수, caller TTL과 idempotency TTL/count를 Host config 상한으로
  제한한다. 지원되지 않는 operation은 `REQUEST_INVALID`로 fail-closed하며 lifecycle과 multiplex stream,
  attachment handshake는 같은 app/credential 경계를 사용한다.

### 5.2 SessionService

SessionService는 public operation을 domain command로 바꾸고 effect를 순서대로 적용한다. public
응답을 보내기 전에 state revision/generation을 확정하며, idempotency key 결과는 bounded TTL로
보존한다. input은 일반 operation처럼 재시도하지 않고 bounded `inputId` dedupe만 제공한다.

### 5.3 RuntimePort와 PTY ownership

Host만 PTY를 spawn/kill/write/resize하고 child exit를 관측한다. callback은 spawn 때 캡처한
`runtimeId`를 포함하며 current runtime과 다르면 폐기한다. normal exit, explicit stop, spawn
failure, terminal-state/resource 처리 failure와 Host-lost runtime을 서로 다른 redacted reason으로
기록한다. PTY callback은 bounded pending-output queue로 합쳐 처리하며 Host가 canonical state를
유지할 수 없는 overflow는 bytes를 버리고 계속 실행한 척하지 않고 해당 runtime만 `failed`로 끝낸다.

PTY output은 다음 순서로 처리한다.

1. current `runtimeId` 확인
2. monotonic `sequence` 부여
3. terminal emulator/current-state ring 갱신
4. attachment별 bounded queue enqueue
5. queue 한도를 넘은 attachment만 resync-required로 전환

attachment가 0개여도 1~3은 계속 수행한다.

### 5.3.1 generic integration bootstrap

`CommandSpecV0.integration`은 Host가 integration implementation을 실행하는 plugin slot이 아니다.
Host config의 allowlist policy가 authenticated app, integration kind, profile과 descriptor config key를
검증하고, spawn 직전에 현재 Session/runtime에 한정된 bootstrap capability를 만든다.

```text
authenticated app credential
        |
        | domain-separated key derivation (memory-only)
        v
Host policy + Session/runtime/profile/rooted cwd + redacted descriptor
        |
        | bounded versioned signed bootstrap in reserved environment key
        v
app-owned launcher / integration producer
```

Host는 bootstrap payload나 derived key를 metadata/event journal/log에 기록하지 않는다. 일반 env
policy가 reserved key를 상속하거나 덮는 것도 시작 시 거부한다. launcher와 producer는 app process가
소유하고 bootstrap signature뿐 아니라 app DB의 현재 Session/runtime binding까지 다시 확인한다.
따라서 Host/Core dependency graph에는 Codex 같은 integration-specific import가 없고, 이전 runtime의
정상 서명 payload도 current mapping과 다르면 stale로 폐기된다.

Host의 public `terminal.exited`와 attachment stream은 exit code/signal만 전달하는 generic 계약이다.
Codex thread identity·resume 가능성·session clear는 reference app인 Naru가 자기 integration event와
application WebSocket으로 투영하며 Host event나 public client/CLI contract에 역주입하지 않는다.

HTTP operation과 multiplexed WebSocket operation은 모두 app registry가 만든 동일한 authenticated
binding을 사용한다. request/stream용 key copy는 사용 또는 연결 종료 때 zeroize하고 Session copy는
forget·Host shutdown까지 메모리에만 둔다. integrated profile은 Host metadata에서 descriptor를
제거한 `runtime-only`이므로 같은 Host 생존 중 start는 새 runtime capability를 만들 수 있지만 Host
restart 뒤 복구된 Session은 inspect/forget만 허용한다.

### 5.4 terminal snapshot barrier

snapshot은 emulator state, canonical cols/rows, runtime ID와 포함된 마지막 sequence `N`을 원자적으로
읽는다. attach 중 들어오는 bytes는 barrier 뒤 buffer에 두고 snapshot 전달 완료 후 `N+1`부터
flush한다. 동일 sequence를 snapshot과 live 양쪽에 적용하거나 건너뛰지 않는다. client가 cursor를
확인하지 못하거나 bounded queue를 넘으면 incremental recovery를 추측하지 않고 full resync를
요구한다.

serialize addon이 보존하지 않는 mouse encoding(DEC 1006/1016)은 emulator의 public parser hook에서
상수 크기의 상태로 추적하고 같은 write barrier 안에서 snapshot 끝에 현재 encoding reset/enable
sequence로 포함한다. 전체·축소 snapshot 모두 최종 serialized state 문자 수 제한을 적용한다. tracking
mode는 기존 serializer가 보존한다. Naru standalone PTY의 staged/full snapshot도 동일하게 복원한다.
이 byte는 기존 `serializedState` 문자열 내부에만 들어가므로 public frame schema와 sequence 계약은
바뀌지 않으며 기존 client도 표준 escape sequence로 복원한다(D018, D019).

### 5.5 metadata repository

SQLite에는 다음 redacted metadata만 저장한다.

- Session identity, lifecycle, revision과 last runtime summary
- canonical terminal size와 profile/root reference
- timestamps, exit/stop/failure reason code
- bounded integration summary가 필요할 경우 그 versioned redacted 값

metadata는 Host restart 뒤 command를 안전하게 다시 resolve할 수 있는지 나타내는 internal
restartability도 가진다. profile Session은 profile/root/cwd/terminal reference만 저장하고 startup
뒤 현재 Host policy로 다시 resolve한다. arbitrary-exec argv와 raw integration config는 저장하지
않으므로 recovered arbitrary-exec Session은 inspect/forget만 가능하고 start는
`COMMAND_POLICY_DENIED`로 끝난다.

terminal input/output, scrollback, resume token, raw command secret/env, app credential은 저장하지
않는다. startup recovery는 persisted `running|creating|stopping`을 같은 `sessionId`의 `stopped`로
전환하고 새 revision을 기록한다. 이전 runtime의 화면이나 process를 복원했다고 표시하지 않는다.
이미 terminal lifecycle인 metadata도 memory-only 화면과 연결되지 않은 과거 sequence를 다시
노출하지 않으며 reload 시 `nextSequence`를 0으로 둔다. last runtime의 redacted 종료 요약은 유지한다.

DB migration은 `apps/server`의 기존 migration과 별도 Host DB에 적용한다. Naru Pane → Session
mapping migration처럼 기존 Naru DB를 건드리는 변경은 Naru integration owner가 순차 수행한다.

## 6. attachment와 control algorithm

### 6.1 attachment state

```text
opening -> observing <-----------------------------+
              |                                    |
              +-> controlling -> grace -> resumed-+
              |         |            |
              |         |            +-> expired -> closed
              |         +-> observing (release/transfer/preempt)
              +-> closed
```

role은 capability와 분리한다. observer role인 owner가 preempt capability를 보유할 수 있지만,
명시적 operation을 성공시키기 전에는 input·resize를 할 수 없다.

### 6.2 일반 transfer transaction

1. requester가 current generation으로 request를 만들고 expiry를 얻는다.
2. current controller가 같은 generation의 request를 approve/reject한다.
3. approve는 requester 전용 short-lived offer 하나를 만든다.
4. requester가 같은 generation과 새 terminal size로 accept한다.
5. Core가 이전 generation을 무효화하고 generation을 1 증가시킨다.
6. 이전 controller를 observer, requester를 controller로 바꾸고 PTY를 한 번 resize한다.
7. 같은 old generation의 request/offer를 resolve하고 `control.changed`를 broadcast한다.

request, approval 또는 offer만으로 role을 바꾸지 않는다. requester disappearance/expiry는 current
controller를 유지한다.

### 6.3 preempt와 stale fencing

`control:preempt`가 있고 명시적 owner action을 받은 caller만 preempt한다. Core는 generation
increment를 role/resize/write보다 먼저 확정한다. 이후 도착한 old generation input, resize,
heartbeat와 accept는 `CONTROL_GENERATION_STALE`로 거부한다. stop/start race에는 runtime/revision
검사를 함께 적용해 old runtime callback이 새 runtime을 오염시키지 않게 한다.

### 6.4 liveness와 resume token store

resume token store는 Host memory에만 있고 token digest/binding/expiry/consumed state를 가진다.
발행 원문은 한 번 client에 전달하고 성공한 resume transaction에서 기존 token을 원자 소비한 뒤
새 token으로 회전한다. invalid·expired·reused·wrong binding 요청은 stable reject로 끝난다. 기본
timer는 reconnect grace 10초, heartbeat 15초, stale 35초다. monotonic clock과 fake clock으로
expiry/race를 테스트한다. disconnect만으로 새 controller를 자동 선정하지 않는다.

## 7. public protocol encoding

계약 source of truth는 versioned runtime schema다. DTO는 `version`, request/event ID, operation별
expected identity를 명시하고 unknown discriminant와 초과 payload를 거부한다. wire adapter는
다음을 공통으로 지킨다.

- request/response correlation과 stable error envelope
- application event와 terminal binary frame의 명확한 구분
- raw output을 bounded event journal에 복사하지 않음
- sensitive field redaction test와 structured-log allowlist
- backpressure 한도와 per-attachment resync
- connection identity를 handshake 뒤 고정하고 중간 header/cookie로 바꾸지 않음

TypeScript client는 transport interface를 주입받아 UDS와 Naru/Web adapter가 같은 operation 의미를
사용하게 한다. protocol version mismatch는 fail-closed하며 조용한 downgrade를 하지 않는다.

## 8. Naru compatibility 경계

Naru adapter는 Naru `Pane`과 DurableSession `sessionId` mapping을 소유한다. Pane create/close/restart를
Core lifecycle operation으로 바꾸고 Core event를 Naru layout/activity로 번역한다. Core는 Pane,
Workspace, Project와 global Naru surface를 알지 않는다.

migration 동안 기존 `apps/server/src/pty.ts`, `lease.ts`, `transport.ts`, `sessions.ts` 주변에 façade가
있을 수 있지만 최종 v0에서 다음은 Host로 이동한다.

- PTY spawn/kill/write/resize
- runtime and sequence truth
- emulator/current terminal state
- attachments, control generation, liveness와 resync

Naru App Server에는 app authorization, Pane mapping, compatibility route와 Codex semantic adapter가
남는다. 이 파일들과 Naru DB migration은 하나의 application integration owner가 순차 변경한다.

## 9. 오류, shutdown과 recovery

- normal Host shutdown은 새 operation을 거부하고 metadata를 flush한 뒤 child를 정리해 `stopped`를
  기록한다. v0는 daemon crash 뒤 orphan process 재획득을 주장하지 않는다.
- invariant failure는 affected Session을 `failed`로 전환하고 secret/terminal bytes 없는 error와
  diagnostic ID만 남긴다.
- Naru/Gateway connection loss는 Host lifecycle effect를 만들지 않는다.
- registered app credential revocation은 해당 connection/attachment를 닫지만 Session stop 권한과
  동일시하지 않는다.
- corrupt metadata나 unsupported schema는 process를 임의 spawn하지 않고 readiness를 fail-closed로
  만든다.

## 10. 검증 구조

| 층               | 검증                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| pure domain      | state/model-based tests, race permutation, stale identity, fake clock expiry            |
| contracts        | strict parse, version/unknown variant, size bounds, stable error fixtures               |
| Host integration | actual `node-pty`, rapid output barrier, alternate screen, zero attachment, slow client |
| security         | capability matrix, UDS/file mode, realpath/symlink, command/env, redaction              |
| restart          | Naru/Gateway restart continuity, Host restart honest stopped recovery                   |
| clients          | TS client and JSON CLI contract tests, generic TUI restore/control                      |
| reference app    | two browser observer/takeover, desktop/tablet/360px, keyboard/focus/resize              |

property/model tests가 pass해도 실제 PTY와 실제 browser acceptance를 대체하지 않는다. 실제 Codex
PTY 인수 서버는 repository `AGENTS.md` 규칙대로 sandbox 밖 실행 승인을 받은 isolated runtime에서만
시작한다.

## 11. 구현·merge 경계

- Public schema, namespace와 pure reducer contract를 implementation보다 먼저 고정한다.
- Host owner는 `apps/durable-session-host/**`와 DurableSession 전용 domain 내부만 수정한다.
- client owner는 `packages/durable-session-client/**`, `apps/cli/**`만 수정한다.
- Naru UI worker는 characterization 또는 `apps/web/**`의 합의된 UI 범위만 수정한다.
- integration owner만 root package/tsconfig/workspace, lockfile, contracts index, `apps/server`, DB
  migration과 공식 docs/task status를 수정한다.
- worker가 공용 export/dependency가 필요하면 직접 수정하지 않고 작은 integration manifest와
  검증 명령을 제출한다.
- 각 wave는 contract test와 integration gate가 통과한 뒤 다음 wave에 merge한다. 활성 작업과 owner는
  해당 program TASKS를 따른다.
