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

## D009. Codex interaction은 Host 소유 transport의 request lifecycle로 판정한다

- 상태: 승인·T53 구현·검증 완료
- Codex hook의 `PermissionRequest`는 일부 승인 전에만 오고 `PostToolUse`는 도구 완료 뒤에 오므로,
  응답 직후 해소와 비차단 질문의 미응답 상태를 보장하지 못한다. 새 Host-owned Codex runtime은 기존 PTY
  launcher 안에 guardian·private WebSocket relay를 두고 TUI↔app-server message를 그대로 중계한다.
- relay는 실제 request ID별 pending과 `serverRequest/resolved`를 현재 user thread에서만 추적해
  signed current-runtime redacted snapshot으로 Naru에 전달한다. 서명·cwd·runtime·sequence 검증은
  기존 Naru integration 경계 안에 둔다. UI·Project·push는 기존 activity 경로를 사용한다.
- Naru/Gateway restart는 TUI/app-server를 재시작하지 않는다. guardian이 launcher의 hard death를
  감지해 child를 회수한다. 기존 hook-only runtime은 변경 없이 종료될 때까지 유지하고 새 runtime부터
  relay를 적용한다. Core/Host public protocol과 service install은 바꾸지 않는다.
- 원격 TUI의 `/resume` picker는 보조 WebSocket 연결로 `thread/list`를 읽고, 선택 뒤 기본 연결에서
  `thread/resume`을 보낸다. relay는 연결별 request ID를 분리하고 보조 연결 종료로 기본 세션을
  종료하거나 pending을 지우지 않는다. 원격 재개가 permission override를 거절하므로 프로필의
  `workspace-write`·`on-request`는 app-server 설정으로 전달하고 TUI 인수에서는 제거한다. 격리된
  실제 CLI에서 app-server 인수와 재개 후 승인 요청으로 정책 경로를 확인했으며, protocol의 권한
  metadata 필드를 직접 검증한 것은 아니다.
- `codex-cli 0.154.0`의 실험적 `--remote`와 app-server UDS 조합을 실제 fake model/MCP로 인수했다.
  다음 CLI 버전은 같은 protocol/lifecycle 확인 뒤 적용하며, 미지원 버전으로 기존 runtime을 강제
  전환하지 않는다. Naru private integration IPC에 redacted snapshot 메시지를 additive하게 추가했고
  launcher·서버를 함께 배포한다. 기존 hook-only consumer/runtime은 이 메시지를 보내지 않는다.
- 실제 Chrome 권한은 실행하지 않고 fake Chrome MCP의 elicitation lifecycle로 검증했다. 비차단
  질문의 request lifecycle은 검증했으나 Alt+Up 제스처 자체는 별도로 검증하지 않았다.
- browser는 열린 Workspace와 다른 Project의 activity frame도 Pane revision·event identity로 거르고,
  HTTP Project refresh 중 수신한 frame을 재적용한다. 현재 public Project activity에 전역 revision이
  없으므로 서로 다른 Pane 이벤트의 절대 순서는 activity timestamp로만 비교한다. 시계 역행이나
  동일 timestamp의 교차 Pane 경계는 다음 public contract version에서 전역 순서를 추가해야 완전히
  보장할 수 있다.

## D010. 자동 승인 심사는 사용자 입력 필요로 표시하지 않는다

- 상태: `codex-cli 0.154.0` 범위 검증 완료, T54의 후속 버전·구 runtime migration은 열려 있음
- D009의 실제 미해소 request 기준을 자동 심사에 적용한다. `item/autoApprovalReview/started`·
  `completed`는 사용자 승인 RPC가 아닌 notification이다. 심사 진행 중이나 자동 승인·거절·시간 초과·
  중단 뒤에도 pending을 만들거나 다른 미해소 요청을 지우지 않는다. hook의 자체 승인도 사용자 RPC
  없이 끝난다. 실제 `requestApproval`이 발행된 경우에만 입력 필요로 표시하고
  `serverRequest/resolved`에서 그 request ID를 해소한다.
- 이 구분은 [0.154.0 고정 approval routing](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/approvals.rs)과
  [app-server event mapping](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/bespoke_event_handling.rs),
  해당 버전의 generated experimental schema 및 상태·integration 회귀 테스트로 확인했다.
  자동 심사를 fake CLI에서 직접 발생시키는 acceptance는 수행하지 않았다.
- 후속 CLI의 실험적 notification/request protocol이 달라지면 그 버전의 source/schema와 격리 인수를
  다시 확인한다. 기존 hook-only runtime의 stale 표시 한계는 T54 migration에서 별도로 다룬다.
