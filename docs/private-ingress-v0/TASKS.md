# Private Ingress v0 작업 원장

## 상태

- Workstation v0: 완료·동결
- PrivateIngress: PI-06 자동·격리 acceptance와 public release candidate 완료
- 다음 작업: `PI-07` production 외부 변경 승인과 실기기 인수
- Production과 remote repository는 각 task의 별도 승인 경계를 따른다.

## 상태 표기

- `[ ]`: 일반 대기
- `[-]`: 진행 중
- `[>]`: 명시적 다음 작업
- `[~]`: 보류
- `[x]`: 완료·검증

## 새 세션 시작 절차

1. root `AGENTS.md`와 root SPEC/ARCHITECTURE/TASKS/DECISIONS를 읽는다.
2. 이 directory의 SPEC/ARCHITECTURE/DECISIONS/TASKS를 전부 읽는다.
3. current repository status, worktree, stash와 remote를 read-only로 확인한다.
4. 명시적 next task만 `[-]`로 바꾸고 범위 밖 Naru code나 production을 변경하지 않는다.
5. Remote push와 release publish는 root `AGENTS.md`에 따라 별도 사용자 결정을 받는다.

## 병렬화 gate

`PI-00`은 새 public baseline을 정하는 유일한 이동 작업이므로 단독 수행한다. **PI-00 완료 후,
즉 PI-01부터 Naru app 개선 worktree를 병렬로 시작할 수 있다.** 모든 worktree는 이 public repository에서
만든다.

| Naru 작업                  | 가장 이른 시작                      | 병렬 lane·제약                                   |
| -------------------------- | ----------------------------------- | ------------------------------------------------ |
| T52 keyboard resize blink  | PI-01                               | Mobile UI lane. PI-01/PI-02와 병렬 가능          |
| T53 activity sync          | PI-01                               | Activity lane. PI-01/PI-02와 병렬 가능           |
| T54 approval lifecycle     | T53 contract/state merge 뒤         | T53과 같은 lane; 구현 중첩 금지                  |
| T55 Codex rolling refresh  | T53와 PI-05 완료 뒤                 | 새 distribution/maintenance를 사용               |
| T46 helper keyboard focus  | PI-01, 단 T52와 직렬                | Mobile UI lane                                   |
| T48 helper draft lifecycle | T46 완료 뒤                         | Mobile UI lane                                   |
| T29 mobile composer/image  | PI-01, 다른 terminal UI 작업과 직렬 | Mobile UI lane                                   |
| T44 mobile selection/copy  | PI-01, 다른 terminal UI 작업과 직렬 | Mobile UI lane                                   |
| T47 push cleanup           | T53/T54 상태 계약 뒤                | Activity/Push integration lane                   |
| T40 Docs/Tasks view state  | PI-01                               | 별도 Docs UI lane 가능, 낮은 우선순위            |
| T35/T37/T38/T39            | PI-08 이후 재선택                   | 큰 제품·보안 경계 확장이라 cutover와 병렬 비권장 |

권장 첫 parallel wave는 `PI-01 + T52 + T53`이다. T52와 T53 중 하나만 선택해도 되며 slot을 채우기
위해 낮은 우선순위 작업을 자동 시작하지 않는다.

공용 파일 ownership:

- Ingress lane: `packages/contracts`의 PrivateIngress delta, `apps/workstation-gateway`,
  `ops/workstation/distribution`
- Mobile UI lane: 승인된 `apps/web` terminal/input path와 전용 test
- Activity lane: 승인된 Naru activity server/web path와 전용 test
- Integration owner only: root package/workspace/tsconfig, lockfile, shared config, official docs와 DB migration

shared delta가 필요하면 worker가 임의 수정하지 않고 integration manifest/commit으로 넘긴다. main merge는
각 lane의 focused verification 뒤 integration owner가 순차 수행하고 마지막에 full standard suite를
실행한다.

## PI-00. 공개 가능한 clean repository 기준선

- [x] **범위**: 승인된 source inventory에서 공개 allowlist를 만들고 이전 private `.git` 이력 없이
      Naru repository 기준선을 준비한다. 개인정보·운영 topology·historical evidence를 root commit 전에
      제거한다.
