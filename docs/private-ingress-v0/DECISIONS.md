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
