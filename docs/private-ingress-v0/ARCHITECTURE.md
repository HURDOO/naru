# Private Ingress v0 기술 아키텍처

## 1. 구조

```text
LAN / WireGuard browser
        |
        | exact private HTTPS/WSS
        v
+--------------------------------------+
| Workstation Gateway                  |
| direct-private-tls listener adapter  |
| source IP / TLS / Origin / auth      |
+------------------+-------------------+
                   | exact loopback HTTP
                   v
+--------------------------------------+
| Naru App Server/Web                  |
| GatewayPrincipal verifier            |
+------------------+-------------------+
                   | app credential + scoped caller
                   v
+--------------------------------------+
| DurableSession Host                  |
| private UDS, PTY/runtime/sequence     |
+--------------------------------------+
```

별도 reverse-proxy process를 v0 필수 구성으로 추가하지 않는다. 현재 Gateway의 loopback browser
listener를 discriminated listener adapter로 확장해 direct mode에서는 Gateway가 TLS와 실제 client
socket을 직접 소유한다. 이로써 trusted proxy와 forwarded client identity라는 새 신뢰 경계를 만들지
않는다.

## 2. listener adapter

```ts
type GatewayIngressV0 =
  | {
      readonly kind: "loopback-proxy";
      readonly network: "tailscale-serve" | "trusted-proxy";
      readonly listenHost: "127.0.0.1";
      readonly listenPort: number;
    }
  | PrivateIngressV0;
```

- `loopback-proxy`는 동결된 Tailscale Serve happy path를 보존한다.
- `direct-private-tls`는 WireGuard/trusted LAN의 first-party adapter다.
- 한 instance는 하나의 `canonicalBrowserOrigin`과 하나의 active browser listener를 가진다.
- Inventory에는 두 mode의 profile을 모두 보존할 수 있지만 v0 runtime selection은 정확히 하나다.
- mode별 forbidden field를 strict schema로 거부하고 자동 fallback하지 않는다.
- Gateway private config v2는 `browserIngress: GatewayIngressV0`를 하나만 요구한다. 기존 config v1은
  explicit legacy loopback adapter로 계속 읽지만 direct mode로 추론하거나 변환하지 않는다.
- PI-02의 direct adapter는 이미 검증된 initial TLS server options를 주입받는다. Provider가 없으면
  bind 전에 실패하며, path·owner·SAN·expiry 검증과 last-known-good reload provider는 PI-04에서 연결한다.

예상 코드 경계:

```text
packages/contracts/src/private-ingress/v0/index.ts
packages/contracts/src/private-ingress/v0/test-vectors.ts
apps/workstation-gateway/src/config.ts
apps/workstation-gateway/src/listeners/loopback-http.ts
apps/workstation-gateway/src/listeners/direct-private-tls.ts
apps/workstation-gateway/src/listeners/tls-material.ts
apps/workstation-gateway/src/listeners/source-policy.ts
apps/workstation-gateway/src/ingress/doctor.ts
```

기존 Naru TLS manager의 검증·last-known-good 동작은 production-specific 상수와 ACME provider 책임을
제거한 뒤 재사용 가능한 모듈로 옮긴다. app-managed Naru와 gateway-managed Naru가 같은 external
listener를 동시에 소유하지 않는다.

## 3. ownership

| 자원                                | 소유자                  | package 동작                           |
| ----------------------------------- | ----------------------- | -------------------------------------- |
| private DNS·WireGuard·route         | user                    | inspect/doctor only                    |
| certificate/key material·renewal    | user/external job       | validate/read/hot reload only          |
| TLS termination·listener            | Gateway package         | plan/apply/status/reconfigure/rollback |
| Passkey/session/Origin/CSRF/WS auth | Gateway                 | fail-closed enforcement                |
| Project/Pane/app authorization      | Naru                    | signed principal 검증 후 처리          |
| PTY/runtime/terminal state          | DurableSession Host     | private app credential로 처리          |
| production-specific values          | private instance config | public source/history에 기록 금지      |

`tlsOwner`라는 단일 표현은 termination, material과 renewal ownership을 충분히 설명하지 못하므로
PrivateIngress config에서 세 책임을 분리한다. Workstation v0 envelope 자체는 변경하지 않는다.

## 4. request path

1. Gateway가 exact local private address에서 TLS handshake를 수행한다.
2. handshake 전에 유효한 current secure context가 없으면 연결을 수락하지 않는다.
3. 실제 socket source가 명시적 exact IPv4 또는 canonical private IPv4 CIDR allowlist에 없으면
   TLS `secureConnection`에서 socket을 응답 없이 닫아 정적 asset을 포함한 모든 request와 upgrade를
   거부한다. IPv4-mapped IPv6를 IPv4로 추론하지 않는다.
