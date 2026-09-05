# DurableSession v0 제품·프로토콜 명세

> 상태: **구현된 public v0 계약**
>
> 유지 상태 원장: `../workstation-v0/TASKS.md`

## 1. 문서 책임과 변경 규칙

이 문서는 Naru와 독립적인 DurableSession Core, per-user Host, 공개 protocol, TypeScript client와
Session CLI의 제품 계약이다. 구현 구조는 `ARCHITECTURE.md`, 교차 제품 결정은
`../workstation-v0/DECISIONS.md`, 전체 v0 진행 상태는 `../workstation-v0/TASKS.md`를 따른다.

Root `docs/SPEC.md`는 Naru application 계약이고 이 문서는 generic Session runtime 계약이다. Naru
adapter처럼 두 경계에 걸친 변경은 두 SPEC을 모두 만족해야 하며 상태는 해당 program TASKS 한 곳에만
기록한다. Public contract를 바꾸면 versioning과 consumer migration을 먼저 결정하고 관련 SPEC,
ARCHITECTURE, DECISIONS와 TASKS를 같은 변경에서 갱신한다.

## 2. 제품 정의

DurableSession v0은 한 OS 사용자의 interactive process를 별도 Host가 소유하고, Host가 살아 있는
동안 여러 client와 agent가 같은 terminal state를 관찰하되 정확히 한 controller만 입력과 PTY
geometry를 바꾸게 하는 self-hosted Session runtime이다.

핵심 보장은 다음과 같다.

> Host가 살아 있는 동안 interactive process와 canonical terminal state는 browser, app server,
> network path보다 오래 산다. control 이동은 generation으로 fence하고 snapshot과 live output은
> 하나의 ordered stream으로 이어진다.

### 2.1 v0 목표

- generic full-screen TUI와 Codex를 같은 공개 Session 계약으로 실행한다.
- client detach, reload, crash와 일시 network 단절이 process를 종료하지 않게 한다.
- observer 0개 이상과 controller 최대 1개를 Session별로 지원한다.
- Naru App Server와 Workstation Gateway restart 동안 Host의 PTY와 terminal state를 유지한다.
- lifecycle, attachment, control, terminal과 bounded event read를 transport-neutral API로 제공한다.
- Naru private module을 import하지 않는 TypeScript client와 JSON CLI를 제공한다.
- restart 뒤 process persistence를 제공하지 않는 상태를 정직하게 표현한다.

### 2.2 v0 비목표

- Host restart, macOS logout, reboot 또는 power loss 뒤 동일 OS process 복원
- terminal transcript의 영구 저장·검색 또는 agent external memory
- 여러 authoritative PTY geometry나 observer별 Host-side terminal reflow
- multi-user account, Project/Session ACL, RBAC, collaboration과 audit log
- MCP server, external integration registry, out-of-process integration runner
- same-UID 악성 process를 막는 sandbox 또는 적대적 agent 격리
- Linux/systemd, Raspberry Pi, 독립 repository와 독립 release cadence

## 3. 내구성 계약

| 사건                             | v0 결과                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| tab reload·close, client crash   | attachment만 사라지고 process는 계속 실행된다.                                                             |
| 일시 network 단절                | 같은 runtime에 재attach하고 snapshot/live ordering을 복원한다.                                             |
| 승인된 takeover                  | process는 유지하고 controller generation만 바뀐다. 이전 generation의 input·resize·accept는 거부한다.       |
| 화면 회전·keyboard·viewport 변화 | process를 재시작하지 않으며 controller만 authoritative PTY size를 바꿀 수 있다.                            |
| 크기가 다른 observer             | canonical grid를 바꾸지 않고 client-side fit/crop/pan/scroll로 표시한다.                                   |
| slow attachment                  | 해당 attachment의 bounded queue만 끊고 `RESYNC_REQUIRED`를 요구한다.                                       |
| Naru App Server restart          | Web/API는 잠시 unavailable이지만 Host process와 terminal state는 유지한다.                                 |
| Gateway restart                  | remote managed app은 unavailable이지만 Host process와 local CLI는 유지한다.                                |
| DurableSession Host restart      | 저장된 metadata를 같은 `sessionId`의 정직한 `stopped` 상태로 복구하고 process/화면 복원을 주장하지 않는다. |
| macOS logout·reboot·power loss   | 동일 process 복원을 보장하지 않는다.                                                                       |
| Codex thread resume              | optional semantic recovery이며 process persistence로 표현하지 않는다.                                      |