- **선행 조건**: 이 계약과 사용자 승인
- **산출물**: export inventory, sanitized source tree, generic public docs/AGENTS, clean initial Git commit,
  secret/privacy scan과 build/test 결과
- **완료 조건**:
  - raw checkout, `.git`, stash, worktree metadata와 실제 운영 state를 복사하지 않는다.
  - packages, Host, Gateway, CLI와 필요한 Naru reference app code/test를 allowlist로 추출한다.
  - 실제 path/domain/IP/tailnet/account, production runbook/evidence/handoff를 제거한다.
  - hard-coded production defaults, PWA Origin, ACME/operations 상수를 config 또는 generic fixture로 바꾼다.
  - 공개 `README`, `SECURITY`, `CONTRIBUTING`, generic `AGENTS.md`와 license notices를 검토한다.
  - format, lint, typecheck, test, build와 relevant E2E를 통과한다.
  - dedicated secret/privacy scan에서 차단 항목이 없고 새 repository status가 clean이다.
  - remote를 추가하거나 push하지 않는다.
  - 사용자에게 export inventory와 제외 목록을 제시하고 완료 승인을 받는다.
- **완료 증거 (2026-09-06)**: allowlisted 454-file public baseline의 `c77638c` clean root commit,
  449 reachable-object privacy scan 0건, 표준 format/lint/typecheck/test/build,
  operations/distribution/production smoke와 E2E 14/14 통과를 확인했다. 교체 전 unreachable 객체를
  제거했고 사용자가 완료를 승인했다. Remote와 production은 변경하지 않았다.
- **병렬 경계**: 완료 전에는 current source 기준선이 움직이지 않도록 다른 Naru feature를 시작하지 않는다.

## PI-01. PrivateIngress 계약·threat model 고정

- [x] **범위**: 문서의 `PrivateIngressV0`를 runtime schema, TypeScript type, 정상·거부 fixture와
      ownership matrix로 고정한다. 구현 listener는 만들지 않는다.
- **선행 조건**: PI-00
- **산출물**: public contract, JSON/Zod schema, redacted fixtures, threat model, ADR
- **완료 조건**:
  - loopback-proxy와 direct-private-tls의 required/forbidden field가 strict하게 분리된다.
  - exact Origin/listener, explicit private IPv4/CIDR source, TLS ownership과 public exposure 거부가
    fixture에 포함된다.
  - secret/path redaction과 receipt digest 규칙이 확정된다.
  - contract test가 통과하고 사용자가 구현 시작을 승인한다.
- **완료 증거 (2026-09-06)**: additive `@naru/contracts/private-ingress/v0` Zod/JSON schema와
  TypeScript type, accepted/rejected/redaction/digest vector, single-active listener union, explicit RFC1918
  exact IPv4/CIDR source contract, threat model·ownership matrix와 PI-D009~PI-D011을 고정했다.
  Node 24.19.0에서 format, lint, typecheck, 649 passed/4 skipped test, build를 통과했고 변경
  포함 public scan은 459 files/470 objects, findings 0이었다. Listener, production과 remote는
  변경하지 않았다.
- **병렬 경계**: T52와 T53을 별도 worktree에서 시작할 수 있다.

## PI-02. Gateway direct private TLS listener

- [x] **범위**: Gateway browser listener를 strict adapter union으로 바꾸고 direct HTTPS/WSS mode를
      구현한다. 기존 loopback/Tailscale 경로를 보존한다.
- **선행 조건**: PI-01
- **산출물**: listener adapter, exact private bind, HTTPS/WSS server, config tests
- **완료 조건**:
  - direct mode가 exact private address에만 bind한다.
  - Naru는 gateway-managed exact loopback upstream만 사용한다.
  - 두 mode가 forbidden field나 fallback을 공유하지 않는다.
  - listener lifecycle과 existing Gateway auth regression이 통과한다.
