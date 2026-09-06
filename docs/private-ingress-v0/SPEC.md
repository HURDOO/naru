# Private Ingress v0 제품 계약

## 1. 상태와 기준

- 상태: PI-03 source·Origin·header 보안 완료, PI-04 구현 승인 전
- 다음 작업: `private-ingress-v0/PI-04`
- 단일 작업 원장: [`TASKS.md`](TASKS.md)
- 보안 분석·ownership: [`THREAT_MODEL.md`](THREAT_MODEL.md)
- 선행 기준: 동결된 DurableSession / Workstation v0와 현재 Naru 동작
- 목표 운영 경로: operator가 관리하는 private DNS·trusted LAN·WireGuard와 canonical HTTPS Origin에서
  Naru를 gateway-managed DurableSession runtime으로 운영

이 계약은 완료된 Workstation v0 계약을 소급 수정하지 않는다. Workstation v0가 정의한
`wireguard-direct`, `trusted-lan`, `direct-private-listener`, `tlsOwner`의 미구현 운영 경계를
additive `PrivateIngressV0`로 구체화한다.

## 2. 목표

1. Gateway가 WireGuard 또는 승인된 LAN에서 들어오는 HTTPS/WSS를 exact private listener로 직접 받는다.
2. Gateway가 실제 socket source, TLS, exact Origin, Passkey/session/CSRF와 WebSocket을 한 경계에서 검증한다.
3. Naru는 exact loopback HTTP upstream으로만 실행하고 Gateway의 signed principal을 검증한다.
4. DurableSession Host는 private UDS에서 PTY, runtime, sequence와 control을 계속 소유한다.
5. WireGuard, DNS, certificate 발급·갱신은 사용자 소유 외부 상태로 남기고 package가 임의 변경하지 않는다.
6. 공개 저장소에는 실제 사용자 경로·domain·IP·tailnet·credential·운영 이력을 넣지 않는다.

## 3. 구성 계약

```ts
interface PrivateIngressV0 {
  readonly contractVersion: "private-ingress.v0";
  readonly profileId: string;
  readonly kind: "direct-private-tls";
  readonly network: "wireguard-direct" | "trusted-lan";
  readonly browserOrigin: string;
  readonly listener: {
    readonly host: string;
    readonly port: number;
  };
  readonly tls: {
    readonly approvedRoot: string;
    readonly certificateFile: string;
    readonly privateKeyFile: string;
    readonly reload: "watch-last-known-good";
    readonly materialOwner: "user";
    readonly renewalOwner: "user" | "external";
    readonly terminationOwner: "gateway";
  };
  readonly sourcePolicy: {
    readonly mode: "private-ipv4-allowlist";
    readonly allowedAddresses: readonly string[];
    readonly allowedCidrs: readonly string[];
  };
}
```

실제 instance 값은 저장소 밖 사용자 소유 private intent/config에만 둔다. 공개 fixture는 식별되지
않는 예시만 사용하며 실제 운영값의 복사본을 두지 않는다.

## 4. 보안 불변조건

- `browserOrigin`은 path·query·fragment가 없는 단일 exact HTTPS Origin이어야 한다.
- v0 production listener는 활성 local interface의 exact private IPv4만 허용한다.
- `0.0.0.0`, `::`, public address, 임의 hostname bind와 plain HTTP를 거부한다.
- source policy는 canonical RFC1918 exact IPv4와 RFC1918 내에 완전히 포함된 canonical IPv4
  CIDR를 명시적으로 허용한다. 최소 한 항목이 필요하고 duplicate, overlap, CIDR에 포함된
  redundant exact address를 거부한다.
- public·wildcard·IPv6 address/CIDR, host bit가 있는 non-canonical CIDR와 forwarded address 추론을
  거부한다. CIDR admission은 network source 범위일 뿐 user identity가 아니다.
- private ingress는 authentication이 아니다. 네트워크를 통과해도 Gateway Passkey/session이 필수다.
- direct mode는 실제 socket address만 사용하고 inbound `Forwarded`, `X-Forwarded-*`, Gateway identity·
  assertion header를 인증 전에 제거하거나 거부한다.
- Naru upstream은 exact `127.0.0.1` HTTP, Host 연결은 owner-only private UDS만 허용한다.
- certificate/key/config 경로는 `realpath`로 정규화하고 approved root, regular-file, owner와 mode를
  다시 검사한다. symlink 자체가 아니라 최종 canonical target이 경계 안인지 판정한다.
- certificate SAN, 유효기간과 key pair가 Origin hostname에 맞지 않으면 시작하지 않는다.
- cookie, authorization, Passkey 자료, request/response body, terminal input/output과 환경값을 로그에
  기록하지 않는다.
- public DNS address record, public listener, router port forwarding은 v0 private profile과 양립하지
  않는다. 자동으로 변경하지 않고 doctor가 fail-closed 또는 명시적 blocked 상태로 보고한다.