용어는 `live continuity`, `service recovery`, `semantic recovery`, `process persistence`로 분리한다.
v0가 보장하는 것은 앞의 두 범주 중 Host 생존 중 continuity와 Host restart 뒤 metadata recovery다.

## 4. identity, lifecycle과 보존

| identity                | 계약                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `sessionId`             | Pane·client와 독립인 opaque UUID. metadata가 존재하는 동안 runtime을 바꿔도 유지한다. |
| `runtimeId`             | 실제 process incarnation UUID. 명시적 start마다 새로 만든다.                          |
| `sessionRevision`       | lifecycle·metadata optimistic concurrency용 단조 증가 revision이다.                   |
| `controllerGeneration`  | controller 변경을 fence하는 Session별 단조 증가 값이다.                               |
| `sequence`              | 한 `runtimeId` 안의 terminal output 순서이며 새 runtime은 0부터 시작한다.             |
| `attachmentId`          | caller가 한 Session을 보는 논리 attachment다. 유효한 grace resume에서만 유지한다.     |
| `attachmentResumeToken` | 끊어진 attachment lease를 증명하는 Host 발행 high-entropy opaque secret이다.          |

Session lifecycle은 다음 상태만 사용한다.

```text
creating -> running -> exited
    |          |
    |          +-> stopping -> stopped
    +-> failed

stopped | exited | failed -> creating  (명시적 start, 새 runtimeId)
```

- `exited`는 자연 종료이며 exit code 또는 signal을 가진다.
- `stopped`는 사용자 stop, 정상 Host shutdown, Host restart 때 발견한 사라진 runtime을 redacted
  reason으로 구분한다.
- `failed`는 spawn 실패 또는 Core invariant 실패다.
- observer/controller/detached/suspended는 attachment/control 상태이지 lifecycle이 아니다.
- agent의 idle/running/interaction-required 같은 의미 상태는 optional integration activity다.
- raw terminal state와 scrollback은 기본적으로 memory-only다.
- Session metadata는 자동 삭제하지 않는다. `forgetSession`만 삭제하며 전체 Session 수 상한을
  강제한다. Naru Pane 삭제는 연결된 Session을 stop한 뒤 forget한다.
- Host가 살아 있는 동안 terminal Session은 memory-only command로 다시 시작할 수 있다. Host restart
  뒤에는 persisted safe profile/root/cwd/terminal reference로 다시 resolve할 수 있는 profile
  Session만 재시작 가능하다. raw argv나 integration config가 필요한 arbitrary-exec Session은 stopped
  metadata로 조회·forget할 수 있지만 `startSession`을 `COMMAND_POLICY_DENIED`로 거부한다.

## 5. Session 생성과 Host policy

`CommandSpecV0`는 allowlisted profile과 structured exec를 분리한다.

```ts
type CommandSpecV0 =
  | {
      kind: "profile";
      profileId: string;
      cwd: { rootId: string; relativePath: string };
      terminal: { cols: number; rows: number; term?: string };
      integration?: { kind: string; config?: unknown };
    }
  | {
      kind: "exec";
      executable: string;
      args: string[];
      cwd: { rootId: string; relativePath: string };
      terminal: { cols: number; rows: number; term?: string };
      envPolicyId: string;
      resourcePolicyId: string;
      integration?: { kind: string; config?: unknown };
    };
```

- Naru Web은 allowlisted profile만 사용한다.
- structured exec는 `session:create:arbitrary`가 있는 local owner 경로에만 연다.
- public create는 shell command string, `sh -c` interpolation, arbitrary env map을 받지 않는다.
- `cwd`는 configured root와 relative path로 표현하며 매 요청에서 `realpath` 후 경계 내부인지 다시
  검사한다. `..`, prefix 혼동과 symlink escape는 거부한다.