- **완료 증거 (2026-09-07)**: Gateway config v2의 explicit `browserIngress` union과 v1 loopback
  compatibility, direct exact active RFC1918 bind, Gateway-owned HTTPS/WSS, exact `127.0.0.1` managed
  upstream과 fail-closed TLS bootstrap port를 구현했다. Node 24.19.0에서 format, lint, typecheck,
  657 passed/4 skipped test, build와 E2E 14/14를 통과했고 public scan은 465 files/490 objects,
  findings 0이었다. TLS material validator/reload는 PI-04, source admission/header limit은 PI-03,
  distribution/production activation은 PI-05 이후로 남겼고 remote와 production은 변경하지 않았다.

## PI-03. source·Origin·header 보안

- [x] **범위**: actual socket source allowlist, exact Host/Origin과 spoofed proxy/identity header 경계를
      direct listener에 적용한다.
- **선행 조건**: PI-02
- **산출물**: source policy, header sanitization, size/timeout limit와 negative test matrix
- **완료 조건**:
  - wildcard/public bind, public·invalid IPv4/CIDR source, wrong Origin/Host와 비허용 IP를 거부한다.
  - inbound forwarding/Gateway identity spoof가 Naru에 도달하지 않는다.
  - HTTP와 WebSocket에 같은 source/auth policy를 적용한다.
- **완료 증거 (2026-09-07)**: Direct TLS `secureConnection`에서 actual canonical IPv4 exact/CIDR source를
  검사하고 비허용·missing·public·loopback·IPv6·IPv4-mapped source를 HTTP/WSS dispatch 전에 닫았다.
  모든 browser request의 exact Host/제공된 Origin, unsafe HTTP/WSS의 required Origin, direct-mode
  forwarding/assertion/identity header 사전 거부와 upstream sanitizer를 적용했다. Header 16 KiB·64 fields,
  header 5초/request 30초/keep-alive 5초/socket당 100 request, 기존 body/WS payload·queue 상한과 actual
  source당 20회/분·global 100회/분 authentication rate limit을 고정했다. Node 24.19.0에서 format, lint,
  typecheck, 667 passed/4 skipped test, build와 E2E 14/14를 통과했고 public scan은 469 files/510 objects,
  findings 0이었다. TLS validator/reload는 PI-04로 유지했고 distribution, production과 remote는 변경하지
  않았다.

## PI-04. TLS material과 last-known-good lifecycle

- [x] **범위**: 기존 Naru TLS 검증을 production provider에서 분리해 Gateway direct listener에 연결한다.
- **선행 조건**: PI-02, PI-03
- **산출물**: canonical path/owner/mode/SAN/key/expiry validator, hot reload, readiness/diagnostic
- **완료 조건**:
  - invalid initial material은 bind 전에 실패한다.
  - valid A→B는 새 handshake에 적용되고 기존 WSS/Host PTY는 유지된다.
  - invalid B는 A와 current connection을 보존한다.
  - certificate provider credential이나 raw path/error를 공개 log에 남기지 않는다.
- **완료 증거 (2026-09-07)**: `@naru/tls-material`에 canonical approved-root/final-target,
  current-user owner/private mode, regular-file/size, SAN/validity/key-pair validator와 reusable
  last-known-good state machine을 분리했다. Naru의 기존 generation/ACME provider 계약을 보존하면서
  Gateway direct provider의 10초 material reload, atomic secure-context 교체, redacted browser/admin
  readiness와 expiry raw-connection gate를 연결했다. Valid A→B의 새 handshake 전환, invalid candidate에서
  B와 existing WSS 유지, last-known-good 만료 뒤 신규 TLS 거부와 기존 WSS 유지, valid renewal 회복을
  검증했다. Node 24.19.0에서 format, lint, typecheck, 678 passed/4 skipped test, build, E2E 14/14,
  operations 64, distribution 47과 production smoke 1을 통과했고 public scan은 477 files/540 objects,
  findings 0이었다. Public contract version, distribution/production, network와 remote는 변경하지
  않았다.

## PI-05. Workstation distribution·maintenance 통합

- [x] **범위**: private ingress intent, plan/apply/status/doctor/reconfigure/rollback을 immutable release와
      receipt에 연결한다.
