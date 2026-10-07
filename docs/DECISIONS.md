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

## D011. Naru app base path는 명시적인 v1 계약이다

- 상태: 승인·T58 구현·로컬 검증·production 실사용 인수 완료
- `@naru/contracts/naru-app/v1`과 `NARU_APP_BASE_PATH`가 Naru의 canonical app base path를 정의한다.
  기존 intent·receipt에 값이 없으면 `/`로 읽고, 새 CLI-created distribution intent는 `/naru`를
  명시한다. `/`가 아닌 Naru는 Gateway가 prefix를 제거하는 managed mode에서만 허용하며 app-managed
  non-root 구성은 fail closed한다.
- Web release는 HTML의 단일 `naru-app-base-path` metadata에서 API·WebSocket·manifest·service worker·
  push target을 파생한다. Service worker scope와 cache namespace는 app path별로 격리하고 Gateway-owned
  `/_gateway/*`는 root에 유지한다.
- Gateway root `/`는 enabled root app이 없을 때 인증된 app dashboard를 제공하고, 기존 root app이
  있으면 그 app의 우선권을 유지한다. `/_gateway/apps` dashboard는 두 구성에서 모두 유지한다.
  Root app을 non-root로 옮긴 뒤에는 인증된 root retirement worker가 과거 Naru root worker와 root
  cache만 회수하며 다른 app scope/cache를 건드리지 않는다.
- Reconfigure와 rollback은 Gateway route, Naru env/config, web release metadata와 receipt의 exact app
  path를 함께 이동·복원한다. 기존 실제 browser profile의 worker migration과 설치 PWA·운영 instance
  인수는 별도 승인 경계로 수행했으며, T58을 포함한 production 배포 뒤 Gateway와 설치 PWA의 지속적
  실사용 확인으로 2026-09-24에 완료 수용했다.

## D012. Codex의 간접 endpoint는 고정된 보호 소켓만 가리킨다

- 상태: T59 endpoint 구현·직접/간접 소켓 및 실제 CLI 기본 인수 완료, 운영 적용 전
- `rust-v0.156.1`의 `codex-rs/uds/src/daemon_directory.rs`와
  `codex-rs/app-server-transport/src/transport/unix_socket.rs`를 확인했다
  (source commit `b412ff32c417f855c2b2d1581b77058eed87c84b`). Foreground `app-server --listen`
  역시 사용자별 보호 디렉터리의 소켓을 사용한다. 공유되는 것은 디렉터리이며, listener와 프로세스는
  요청한 canonical endpoint별로 분리된다. 명시적인 daemon start/stop 명령은 사용하지 않는다.
- Naru가 만든 canonical owner-only 임시 디렉터리의 endpoint에 직접 소켓이 있으면 기존 방식으로
  연결한다. 링크인 경우에는 `realpath("/tmp")/codex-daemon-<effective uid>/SHA256(endpoint)`와
  정확히 일치하는 absolute 단일 링크만 허용한다. 보호 디렉터리는 same-user `0700`, 최종 대상은
  canonical same-user 실제 소켓 `0600`이어야 한다. 다른 대상·중간 링크·체인·순환은 거부한다.
- 구버전의 bind 직후 `0700` → `0600` 권한 공개 구간을 readiness로 오인하지 않도록 첫 entry를
  관찰한 다음 한 polling 간격을 기다린다. 이 구간에는 연결하지 않고, 이후 엄격한 정책 위반은
  재시도하지 않는다. fixture와 실제 0.154.0에서 해당 전환을 확인했다.
- 검증한 물리 경로에 연결하고, 매 연결 직전과 연결 직후에 alias·private directory·socket의
  device/inode/owner/mode를 다시 확인하고 alias·socket의 change-time도 비교한다. 교체된 endpoint로
  자동 재연결하지 않는다. root-owned sticky system temporary directory는 검증하되 다른 정상
  프로세스나 Pane이 파일을 만들 때 바뀌는 directory timestamp는 고정하지 않는다.
- 신뢰 경계는 기존과 동일한 OS 사용자다. 예상 peer는 Naru가 생성한 무작위 private endpoint와
  그 경로의 고정 hash, owner/mode 및 WebSocket handshake로 결합한다. Node의 portable UDS API는
  peer PID를 인증하지 않으므로 악성 same-UID process에 대한 격리나 완전한 TOCTOU 제거를 주장하지
  않는다. 다른 UID의 교체는 private directory와 sticky system ancestor로 차단한다.
- D009의 guardian 자식 소유권을 유지한다. Naru는 전역 daemon 종료·공유 directory 삭제·Codex가
  소유한 alias/physical socket 삭제를 하지 않는다. Codex 자신의 socket guard가 종료 시 회수한다.
- 실패는 제한된 `NARU_CODEX_*` 코드로 기존 PTY 출력 경로에 표시한다. 원문 stderr와 private path는
  출력·구조화 로그에 추가하지 않는다. Host의 runtime/generation fencing이 늦은 오류 출력을 격리하며
  private IPC 및 Core/Host public protocol은 변경하지 않는다.
- 새 launcher부터 적용하며 구 runtime은 변경하지 않는다. 패키지 배포는 Host payload 변경으로
  세 runtime 재시작을 수반할 수 있고 PTY 연속성을 보장하지 않는다. 지원 버전은 실제 인수 결과로
  한정하며 이후 버전의 동일한 파일 형태만으로 전체 protocol 호환을 주장하지 않는다.

## D013. Codex 기본 transcript 모드와 협상된 mouse encoding을 유지한다

- Codex의 alternate screen을 끄거나 별도 transcript UI로 대체하지 않는다. 실제 CLI 0.157.1의
  native transcript는 alternate screen과 mouse tracking을 사용하므로 일반 terminal scrollback과
  달리 휠을 PTY 입력으로 전달해야 한다.
- xterm serialize addon이 누락하는 DEC mouse encoding 1006/1016을 public parser hook으로 추적하고
  Host 및 legacy PTY snapshot 끝에 복원한다. tracking mode는 기존 serializer가 담당한다.
  분할된 escape sequence도 emulator parser가 처리하며 reset과 mode 해제도 반영한다.
- alternate screen에서 tracking이 활성화된 터치는 xterm wheel event로 변환한다. 좌표와 encoding은
  xterm이 결정하며, 일반 shell의 local scrollback·선택·focus 동작은 유지한다. SGR mouse report는
  문자 입력용 Ctrl/Alt modifier나 live-tail 이동을 적용하지 않는다.
- mouse report도 기존 attachment/controller generation fence를 통과한다. observer는 공유된 Codex
  viewport를 입력으로 바꿀 수 없다. 독립적인 observer transcript 탐색은 이번 범위가 아니다.
- wire schema와 protocol version은 변하지 않는다. 기존 client도 표준 escape sequence를 읽을 수
  있으므로 데이터 migration은 없다. 실행 중 구 Host는 자동 교체하지 않으며, 운영 적용은 별도
  승인된 배포·Host restart가 필요하고 기존 PTY의 연속성을 보장하지 않는다.