- child env는 bounded Host policy가 만들고 integration secret은 inline 값이 아니라 Host-owned
  reference/policy로 전달한다.
- `integration` descriptor가 있는 command는 Host-owned integration policy가 caller app, kind,
  profile과 허용 config key를 모두 검증해야 한다. 알려지지 않았거나 policy와 맞지 않는 descriptor는
  무시하지 않고 `COMMAND_POLICY_DENIED`로 거부한다.
- 허용된 integration runtime에는 인증된 app credential에서 domain-separated하게 파생하고
  app·subject·`sessionId`·`runtimeId`·profile·rooted cwd·descriptor에 묶은 versioned bootstrap
  capability만 reserved child environment key로 주입할 수 있다. capability와 파생 key는
  memory-only이고 metadata/event/log/error에 저장하지 않는다.
- bootstrap consumer는 signature만 확인하고 현재 runtime이라고 가정하지 않는다. app-owned mapping의
  현재 `sessionId`·`runtimeId`와 descriptor binding을 다시 확인해 stale runtime replay를 거부한다.
- HTTP와 WebSocket operation transport는 같은 authenticated app binding과 bootstrap key lifecycle을
  사용한다. transport가 가진 key copy는 연결 종료 때 지우고 Session이 가진 copy는 forget 또는 Host
  shutdown 때 지운다.
- integration descriptor가 있는 profile도 metadata에는 descriptor나 capability를 저장하지 않는
  `runtime-only` Session이다. 같은 Host process 안에서는 stopped/exited Session을 start할 때 새
  `runtimeId`에 묶인 capability를 다시 발급할 수 있지만 Host restart 뒤에는 start를 거부한다.
- executable, args, terminal size, Session 수, frame, scrollback, queue와 resource에 상한을 둔다.

## 6. attachment, geometry와 stream

1. Session에는 observer attachment가 0개 이상, controller가 최대 1개 있다.
2. controller도 output을 보는 attachment이며 attachment role과 caller capability는 별개다.
3. Session에는 실제 PTY가 사용하는 authoritative `{ cols, rows }` 하나만 있다.
4. 현재 controller만 현재 generation을 포함해 resize할 수 있다.
5. observer attach·resize 시도·local viewport 변화는 PTY geometry를 바꾸지 않는다.
6. observer presentation의 scale, letterbox, crop, pan, local scroll은 client 책임이다.
7. controller 인계 때 새 controller가 제출한 size만 정확히 한 번 적용한다.
8. 한 WebSocket은 여러 Session attachment를 multiplex할 수 있다.
9. attachment별 bounded output queue와 resync cursor를 둬 하나의 slow client가 다른 attachment나
   PTY를 막지 않게 한다.
10. snapshot이 `sequence=N`까지 포함하면 live output은 같은 `runtimeId`의 `N+1`부터 gap,
    duplicate, reorder 없이 적용한다.

## 7. control과 reconnect

controller가 없으면 `control:request` capability와 최신 expected generation을 가진 attachment가
`acquireControl`로 즉시 획득할 수 있다. controller가 있으면 일반 인계는 다음 상태를 따른다.

```text
request -> current controller approve/reject -> requester-only offer -> requester accept
        -> generation increment -> old controller becomes observer -> one authoritative resize
```

- 요청만으로 controller가 되지 않고, approve 뒤에도 requester가 최신 offer를 accept해야 한다.
- 같은 generation에 pending request는 여러 개 있을 수 있지만 active offer는 한 번에 하나다.
  generation 변경은 같은 old generation의 request/offer를 `controller-changed`로 종료한다.
- owner의 explicit takeover는 `control:preempt` capability와 명시적 사용자 동작으로만 실행한다.
- preempt는 이전 generation 무효화, generation 증가, role 전환, resize, `control.changed` broadcast
  순으로 원자 적용한다.
- connected, attached, visible/focused presence, controller role과 lease liveness를 서로 다른 상태로
  둔다.
- hidden/blurred만으로 controller를 즉시 해제하지 않는다.
- v0 기본 reconnect grace는 10초, heartbeat 주기는 15초, 유효 frame이 없는 stale 판정은 35초다.
- stale controller를 해제할 때 generation을 증가시키며 pending requester를 자동 승격하지 않는다.