- **선행 조건**: PI-03, PI-04
- **산출물**: config renderer, launchd lifecycle, ownership preflight, transaction/rollback test
- **완료 조건**:
  - network/DNS/certificate material은 inspect만 하고 package-owned 자원만 변경한다.
  - port/profile conflict, bad TLS/upstream과 stale receipt를 apply 전에 거부한다.
  - caller 종료와 무관한 maintenance handoff, rollback과 redacted result가 동작한다.
  - existing Tailscale distribution regression이 통과한다.
  - pre-existing production source를 허용하는 operator admission을 자동 변경하지 않고 public source로
    넘길 exact target·검증·rollback 절차를 별도 transition plan으로 제시한다.
- **완료 증거 (2026-09-07)**: 동결된 distribution v1 intent·receipt/Tailscale Gateway config v1을
  보존하면서 strict `PrivateIngressV0` owner-only 입력, additive distribution v2와 Gateway config v2
  renderer를 구현했다. Plan/apply는 interface·private DNS·TLS material·exact listener와 artifact/config
  identity를 approval digest에 결합하고 maintenance worker가 mutation 직전에 재검증한다. Redacted
  status/doctor, direct HTTPS chain, immutable v2 receipt, source transition plan과 v1 → v2 → v1 rollback을
  검증했다. Node 24.19.0에서 format, lint, typecheck, 691 passed/4 skipped test, build, E2E 14/14,
  operations 64, distribution 60과 production smoke 1을 통과했고 public scan은 483 files, findings 0이었다.
  Production service/source admission, network/DNS/certificate와 remote는 변경하지 않았다.
- **병렬 경계**: T53이 완료됐다면 T55를 별도 lane에서 시작할 수 있다.

## PI-06. 자동·격리 acceptance와 public release candidate

- [x] **범위**: 전체 negative security matrix, HTTP/WSS, actual PTY continuity와 공개 artifact를 검증해
      production staging 후보 commit을 고정한다.
- **선행 조건**: PI-05와 포함하기로 한 parallel Naru changes의 integration 완료
- **산출물**: pinned commit/artifact digest, full verification evidence, known limitations, rollback plan
- **완료 조건**:
  - format, lint, typecheck, unit/integration, build, E2E와 dependency/secret scan이 통과한다.
  - Gateway/Naru restart에서 Host PTY/runtime continuity를 실제로 확인한다.
  - Funnel/public DNS/public listener/port forwarding 부재를 확인한다.
  - production과 분리된 data/config/label/port를 사용한다.
- **완료 증거 (2026-09-07)**: production과 분리된 임시 data/config와 동적 loopback port에서 실제
  Node 24 `node-pty` session을 Gateway → Naru → Host로 연결했다. Gateway와 Naru를 각각 재시작한 뒤에도
  같은 session/runtime identity, 증가하는 terminal sequence와 live WSS 출력을 확인했다. 재시작 중
  reserved WebSocket close code를 전달하던 결함은 valid proxy failure code 정규화와 regression test로
  수정했다. 배포 builder는 archive SHA-256을 반환하며 target prebuild를 보존한 채 네이티브 build
  metadata의 local path를 제거한다. Node 24.19.0에서 format, lint, typecheck, 693 passed/5 skipped test,
  build, E2E 14/14, operations 64, distribution 61, production smoke 1과 actual acceptance 1을 통과했다.
  두 private output parent에 같은 build ID로 만든 Node 24.20.0 artifact의 source/lockfile/manifest/payload/
  archive identity와 archive bytes가 일치했다. Security audit은 high 이상 0건이며 Windows 개발 서버에만
  해당하는 dev-only low advisory 1건을 known limitation으로 남겼다. Public exposure는 source·artifact의
  fail-closed contract와 loopback 실험으로 검증했고 router port forwarding 부재는 package가 관찰할 수
  없는 PI-07 operator preflight로 명시했다. Production, network, remote와 release publication은 변경하지
  않았다.

## PI-07. WireGuard/LAN 임시 Origin 실기기 인수

