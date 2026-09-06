# Naru Workstation final distribution

이 디렉터리는 standalone macOS arm64 package와 per-user Host/Gateway/Naru topology를 담당한다.
package/receipt/launchd prefix는
`kr.hurdoo.naru.workstation`이고 내부 workspace package 이름은 `@naru/*`다. Standalone
compatibility service와 package-managed instance service는 서로 다른 namespace를 사용한다.

## 설치 경계

- instance namespace는 installation UUID와 target UID에서 만든
  `<slug>-u<uid>-<digest12>`다. 사용자명, Project, domain과 secret은 label에 넣지 않는다.
- 장기 상태는 `~/Library/Application Support/Naru Workstation/instances/<namespace>/`, 짧은
  UDS는 `~/Library/Application Support/NaruWS/<namespace>/run/`에 둔다. package가 관리하는
  private ancestor는 target user 소유의 exact `0700`, private file은 exact `0600`이어야 하며
  symlink component를 거부한다.
- 상시 job은 `.host`, `.gateway`, `.naru` 세 개다. 모두 immutable release에 포함된 package-owned
  exact Node 24를 실행하며 `RunAtLoad=true`, `KeepAlive.SuccessfulExit=false`,
  `ThrottleInterval=10`, `ExitTimeOut=20`, `Umask=077`을 사용한다.
- `.maintenance`는 `RunAtLoad`와 `KeepAlive`가 없는 one-shot job이다. 모든 mutation은 review한
  plan digest를 요구하고 이 독립 job으로 넘긴다. `NARU_PTY_HOSTED=1`인 Naru-owned PTY 안에서
  maintenance body를 inline 실행하지 않는다.
- installer는 source build나 dependency install을 target에서 수행하지 않는다. artifact에는 공식
  Node 24 runtime과 upstream license/source metadata, Host/Gateway/Naru production dependency,
  `node-pty`/`better-sqlite3` native payload, base web release와 두 CLI bundle이 모두 있어야 한다.
  Naru의 Apache-2.0 `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`도 top-level payload와 manifest에
  포함하며 누락되면 artifact 검증을 거부한다.
  target user의 Homebrew, global Node, PATH나 shell rc는 prerequisite도 mutation target도 아니다.
- package는 loopback runtime과 launchd만 다룬다. Tailscale/DNS/TLS/listener apply, passkey owner
  bootstrap, notification permission, PWA 설치와 Codex hook trust는 별도 plan/사용자 판단이다.

## Private Ingress v2 intent

기존 distribution v1 intent와 Tailscale Gateway config v1은 그대로 지원한다. Direct private TLS는
`@naru/contracts/private-ingress/v0`를 만족하는 owner-only JSON file(`0600` 권장)을 하나로 받아
distribution intent v2와 Gateway config v2를 만든다. Private Origin, listener, source address/CIDR와
TLS path를 command-line flag로 나누지 않는다.

```text
workstation intent --json \
  --slug <instance-slug> \
  --artifact <expanded-artifact> \
  --private-ingress <owner-only-private-ingress-v0.json> \
  --project-root <dedicated-allowed-parent> \
  --shell <canonical-shell> \
  --codex <canonical-codex>
```

`plan --operation apply`/`apply`, `status`, `doctor`, `reconfigure`과 `rollback`을 사용한다.
`apply`는 fresh installation의 명시적 alias이며 기존 `install` command를 제거하지 않는다.
Plan과 receipt는 exact private intent를 digest로 결합하지만 일반 JSON 출력은 profile, Origin,
listener와 TLS path를 redaction한다. Mutation 완료는 owner-only result file을 직접 노출하지
않고 `status`/`doctor`로 확인한다.

Source transition은 [`docs/private-ingress-v0/SOURCE_TRANSITION.md`](../../../docs/private-ingress-v0/SOURCE_TRANSITION.md)를
따른다. PI-05 command는 production repository admission이나 pre-existing deployment를 변경하지 않는다.