`openAttachment`는 memory-only resume token을 발행한다. token은 `sessionId`, `attachmentId`, 인증된
app/subject, `runtimeId`, 짧은 expiry에 묶고 URL, DB, persistent browser storage, structured log와
error에 넣지 않는다. resume도 caller 인증과 app/subject scope 검사를 다시 수행한다. 성공할 때
token을 회전하고, expired·reused·wrong binding token을 거부한다. preempt, release 또는 liveness
expiry로 generation이 바뀌면 과거 token이 control을 되살리지 않는다.

## 8. capability와 authorization

| capability                        | 허용 범위                                         |
| --------------------------------- | ------------------------------------------------- |
| `session:observe`                 | 허용 Session metadata와 snapshot/live stream 관찰 |
| `control:request`                 | acquire/request/accept/release                    |
| `control:preempt`                 | 현재 controller 승인 없는 명시적 takeover         |
| `session:create:profile`          | allowlisted profile Session 생성                  |
| `session:create:arbitrary`        | policy를 통과한 structured exec 생성              |
| `session:start`                   | 새 runtime 시작                                   |
| `session:stop`                    | expected runtime/revision 조건의 stop             |
| `session:forget`                  | Session metadata 삭제                             |
| `profile:use`                     | 지정 profile 사용                                 |
| `session:read-sensitive-metadata` | 허용 command/cwd 상세 조회. env·secret은 제외     |

caller context는 app ID, subject, capability, Session/profile/root scope와 expiry를 포함한다. Gateway
principal은 browser identity assertion일 뿐 Host capability가 아니다. app은 assertion을 검증하고
자기 authorization policy를 적용한 뒤 registered app credential과 위임 범위를 넣어 caller
context를 만들며 Host가 이를 다시 검사한다. `manage`는 무제한 boolean이 아니라 granular
create/start/stop/forget/profile bundle의 편의 표현이고 arbitrary create는 별도 고위험 capability다.

권장 기본 policy는 다음과 같다.

- 인증된 Naru owner: observe/request/preempt와 profile 기반 create/start/stop/forget. arbitrary
  create는 기본으로 주지 않는다.
- Naru conflict observer: owner credential을 사용하더라도 takeover 전 app UI/policy는 observe만
  노출한다.
- local CLI owner profile: observe/request와 profile create/start/stop. full-owner credential과
  명시적 command에서만 preempt/arbitrary create를 연다.
- Codex/quick agent 위임: 특정 Session과 짧은 expiry의 observe/request. preempt/manage는 없다.
- read-only client와 custom app: 등록 때 승인된 Session/profile scope 안에서만 동작한다.

## 9. public service 계약

| 영역         | 최소 operation                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| lifecycle    | `createSession`, `listSessions`, `getSession`, `startSession`, `stopSession`, `forgetSession`                              |
| attachment   | `openAttachment`, `resumeAttachment`, `closeAttachment`, `requestSnapshot`, `resyncAttachment`                             |
| control      | `acquireControl`, `requestControl`, `approveControl`, `rejectControl`, `acceptControl`, `preemptControl`, `releaseControl` |
| terminal     | `sendInput`, `resizeTerminal`                                                                                              |
| bounded read | `readEvents`, `waitForEvents`                                                                                              |

HTTP, WebSocket, CLI와 후속 MCP는 adapter이고 Core API는 Fastify request나 transport socket을 받지
않는다. event 최소 namespace는 다음과 같다.

- `session.changed`
- `terminal.snapshot`, `terminal.output`, `terminal.exited`
- `attachment.resync-required`
- `control.requested`, `control.offered`, `control.request-resolved`
- `control.available`, `control.changed`
- `integration.event`

모든 event는 version과 `sessionId`를 가지며 관련 event에 `runtimeId`, `sequence`,
`sessionRevision`, `controllerGeneration`을 넣는다. bounded cursor 밖이면 누락을 숨기지 않고
`RESYNC_REQUIRED`를 반환한다. raw `terminal.output`은 누적 event journal에 저장하지 않는다.