- [>] **범위**: 기존 production을 유지한 채 같은 private hostname의 승인된 임시 port에서 새 pinned
  stack을 설치하고 실제 기기 인수를 수행한다.
- **선행 조건**: PI-06, production 외부 변경의 fresh 사용자 승인
- **산출물**: Mac/Windows/Android acceptance, Passkey/PWA/Push, restart/reboot/rollback evidence
- **완료 조건**:
  - exact private listener와 approved source만 접근한다.
  - actual Codex PTY, multi-device handoff, Gateway/Naru restart와 Mac reboot 복구를 확인한다.
  - port reconfigure에 따른 PWA/worker/push와 Passkey 경계를 확인한다.
  - 기존 production service/data/listener는 변경하지 않는다.
- **freeze**: PI-08 종료까지 release candidate에 다른 feature merge/deploy를 금지한다.

## PI-08. canonical WireGuard production cutover

- [ ] **범위**: active PTY와 backup을 확인하고 legacy listener를 중지한 뒤 새 Gateway direct TLS
      listener를 canonical port로 reconfigure한다. 실패하면 legacy를 복구한다.
- **선행 조건**: PI-07 사용자 인수, fresh cutover 승인, public repository의 pinned commit을 exact
  canonical source로 인정하도록 production operator admission을 별도 승인·갱신·검증
- **산출물**: backup, one-time cutover receipt, device smoke, tested rollback result
- **완료 조건**:
  - current session이 Naru-hosted이면 main service를 직접 중지하지 않는다.
  - personal deployment admission이 새 source를 거부하면 manual stop/activate/bootstrap으로 우회하지
    않고 cutover를 중단한다.
  - canonical HTTPS, Passkey, REST/WSS, actual Codex와 PWA/Push를 실제 기기에서 확인한다.
  - 실패 시 새 listener를 내리고 기존 release/listener를 복원한다.
  - 성공해도 legacy repository/data/service를 삭제하지 않는다.

## PI-09. soak, Tailscale test route와 legacy 정리

- [ ] **범위**: 3~7일 새 production을 사용한 뒤 package-owned Tailscale test route와 pre-existing
      deployment 처리안을 사용자에게 제시하고 승인된 항목만 정리한다.
- **선행 조건**: PI-08, soak 기간의 사용자 승인
- **산출물**: soak report, retained backup/archive, cleanup inventory, updated canonical deployment helper
- **완료 조건**:
  - 새 runtime의 continuity, renewal, restart와 actual usage에 차단 결함이 없다.
  - Tailscale global/account state가 아니라 package-owned test route만 rollback한다.
  - pre-existing resource 삭제·rename은 exact target과 복구 가능성을 확인한 별도 승인 뒤 수행한다.
  - public remote push 방식도 root GitHub 계정 지침에 따라 별도 결정한다.

## PI-10. Multi-ingress 후속 설계·구현

- [ ] **범위**: 하나의 Gateway instance에서 Tailscale `loopback-proxy`와 LAN/WireGuard
      `direct-private-tls`를 동시에 active browser ingress로 운영할 수 있도록 multi-ingress 계약을
      별도 설계한다. v0의 하나의 canonical Origin·active listener 불변조건은 유지하며, v0 이후 작업으로
      수행한다.
- **선행 조건**: PI-09 및 v0 soak/rollback 완료
- **산출물**: multi-ingress ADR, versioned contract/schema migration, Origin별 session·Passkey·PWA/
  service-worker·cookie 정책, listener별 source/TLS/health/rollback 모델, compatibility test matrix
- **완료 조건**:
  - 여러 ingress profile을 inventory에 보관하고 여러 profile을 명시적으로 active로 선택할 수 있다.
  - Tailscale과 LAN/WireGuard의 서로 다른 Origin 및 동일 hostname/split-DNS 전략을 각각 명시한다.
  - listener별 authentication, Origin/Host, source policy와 readiness를 독립적으로 검증한다.
  - 한 listener 장애·reconfigure·rollback이 다른 active ingress와 session을 부당하게 손상하지 않는다.
  - 기존 v0 단일-ingress 설정의 migration 및 rollback 경로가 검증된다.
