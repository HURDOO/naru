# Naru 결정 기록

## D001. PTY는 DurableSession Host가 소유한다

- 상태: 승인
- Naru와 Gateway lifecycle에서 PTY를 분리한다. Host restart 뒤에는 process persistence를 주장하지 않는다.

## D002. controller는 정확히 하나다

- 상태: 승인
- observer는 read-only이며 request, handoff 또는 explicit preempt가 generation을 바꾼 뒤에만 input과
  authoritative resize를 허용한다.

## D003. Gateway, application과 Host 권한을 분리한다

- 상태: 승인
- Gateway session/assertion, Naru resource authorization과 Host app capability는 서로 대체할 수 없다.

## D004. 공개 저장소는 clean allowlisted snapshot으로 시작한다

- 상태: 승인·완료
- private history, 실제 instance topology와 운영 evidence를 복사하지 않는다. 공개 source에는 generic
  fixture와 재현 가능한 privacy scan을 둔다. Remote 추가와 push는 별도 승인이다.

## D005. Private Ingress는 Gateway listener adapter다

- 상태: 승인·PI-03 source/request 경계 구현 완료
- `loopback-proxy`와 `direct-private-tls`를 strict union으로 분리한다. Direct mode는 exact private bind,
  TLS, 실제 socket source와 exact Host/Origin을 Gateway에서 검증하고 forwarded identity를 인증 전에
  거부한다.

## D006. 외부 network와 TLS material은 사용자 소유다

- 상태: 승인·PI-04 검증/lifecycle 구현 완료
- Package는 DNS, VPN, route, firewall과 certificate 발급·갱신을 임의 변경하지 않는다. Gateway는 승인된
  material을 검증하고 last-known-good reload만 수행한다.

## D007. 공개 source 전환과 production operator 전환을 분리한다

- 상태: 승인
- 새 public repository에서 feature development를 시작해도 기존 production source/admission은 별도
  cutover 승인 전까지 바꾸지 않는다.

## D008. Naru 이름과 license

- 상태: 승인
- 제품 이름은 Naru, source license는 Apache-2.0이다. Third-party runtime과 font license를 artifact에
  함께 보존한다.
