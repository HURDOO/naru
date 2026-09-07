# Private Ingress v0 결정 기록

## PI-D001. 기존 WireGuard/LAN Origin을 운영 경계로 유지한다

- 상태: accepted
- 결정: Tailscale Serve는 선택적인 Workstation 호환 경로로 남기고 production은 operator-managed
  private DNS, WireGuard/LAN route와 canonical HTTPS Origin을 사용한다.
- 결과: 배포 endpoint와 RP hostname을 불필요하게 바꾸지 않는다. 새 Gateway auth store의 owner
  Passkey bootstrap, PWA/service-worker와 Push 인수는 별도로 수행한다.
- 제외: WireGuard, private/public DNS, router와 firewall을 package가 자동 변경하지 않는다.

## PI-D002. WireGuard direct ingress는 Gateway listener adapter로 구현한다

- 상태: accepted
- 결정: 별도 mandatory reverse proxy를 추가하지 않고 Gateway에 `direct-private-tls` listener mode를
  추가한다. 기존 Tailscale path는 `loopback-proxy` mode로 유지한다.
- 이유: Gateway가 실제 socket IP, TLS와 authentication을 같은 연결에서 검증해 forwarded identity와
  추가 proxy trust를 피하고 운영 component 수를 줄인다.
- 결과: 현재 literal loopback config는 strict discriminated union으로 확장하지만 mode 간 implicit
  fallback은 허용하지 않는다.

## PI-D003. 네트워크와 인증서 상태는 사용자 소유다

- 상태: accepted
- 결정: package는 exact listener와 TLS termination을 소유하지만 private DNS, WireGuard, route,
  certificate material과 renewal은 user/external owner로 둔다.
- 결과: Gateway는 certificate를 검증·hot reload하고 doctor로 외부 상태를 판정하지만 ACME/DNS provider
  credential을 읽거나 외부 network state를 변경하지 않는다.

## PI-D004. 공개 저장소는 새 clean history로 시작한다

- 상태: accepted
- 결정: Public baseline은 raw private checkout이나 기존 `.git` 이력을 복사하지 않고 allowlist로
  구성한 clean root commit에서 시작한다.
- 결과: Public source와 feature development는 이 repository를 기준으로 하며 instance config, 운영
  evidence와 pre-existing deployment history는 source 밖에 남긴다. Remote push는 별도 승인 경계다.

## PI-D005. PI-00 뒤 Naru app 개선을 병렬화한다

- 상태: accepted
- 결정: PI-00 clean public baseline은 단독 수행한다. PI-00 완료 뒤 PrivateIngress, mobile UI와 Codex
  activity를 새 repository의 별도 worktree에서 병렬 구현한다.
- 제약: 같은 terminal UI lane 작업은 서로 직렬화하고 T53/T54의 shared lifecycle을 한 integration
  owner가 순서대로 합친다. T55는 T53과 PI-05를 모두 선행 조건으로 둔다.
- release gate: PI-07~PI-08 actual staging/cutover에는 pinned release를 freeze하고 진행 중 feature
  worktree의 merge와 production deploy를 미룬다.

## PI-D006. pre-existing deployment 정리는 cutover와 soak 뒤 별도 승인으로만 한다

- 상태: accepted
- 결정: Pre-existing deployment가 있으면 새 runtime을 candidate private Origin에서 인수하고 canonical
  Origin으로 전환한 뒤에도 기존 service와 data를 3~7일 rollback용으로 보존한다.
- 결과: 구현·공개 준비 승인을 production 변경이나 삭제 승인으로 확대하지 않는다.

## PI-D007. 개발 source와 production operator의 전환 시점을 분리한다

- 상태: accepted
- 결정: Public source의 development 기준 전환과 production operator가 허용하는 exact source 전환을
  분리한다.
- 결과: PI-05에서 generic distribution과 operator transition을 검증한다. Production tooling의 target
  변경은 별도 승인을 받고 admission이 맞지 않으면 manual production command로 우회하지 않는다.

## PI-D008. Multi-ingress는 Private Ingress v0 이후로 연기한다

- 상태: accepted
- 결정: v0는 instance당 하나의 `canonicalBrowserOrigin`과 하나의 active browser listener만 유지한다.
  Tailscale `loopback-proxy`와 LAN/WireGuard `direct-private-tls`는 inventory와 호환 경로로 보존할 수
  있지만, v0 runtime에서 동시에 active로 운영하지 않는다.
- 이유: 서로 다른 Origin의 Passkey RP ID, session/CSRF cookie, PWA/service-worker, WebSocket Origin,
  canonical URL과 listener별 rollback/readiness 모델을 별도로 정의해야 한다.
- 후속 조치: Tailscale과 LAN/WireGuard 동시 운영은 `TASKS.md`의 PI-10에서 versioned contract,
  migration과 compatibility test를 설계한 뒤 구현한다. v0의 implicit fallback이나 기존 단일-ingress
  계약을 소급 변경하지 않는다.