## owner passkey bootstrap과 recovery

설치·network doctor가 canonical HTTPS Origin과 Gateway admin UDS를 확인한 뒤 target user가 직접
다음을 실행한다.

```text
workstation auth bootstrap --intent <owner-only-intent.json> --json
workstation auth recover --intent <owner-only-intent.json> --json
```

명령은 intent에서 instance namespace를 다시 계산하고 exact mode `0600`인 same-user Gateway admin
UDS만 호출한다. 출력의 `code`는 짧은 TTL의 일회성 비밀이므로 채팅, shell history, 파일, 로그에
복사하지 않고 exact `origin`의 Gateway 등록 화면에만 입력한다. `bootstrap`은 등록 credential이 없는
fresh instance에서만 가능하고, `recover`는 모든 passkey를 잃은 경우의 local-only 경로다. remote reset,
password fallback과 다른 user socket fallback은 없다.

## 단일 browser Origin

intent의 `canonicalBrowserOrigin` 하나가 Gateway browser Origin, WebAuthn RP hostname, Naru exact
allowed Origin, ingress identity, PWA manifest id/start/scope/icon URL, service-worker revision과 Push
subscription Origin을 결정한다. Source manifest는 same-origin relative URL을 사용하고 HTML의
`https://naru.example.test:8443`은 식별 불가능한 build fixture일 뿐이다. Builder는
`NARU_PWA_BUILD_ORIGIN`으로 source build metadata를 바꿀 수 있고 installer는 항상 instance별 immutable
web release를 다시 렌더한다.

Origin 변경은 allowlist에 누적하지 않고 새 receipt가 이전 receipt를 supersede한다. port가 바뀌면
PWA/service-worker/cache/push subscription을 새 Origin에서 다시 인수하고, hostname이 바뀌면 새 RP
ID의 owner bootstrap/passkey도 다시 인수한다. VAPID keypair는 명시적 rotation 없이 보존한다.
browser-owned 이전 Origin 상태는 doctor가 알리지만 강제 삭제하지 않는다.

## artifact build

builder는 Node 24가 실행되는 clean committed darwin-arm64 worktree에서만 동작하며 기존 output을
덮어쓰지 않는다. 공식 `node-v24.20.0-darwin-arm64.tar.gz`를 별도로 받아 official checksum
`40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8`과 대조할 build input으로 준다.
builder 자체는 network download를 하지 않는다.

```text
node ops/workstation/dev/run-node24.mjs \
  --import tsx ops/workstation/distribution/build-artifact.ts --json \
  --output-parent <private-absolute-directory> \
  --build-id <release-id> \
  --node-runtime-archive <absolute-node-v24.20.0-darwin-arm64.tar.gz>
```

결과는 `naru-workstation-darwin-arm64-<build-id>.tar.zst`와 검증 가능한 expanded root다. manifest는
source commit, lockfile digest, Node archive source/digest, exact Node executable digest, 전체
regular-file hash/mode와 native payload를 기록한다. builder는 Node version·arm64·strict macOS code
signature를 먼저 확인하고, root lockfile과 local
content-addressable store만 쓰는 offline/frozen `pnpm deploy --prod`를 symlink 없는 hoisted runtime으로
정규화한다. 내부 `@naru/*`는 runtime dist에 bundle하고 build-machine path·pnpm volatile metadata를
거부하며, artifact에 들어갈 바로 그 Node가 세 entrypoint를 fail-closed config 경계까지 load하는지
검사한다. 같은 commit·lockfile·build ID는 manifest/payload와 `.tar.zst` SHA까지 동일해야 한다.
publish 전에 반환된 manifest digest와 archive SHA-256을 신뢰할 수 있는 release record와 함께 보존한다.