4. 모든 request의 exact Host와 제공된 Origin을 검사하고, unsafe HTTP와 WebSocket에는 Origin을
   요구한다. Direct mode의 inbound proxy·identity header는 인증 전에 거부하며 loopback mode와
   upstream에는 기존 sanitizer를 방어 심층화로 유지한다.
5. Gateway Passkey/session/CSRF 또는 WebSocket upgrade auth를 검증한다.
6. Gateway cookie를 제거하고 short-lived app-scoped signed principal을 만든다.
7. exact loopback Naru upstream으로 HTTP 또는 WebSocket을 전달한다.
8. Naru verifier와 app authorization을 통과한 요청만 Host caller context를 얻는다.

IP/CIDR allowlist는 user identity가 아니며 Passkey를 생략하거나 Gateway principal capability가 되지
않는다. CIDR membership도 inbound forwarding header가 아닌 actual socket remote address로만 판정한다.

Browser listener는 header 16 KiB·64 fields, header receipt 5초, request receipt 30초, keep-alive 5초와
socket당 100 request 상한을 고정한다. 기존 configured HTTP body limit, WebSocket 4 MiB payload와
1 MiB/64-message pending queue도 유지한다. Passkey/bootstrap endpoint는 실제 socket source당 분당
20회, 전체 분당 100회로 제한하고 source bucket을 bounded memory에만 둔다. 제한 결과는 기존 generic
browser failure code를 사용하며 source나 header 값을 log하지 않는다.

## 5. lifecycle과 health

- browser listener와 admin UDS를 분리한다.
- admin status/receipt는 owner-only local 경계에만 둔다.
- liveness는 process 생존, readiness는 config/listener/TLS/upstream/profile 일치를 판정한다.
- TLS reload는 candidate를 별도 parse·verify한 뒤 secure context를 원자 교체한다.
- invalid reload는 current context와 connection을 유지하고 redacted degraded state를 남긴다.
- Gateway/Naru restart는 Host-owned PTY를 종료하지 않는다.
- Host restart 뒤 process continuity를 주장하지 않고 Session을 honest stopped로 복구한다.

## 6. transaction과 rollback

```text
private intent
  -> read-only plan + digest
  -> user approval
  -> immutable candidate/config
  -> ownership/port/cert/upstream preflight
  -> launch
  -> local readiness
  -> private HTTPS/WSS doctor
  -> immutable receipt
```

apply 실패는 package-owned candidate만 정리하거나 이전 receipt로 복귀한다. DNS, WireGuard,
certificate generation과 legacy service를 자동 수정하거나 제거하지 않는다. canonical port cutover는
기존 service backup·active PTY 확인·독립 rollback 경로가 준비된 별도 production 승인 작업이다.

## 7. Public source와 private instance state

```text
public Naru repository
  - clean allowlisted source and history
  - DurableSession/Gateway/Naru source and tests
  - generic contract/security/self-hosting docs
  - no real instance values or production evidence

operator-private state
  - runtime intent/config, credentials and database
  - certificate, receipt, logs and release evidence
  - optional pre-existing deployment rollback inventory
```

Feature development와 release candidate는 public repository의 worktree에서 수행한다. Runtime config와
acceptance evidence는 source 밖 operator-owned 경계에 둔다. Source commit을 준비하거나 공개하는 행위는
production operator가 그 commit을 허용하거나 service를 변경한다는 뜻이 아니다.

PI-05는 generic distribution·maintenance 계약과 source transition 검증 절차를 제공한다. Production
tooling은 exact repository, commit과 artifact를 별도로 승인해야 하며 admission이 맞지 않으면 manual
stop/deploy로 우회하지 않는다.

## 8. 병렬 개발 구조

`PI-00`은 기준선 이동 작업이므로 단독으로 끝낸다. 완료 뒤 새 public repository에서 다음 lane을
병렬로 운용할 수 있다.

| lane        | primary scope                                  | 시작 gate                             |
| ----------- | ---------------------------------------------- | ------------------------------------- |
| Ingress     | contracts, Gateway, distribution               | PI-00 완료 후 PI-01                   |
| Mobile UI   | `apps/web` terminal/input UI                   | PI-00 완료 후 T52 또는 선택한 한 작업 |
| Activity    | Naru server/web Codex lifecycle                | PI-00 완료 후 T53                     |
| Integration | root config, lockfile, shared docs, merge gate | 항상 단일 owner                       |

Mobile UI lane의 T29/T44/T46/T48/T52는 같은 terminal surface와 E2E를 많이 공유하므로 lane 안에서는
한 번에 하나만 구현한다. Activity lane은 T53 계약을 먼저 고정한 뒤 T54를 합친다. T55는 T53뿐
아니라 PI-05의 새 distribution/maintenance 경계까지 완료된 뒤 시작한다.

PI-07 actual staging이 시작되면 pinned release branch를 freeze한다. 다른 worktree 개발은 계속할 수
있지만 PI-08 cutover가 끝날 때까지 release branch에 merge하거나 production에 배포하지 않는다.