## PI-D009. PrivateIngress contract는 Workstation v0에 additive하게 공개한다

- 상태: accepted
- 결정: `@naru/contracts/private-ingress/v0`에 `PrivateIngressV0` Zod/JSON schema, TypeScript
  type, `GatewayIngressV0` strict union과 public test vector를 추가한다.
- 호환성: 동결된 `@naru/contracts/workstation-gateway/v1` `IngressProfileV0`와 consumer를
  변경하지 않는다. 기존 `direct-private-listener`/`tlsOwner`는 새 Gateway-owned
  `direct-private-tls` contract와 동일하지 않다.
- migration: PI-02/PI-05가 명시적 profile selection·preflight·receipt migration을 구현한다.
  새 field를 추론하거나 기존 profile에서 implicit fallback하지 않는다.

## PI-D010. Explicit private IPv4 CIDR source admission을 허용한다

- 상태: accepted
- 결정: `private-ipv4-allowlist`는 exact RFC1918 IPv4와 canonical RFC1918 IPv4 CIDR를
  별도 array로 받고 한 policy에서 함께 사용할 수 있다. listener bind는 계속 exact
  private IPv4만 허용한다.
- 제약: public/wildcard/IPv6, host bit가 있는 CIDR, duplicate, overlapping CIDR과 CIDR에
  이미 포함된 exact address를 거부한다. 실제 socket remote address만 판정하고 forwarded
  header를 source로 사용하지 않는다.
- 보안 결과: CIDR은 network admission 범위를 넓힐 뿐 authentication이 아니다. Gateway
  Passkey/session/CSRF/WS auth, Naru authorization과 Host capability를 계속 독립적으로 요구한다.

## PI-D011. Intent digest와 diagnostic redaction을 contract에서 고정한다

- 상태: accepted
- 결정: strict parse 후 source set을 numeric order로 정렬하고 purpose-tagged canonical JSON의
  UTF-8 SHA-256 lowercase hex를 intent digest로 사용한다. exact private reference는 digest에
  결합하지만 preimage는 로그하지 않는다.
- redaction: public diagnostic은 profile, Origin, listener·source와 TLS path를 출력하지 않고
  source count와 non-secret ownership/mode만 유지한다. Owner-only private receipt와 public-safe
  projection을 분리한다.
- 후속 조치: PI-05는 intent digest에 operation, artifact/config identity와 actual-state fingerprint를
  결합해 fresh plan approval과 immutable receipt를 구현한다.

## PI-D012. Gateway config v2에서 active browser ingress를 명시한다

- 상태: accepted
- 결정: Gateway private config v2는 `browserIngress: GatewayIngressV0`를 정확히 하나 요구한다. 기존
  config v1은 frozen loopback listener shape로 계속 읽되 direct mode나 새 network field로 추론하지 않는다.
- 호환성: v1 loopback/Tailscale runtime과 auth consumer는 유지한다. Direct mode는 v2에서만 허용하고
  top-level legacy listen field, profile/Origin drift와 mode별 forbidden field를 strict하게 거부한다.
- migration: PI-05 distribution renderer가 승인된 active profile로 v2 config를 생성한다. Runtime은 invalid
  v2 또는 missing direct dependency를 v1/loopback으로 fallback하지 않는다.

## PI-D013. PI-02 direct listener는 검증된 TLS bootstrap port를 사용한다

- 상태: accepted
- 결정: PI-02는 Gateway의 HTTPS/WSS transport와 exact bind lifecycle을 구현하되 TLS bytes를 임의로
  읽는 임시 production loader를 추가하지 않는다. Direct listener는 검증된 initial TLS server options를
  dependency로 받고, provider가 없으면 listener와 admin bind 전에 실패한다.
- 이유: canonical path, owner/mode, SAN, key pair, validity, expiry와 last-known-good reload를 일부만
  구현해 fail-closed 계약을 약화하지 않는다.
- 후속 조치: PI-04가 기존 Naru validator를 재사용 가능한 provider로 분리해 이 port에 연결한다. PI-05
  전에는 distribution이 direct config를 생성하거나 production에 활성화하지 않는다.

## PI-D014. Direct source는 TLS socket에서 차단하고 identity spoof는 인증 전에 거부한다

- 상태: accepted
- 결정: `direct-private-tls`는 validated source policy를 numeric IPv4 range matcher로 compile하고 TLS
  `secureConnection`의 실제 `remoteAddress`가 exact address/CIDR에 없으면 HTTP나 WebSocket dispatch
  전에 socket을 닫는다. IPv4-mapped IPv6, loopback, public·malformed address는 다른 address로
  normalize하지 않고 거부한다.
- header 경계: 모든 browser request는 exact Host와 제공된 exact Origin을 검사한다. Unsafe HTTP와
  WebSocket은 Origin을 필수로 하고, direct mode는 inbound forwarding, assertion과 reserved identity·
  capability header를 인증 전에 generic `REQUEST_INVALID`로 거부한다. Loopback compatibility와
  upstream sanitizer는 유지한다.