## 5. TLS lifecycle

- 시작 시 유효한 TLS material이 없으면 listener를 열지 않는다.
- 실행 중 새 material은 완전히 검증한 뒤 새 handshake에만 적용한다.
- reload 후보가 잘못되면 in-memory last-known-good context를 유지하고 기존 HTTPS/WSS·PTY를 끊지 않는다.
- reload 실패는 비밀 없는 상태로 보고하고 main service restart를 유발하지 않는다.
- last-known-good certificate까지 만료되면 readiness를 내리고 신규 TLS 연결을 안전하게 거부한다.
- package는 certificate를 발급·갱신하거나 DNS provider credential을 읽지 않는다.

## 6. Redaction과 receipt digest

- Private intent와 owner-only receipt는 exact Origin, listener, source policy와 TLS path reference를 가질 수
  있지만 public source, structured log, public error와 diagnostic projection에는 이 값을 남기지 않는다.
- Diagnostic projection은 profile, Origin, listener, TLS path를 고정 redaction marker로 바꾸고 source
  address/CIDR는 개수만 보고한다. TLS ownership과 reload mode는 비밀이 아니므로 유지한다.
- Intent digest는 strict schema를 통과한 값에서 source address/CIDR를 numeric order로 정렬한 뒤,
  `{ purpose: "naru.private-ingress.intent.v0", ingress }`를 object key lexical order·array order 보존
  canonical JSON으로 encoding하고 UTF-8 SHA-256 lowercase hex로 계산한다.
- Digest는 private path/topology reference를 결합하지만 preimage는 로그하지 않는다. PI-05의
  plan/receipt는 이 intent digest와 operation, artifact/config identity, actual state fingerprint를 함께
  결합해 stale approval을 거부한다.

## 7. 운영 명령

`plan`, `apply`, `status`, `doctor`, `reconfigure`, `rollback`을 제공한다.

- `plan`: 완전한 read-only preflight와 redacted digest를 만든다.
- `apply`: 승인된 package-owned config, immutable release와 LaunchAgent만 설치한다.
- `status`: 현재 receipt, listener와 component 상태를 비밀 없이 보고한다.
- `doctor`: HTTPS → Gateway → Naru → Host의 실제 chain을 검사한다.
- `reconfigure`: Origin, port, TLS reference 또는 source policy 변경을 새 승인 receipt로 적용한다.
- `rollback`: package-owned listener/config/release만 이전 receipt로 되돌린다.

어떤 명령도 WireGuard peer, DNS, router, firewall, certificate 발급 상태나 다른 profile의 자원을
임의로 변경하지 않는다.

## 8. 공개 저장소 계약

새 공개 저장소는 기존 `.git` 이력이나 raw checkout 복사가 아니라 allowlist 기반 clean snapshot으로
시작한다. 첫 commit 전에 다음을 만족해야 한다.

- 실제 path/domain/IP/hostname/account와 운영 evidence 부재
- `.env`, credential, DB, log, build artifact와 private intent 부재
- 공개용 `README`, `SECURITY`, `CONTRIBUTING`, architecture/self-hosting 문서
- strict TypeScript, Node 24, pnpm과 표준 검증 진입점 유지
- full-history가 없는 새 Git repository와 전용 secret/privacy scan
- 원격 push는 별도 사용자 승인과 GitHub account 선택 뒤에만 수행

Source repository에는 migration 전 배포의 위치, 이름, receipt나 rollback 자료를 기록하지 않는다.
Pre-existing deployment가 있다면 operator-private inventory에서 cutover·soak가 끝날 때까지 보존한다.

## 9. 범위 제외

- WireGuard 설치·peer·route·DNS·router·firewall 자동 구성
- IPv6 source/listener, public source/network와 public internet hosting
- generic third-party runtime plugin loading 또는 marketplace
- multi-user, RBAC, concurrent writer
- automatic certificate issuance/provider integration
- current production 삭제·rename 또는 공개 remote push
- PrivateIngress 작업에 포함되지 않은 Naru UI backlog 자체의 일괄 구현
- 하나의 instance에서 여러 browser ingress/Origin을 동시에 active로 운영하는 multi-ingress; 이는
  v0 이후 PI-10에서 별도 versioned contract와 migration으로 다룬다.

## 10. 완료 조건

1. contract/schema와 정상·거부 fixture가 구현에 앞서 고정된다.
2. loopback-proxy와 direct-private-tls가 명시적 mode로 분리되고 implicit fallback이 없다.
3. negative security matrix와 HTTP/WSS/actual PTY continuity 검증을 통과한다.
4. Production과 분리된 candidate private Origin에서 actual WireGuard/LAN acceptance를 통과한다.
5. pinned release, backup과 tested rollback 아래 canonical port cutover를 수행한다.
6. Pre-existing deployment가 있다면 3~7일 soak와 별도 operator 승인 전에는 삭제하지 않는다.