target의 strict `codesign` 실패는 곧바로 binary 손상으로 단정하지 않는다. verified artifact의 Node
SHA-256을 먼저 확인하고 Apple `/usr/bin/true` control이 같은 context에서 성공하는지 검사한다. control이
성공하는데 Node만 실패하면 차단한다. control도 trust-store 오류로 실패하고 Node가 exact pin일 때만
plan에 `exact-hash-fallback` warning을 남기며, 실제 launchd와 readiness는 계속 별도 승인이 필요하다.

## 계획과 mutation

artifact의 `runtime/node/bin/node`로 `bin/workstation.mjs`를 target user 자신의 GUI login session에서
실행한다. 먼저 `intent` 출력을 `umask 077`인 private canonical file로 저장한다. `--project-root`는 실제
등록 Project가 아니라 그 Project를 허용할 전용 parent policy다. 새 artifact에는 `--node`를 주지 않는다.
그 option은 기존 external-runtime artifact migration에만 남아 있고 packaged artifact에서는 거부된다.
transaction 분류는 Origin/root/shell/Codex/ingress 같은 사용자 승인 설정을 artifact-owned release Node
절대경로와 분리한다. `upgrade`는 사용자 승인 설정이 그대로인 새 artifact만 허용하며, legacy external
runtime에서 artifact-owned runtime으로의 one-way 전환도 다른 사용자 설정이 모두 같을 때만 같은
upgrade로 허용한다. 이 migration과 Origin/root 같은 reconfigure를 한 plan에 섞으면 차단한다.

```text
<expanded-artifact>/runtime/node/bin/node <expanded-artifact>/bin/workstation.mjs intent --json \
  --slug <instance-slug> \
  --artifact <expanded-artifact> \
  --origin <exact-https-origin> \
  --project-root <dedicated-allowed-parent> \
  --shell <canonical-shell> \
  --codex <canonical-codex>

<expanded-artifact>/runtime/node/bin/node <expanded-artifact>/bin/workstation.mjs plan --json \
  --intent <private-intent.json> --operation install
```

`plan`과 `doctor`는 read-only다. `install`, `upgrade`, `reconfigure`, `rollback`은 각각 fresh plan의
exact `planDigest`를 사용자가 검토·승인한 뒤에만 실행한다. CLI 성공은 maintenance handoff가
완료됐다는 뜻이며 설치 완료가 아니다. 반환된 `resultFile`의 terminal result와 새 `doctor --json`을
확인해야 한다.

승인된 mutation은 source artifact를 즉시 다시 검증하고 target-user private immutable release에 temporary
copy→재검증→atomic rename으로 stage한다. 그 다음에만 maintenance plist와 request를 쓰며, 최초 handoff부터
Node, entrypoint와 working directory는 모두 release-local path다. Documents/Downloads 같은 source transport
path는 launchd 지속 상태에 남기지 않는다. approval digest는 transport path 대신 verified artifact identity,
destination, 설정과 actual state를 고정한다. receipt가 없으면 stage된 release만으로 설치 성공이 아니다.

start order는 Host readiness, Gateway readiness와 public verifier-key file, Naru readiness 순서다.
reconfigure는 바뀐 downstream만 restart하되 Host 설정이 바뀌면 세 runtime 모두 다시 시작한다.
최초 설치 readiness 실패는 새 runtime과 RunAtLoad plist를 제거하고, 기존 installation의 실패는
mutable 설정을 복원한 뒤 이전 receipt topology를 다시 시작한다.

실제 second-user/PWA/Push/private-ingress 인수는 production과 분리된 instance에서 수행한다. 최소한
artifact/receipt digest, exact component readiness, browser-to-PTY chain, restart/rollback, PWA update와
opt-in Push를 확인한다. Evidence에는 command 결과를 그대로 붙이지 않고 pass/fail과 redacted diagnostic
ID만 기록한다. Secret, cookie, Passkey material, Codex 인증, 실제 path·domain·IP와 terminal 원문은
source repository에 남기지 않는다.