- bounded work: header 16 KiB·64 fields, header/request/keep-alive timeout, socket당 request 수와 기존
  body/WebSocket 상한을 명시한다. Authentication endpoint는 actual source당 20회/분, 전체 100회/분의
  bounded in-memory limit을 적용하며 기존 `BOOTSTRAP_DENIED`/`PASSKEY_DENIED` code로 429를 반환한다.
- 호환성: PrivateIngress와 Gateway browser public schema/version은 바꾸지 않는다. Source, Origin,
  spoofed header 값과 rate-limit key는 structured log에 기록하지 않는다.

## PI-D015. TLS 검증과 last-known-good 상태기계를 provider에서 분리한다

- 상태: accepted
- 결정: certificate/key의 canonical target, owner/mode/type/size, SAN, validity와 key pair 검증 및
  last-known-good secure-context 교체를 `@naru/tls-material`의 reusable state machine으로 둔다. Naru는
  기존 generation pointer provider를, Gateway direct ingress는 exact file reference provider를 사용한다.
- path 경계: approved root 자체는 canonical current-user private directory여야 한다. Gateway renewal
  reference는 symlink일 수 있지만 매 reload마다 최종 `realpath`가 approved root의 strict child인지 다시
  확인한다. Naru의 기존 generation publication은 symlink를 계속 거부한다.
- expiry 경계: valid candidate만 `setSecureContext`로 교체한다. last-known-good가 만료되면 readiness를
  내리고 새 raw connection을 TLS handshake 전에 닫되 기존 HTTPS/WSS와 Host runtime은 유지한다.
- 진단: browser readiness는 TLS boolean만 공개하고 owner-only admin readiness만 fingerprint, expiry,
  reload 상태와 stable error code를 제공한다. Structured log에는 raw path, Origin, IP, provider error,
  credential이나 TLS byte를 기록하지 않는다.
- 호환성: `PrivateIngressV0`, Gateway config v1/v2와 기존 Naru TLS environment/generation 형식은 바꾸지
  않는다. Distribution renderer와 production activation은 PI-05 이후에만 수행한다.

## PI-D016. Direct distribution은 additive v2 intent·receipt로 격리한다

- 상태: accepted
- 결정: 동결된 Workstation distribution v1 intent·receipt와 Tailscale Gateway config v1 renderer를
  계속 읽고 rollback한다. `direct-private-tls`는 완전한 `PrivateIngressV0`를 갖는 distribution
  v2 intent와 PI-05 receipt로만 생성하고 Gateway config v2를 render한다.
- 입력 경계: Origin, listener, source policy와 TLS reference는 command-line flag로 나누지 않고
  canonical owner-only private ingress file 하나에서 읽는다. v1 field와 혼합하거나 invalid v2를
  v1으로 fallback하지 않는다.
- approval: normalized private intent digest, operation, source commit, artifact/config identity,
  interface·DNS·TLS·listener와 package state fingerprint를 하나의 plan digest에 결합하고
  maintenance worker가 mutation 직전에 다시 검증한다.
- 진단: exact intent·receipt는 owner-only로 보존하고 일반 plan/status/doctor/result는 Origin,
  address, profile과 path를 redaction한다.

## PI-D017. Production source transition은 plan이 제시하고 operator가 별도 승인한다

- 상태: accepted
- 결정: PI-05 plan은 artifact의 exact source commit, manifest/payload digest와 Gateway config digest를
  `sourceTransition` target으로 제시하지만 production repository admission을 변경하지 않는다.
- 전환: operator-private repository identity와 exact target을 PI-07/PI-08에서 fresh approval로 결합한다.
  admission이 거부하면 manual stop/deploy/bootstrap으로 우회하지 않는다.
- rollback: pre-existing service, data와 source admission을 soak 종료 전까지 보존하고 실패 시
  package-owned candidate만 이전 immutable receipt와 listener로 복원한다.

## PI-D018. 완료된 legacy v1 maintenance request는 reconciliation에서만 읽는다

- 상태: accepted
- 배경: PI-07에서 기존 Workstation v1 test instance를 재사용하려 했지만, Private Ingress 도입 전에
  완료된 `current-request.json`에 새 `listenerPreflight` field가 없어 RC1 handoff가 mutation 전에
  fail-closed로 거부됐다.
- 결정: 다음 handoff는 field가 없는 distribution v1 request를 동일 `requestId`의 terminal
  `completed`/`failed` result와 대조하는 reconciliation 경계에서만 읽을 수 있다. 새 request 작성과
  maintenance worker 실행은 계속 `listenerPreflight`를 필수로 요구한다.
- migration: 기존 request/result를 직접 수정·삭제하지 않는다. RC1은 거부하고 이 compatibility와
  regression을 포함한 새 deterministic candidate를 전체 PI-06 gate로 다시 검증한다.