create/start/stop/control accept·preempt는 idempotency key와 expected revision/runtime/generation을
사용한다. terminal input은 자동 retry하지 않고 generation과 bounded `inputId`로 짧은 중복만
제거한다. 최소 stable error는 다음과 같다.

`SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, `RUNTIME_STALE`, `SESSION_REVISION_STALE`,
`CAPABILITY_REQUIRED`, `CONTROL_HELD`, `CONTROL_GENERATION_STALE`,
`CONTROL_REQUEST_EXPIRED`, `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_RESUME_REJECTED`,
`RESYNC_REQUIRED`, `COMMAND_POLICY_DENIED`, `ROOT_BOUNDARY_VIOLATION`,
`SESSION_LIMIT_REACHED`.

error에는 terminal 원문, secret command argument, env 값과 credential을 넣지 않는다.

## 10. client와 integration 경계

- public TypeScript client와 local JSON CLI는 Naru Web private module을 import하지 않는다.
- Session CLI는 private UDS로 Host에 직접 연결하며 최소 `run`, `list`, `attach`, `watch`,
  `control`, `stop`을 제공한다.
- generic full-screen TUI는 Codex integration 없이 create·attach·control·restore를 증명한다.
- Core는 Naru Project, Workspace, Pane, Codex 의미를 알지 않는다.
- integration event는 bounded, redacted, versioned이며 terminal bytes와 분리한다.
- v0 Codex integration은 Naru process 안의 별도 port 뒤에 있고 Core의 필수 dependency가 아니다.
- `readEvents`와 `waitForEvents`는 MCP-ready하지만 v0에서 MCP server는 만들지 않는다.

## 11. 보안과 자료 경계

- Host data directory는 `0700`, secret/credential file은 `0600`이어야 한다.
- private UDS는 같은 OS 사용자의 명시적으로 등록된 app credential만 받는다.
- terminal input/output, resume token, Host credential과 child secret은 DB·structured log·error에
  저장하지 않는다.
- metadata에는 redacted executable/profile, cwd reference, lifecycle과 ordering identity만 둔다.
- root/symlink, capability, runtime/revision/generation, frame/queue/resource 제한을 fail-closed로
  검사한다.
- Host는 OS sandbox나 multi-tenant boundary가 아니다. command는 Host를 실행한 OS user 권한으로
  실행된다.

## 12. 필수 invariant와 acceptance 추적

| ID     | 완료 조건                                                                                      | 반복 검증 surface                 |
| ------ | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| DS-A01 | rapid output attach에서 sequence gap·duplicate·reorder가 0이다.                                | Host integration                  |
| DS-A02 | attachment 0개에서도 process와 bounded terminal state를 유지한다.                              | Host lifecycle/integration        |
| DS-A03 | valid token+same app/subject grace resume은 attachment/controller를 복구하고 token을 회전한다. | Host attachment/client            |
| DS-A04 | expired·reused·wrong binding token과 preempt 뒤 과거 control 복구를 거부한다.                  | capability/control negative tests |
| DS-A05 | 여러 observer의 renderer 크기가 PTY size를 바꾸지 않는다.                                      | Host attachment/browser E2E       |
| DS-A06 | transfer는 resize 1회이며 stale input·resize·accept를 거부한다.                                | reducer/Host integration          |
| DS-A07 | request/approve/offer/accept와 expiry 전후 권한 변화를 정확히 지킨다.                          | reducer/control integration       |
| DS-A08 | preempt·stop·exit race에서 generation/runtime/revision invariant를 지킨다.                     | model/race tests                  |
| DS-A09 | slow attachment만 resync하고 다른 attachment와 process는 계속 동작한다.                        | Host backpressure integration     |
| DS-A10 | Naru/Gateway restart 뒤 같은 runtime/sequence에 재attach하고 PTY가 계속 실행된다.              | restart integration/browser E2E   |
| DS-A11 | Host restart 뒤 동일 process나 terminal restore를 거짓으로 표시하지 않는다.                    | Host recovery integration         |

Release claim은 위 invariant와 Workstation 유지 gate를 현재 commit의 반복 가능한 검증으로 증명해야 한다.
특정 배포나 사용자 acceptance 결과는 이 public source 문서에 기록하지 않는다.
