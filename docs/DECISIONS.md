# Naru 결정 기록

## D018. Claude fullscreen 터치 스크롤은 협상된 mouse 입력으로 전달한다

- 상태: T68 격리 fixture 검증 완료, 운영 적용 전
- Claude fullscreen의 alternate buffer는 native terminal scrollback 대신 CLI가 대화 viewport를
  소유한다. Naru는 해당 buffer에서 mouse tracking이 활성화됐을 때만 모바일 수직 드래그를 xterm의
  wheel 경로로 전달한다. normal buffer와 mouse mode off는 기존 local scrollback을 유지한다.
- xterm serializer가 복원하지 않는 DEC mouse encoding 1006/1016만 Host와 standalone PTY의
  public parser hook에서 추적해 snapshot에 더한다. tracking mode는 기존 serializer에 맡기고,
  같은 sequence barrier와 state 상한을 적용한다. public event schema/version과 DB migration은 없다.
- wheel report도 기존 attachment/controller generation fence를 통과한다. observer의 터치는 PTY
  입력이 되지 않는다. 입력이 아닌 mouse report는 live tail 이동·모바일 modifier 소비를 일으키지
  않는다. `/tui default` 렌더링과 CLI 설정을 임의 변경하지 않는다.
- 새 Host 코드 적용은 별도 immutable release와 승인된 Host restart가 필요하다. 이미 실행 중인 PTY
  연속성은 보장하지 않으며, 실제 모바일·Claude 인수 전에는 운영 동작을 해결했다고 주장하지 않는다.

## D017. 별도 Gateway 앱의 Claude PTY와 작업 상태는 독립 Host가 소유한다

- 상태: T67 구현 중. 기존 Gateway 아래 별도 앱 선택은 사용자 확인 완료; 운영 변경은 아직 하지 않는다.
- 별도 Claude Naru는 기존 Gateway의 canonical Origin·Passkey session을 공유하되 독립 app assertion
  audience, private data, Host credential, Host socket와 launchd namespace를 사용한다. 기존 운영 Host와
  Naru DB는 공유하거나 재시작하지 않는다. Gateway route는 WV0-D011의 승인된 intent로만 추가한다.
- Claude Host profile은 직접 CLI가 아닌 package-owned launcher를 시작한다. Host가 서명한
  current Session/runtime/cwd/profile/bootstrap과 Naru DB의 Pane binding을 양쪽에서 확인한 뒤
  canonical Claude 실행 파일을 시작하고 관측 훅을 주입한다. 훅은 lifecycle 종류·session ID·cwd만
  owner-only integration socket으로 보내고 원문은 전송·저장하지 않는다.
- Naru/Gateway 재시작은 Host PTY를 종료하지 않는다. Host 재시작은 Session을 stopped로 복구한다.
  기존 Claude runtime은 새 훅을 소급 주입하지 않고, 새 runtime부터 적용한다. Host public protocol과
  Codex integration의 기존 wire 형식은 유지하며 private Naru integration에 additive 메시지만 더한다.
- 별도 앱 설치·Gateway reconfigure·source admission·필요한 DB backup은 각각 정확한 plan과 승인으로
  실행한다. 완료된 D013/D016 standalone 계약과 운영 기본 Naru 설정은 소급 변경하지 않는다.
- 별도 instance intent의 `externalGateway`와 `defaultAgentPaneKind`는 optional additive field다.
  기존 intent/receipt는 로컬 Gateway·Codex 기본값으로 해석하고 schema version은 유지한다.
  외부 binding은 v1 ingress none·non-root route에만 허용하며, 독립 Host credential과 subject는
  외부 Gateway assertion subject와 섞지 않는다. 제거·rollback은 선택된 receipt의 binding을 복원한다.
  현재 distribution은 새 instance의 loopback 내부 Gateway job도 관리하지만 브라우저·Passkey route는
  기존 Gateway만 사용한다. 이 job의 제거는 별도 lifecycle migration으로 남긴다.

## D016. Claude 작업 상태는 분리된 관측 훅으로 반영한다

- 상태: T66 로컬 구현·검증 완료, 실행 중인 9443·운영 배포 범위 밖
- Claude Code `UserPromptSubmit`·`PermissionRequest`·`Notification`·`PostToolUse`·
  `PostToolUseFailure`·`PermissionDenied`·`Stop`·`StopFailure`·`SessionStart`·`SessionEnd`
  훅에서 redacted lifecycle 신호만 받는다. 훅은 Claude의 permission·stop 결정을 바꾸지 않고,
  프롬프트·도구 payload·terminal/transcript 원문은 전송·저장·로그하지 않는다.
- Pane/runtime별 짧은 수명 capability와 owner-only UDS, session identity·cwd 검사로 오래된
  신호를 차단한다. 기존 Codex 훅·relay 의미, 기본 Pane/DB schema, production Host profile은
  변경하지 않는다. 실제 승인 응답 시점은 훅으로 직접 관측할 수 없으므로 후속 도구 이벤트에서
  `interaction-required`를 해제하며, 동시 승인 요청의 정확한 개수는 주장하지 않는다.
- 이 단계는 standalone Naru의 opt-in Claude Pane 상태를 구현한다. Durable Host의 Claude
  통합 및 실제 9443 적용은 별도 계약·배포 승인 이후로 둔다.
- 기존 `PaneActivity` 값과 WebSocket 형식을 재사용하므로 public schema·DB migration은 없다.
  새 배지를 보여 주는 Web consumer와 서버는 함께 빌드해야 한다. 기존 Claude runtime은
  재시작 전까지 훅이 없으며, 이 변경만으로 자동 재시작하지 않는다.

## D015. 격리 9443의 Cheers 연결 worktree 두 루트만 확장한다

- 상태: T65 격리 9443 구현·검증 완료, 운영 적용 범위 밖
- 사용자 승인에 따라 격리 비밀번호 서버의 기존 exact Cheers Project root는 유지하고,
  그 상위 coding 디렉터리 아래의 `worktree`와 `worktrees` 형제 디렉터리만 추가한다.
  두 새 root 자체는 Project가 아니며 각 root의 strict child만 등록할 수 있다. 상위 coding
  디렉터리 전체, symlink escape, 다른 형제 디렉터리는 허용하지 않는다.
- 이 범위는 격리 서버의 owner-only 설정에서만 활성화된다. Public API·DB migration은 없고,
  테스트 Naru만 재시작한다. 운영 Host·Naru·Gateway 설정과 프로세스는 변경하지 않는다.

## D014. 9443 Claude 인수는 운영 기본값과 분리한다

- 상태: T64 격리 9443 구현·검증 완료, 운영 적용 범위 밖
- Claude Code 2개와 Dev Terminal은 격리 9443 서버의 새 Project에만 적용하는 opt-in
  default workspace다. 기존 Project/Pane 기록과 Workstation 기본 Codex workspace는 변경하지
  않는다. DB schema migration은 필요 없으며 테스트 Naru 재시작 뒤 새 Project부터 적용한다.
- 기존 Project root strict-child 계약은 운영에서 그대로 유지한다. 격리 서버는 사용자가 지정한
  단일 Project의 canonical exact root만 명시적으로 추가 허용한다. `realpath`·directory·read/execute
  검증을 거치며 sibling, symlink escape와 상위 경로는 계속 거부한다. 일반 root의 strict-child
  규칙을 전역으로 완화하지 않는다.
- Claude CLI 업그레이드는 Homebrew가 소유한 `claude-code@latest`만 대상으로 하며 운영
  Workstation 서비스와 Naru/Gateway/Host release는 변경하지 않는다.

## D013. Claude Code는 별도 Pane과 Host profile로 추가한다

- 상태: T63 로컬 구현·검증 완료, 운영 적용 별도 승인 대기
- 기존 `codex` Pane, session ID, hook/relay protocol은 그대로 유지한다. `claude` Pane과
  `claude-code` launch profile은 additive public contract다. 구 web consumer는 새 Pane kind를
  해석할 수 없으므로 server/web은 같은 release로 배포한다.
- Host는 configured canonical Claude executable만 allowlisted profile로 실행하고 Gateway
  authentication, Naru project authorization과 Host capability 경계는 기존과 같다. 새
  Workstation intent의 `claudeExecutable`은 optional이며 기존 receipt/intent에서는 absent다.
  Claude profile을 활성화하는 운영 변경은 reconfigure와 Host restart를 포함한다.
- DB v17은 `claude` kind를 추가하며 기존 Pane과 Host Session link를 보존한다. 이 migration은
  운영 데이터 변경이므로 사전 backup과 별도 plan 승인이 필요하다.
- Claude CLI는 이 단계에서 terminal TUI로만 사용한다. Codex request lifecycle을 Claude에
  재사용하지 않으며, 재시작 뒤 이전 대화는 TUI의 `/resume` picker로 선택한다.

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

## D019. Codex 기본 transcript 모드와 협상된 mouse encoding을 유지한다

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

## D020. 마우스 추적 TUI의 기본 드래그는 Naru 출력 선택에 사용한다

- 마우스 추적을 켠 Codex·Claude 등에서도 desktop 왼쪽 드래그는 Naru가 로컬 buffer에서 선택한다.
  Alt+마우스는 앱 입력 경로를 유지하고, 일반 shell은 기존 xterm 선택을 사용한다. 명시적 선택
  도구도 desktop 드래그를 지원한다. 선택이 있으면 Ctrl/Cmd+C는 browser copy에 맡기고, 실제
  문자 입력·붙여넣기가 승인되면 선택을 종료한다. 선택 없는 Ctrl+C는 기존 interrupt 입력이다.
- 선택 원문은 해당 renderer 메모리에만 보관하며 TUI repaint가 같은 좌표를 다른 문자로 바꾸어도
  이미 선택한 복사 문구를 바꾸지 않는다. 취소·새 선택·dispose 시 회수하고 로그·저장·Host 전송은
  하지 않는다. 별도 clipboard protocol이나 OSC 52 권한을 추가하지 않는다.
- 선택 drag와 handle의 가장자리 scroll은 D019과 같은 wheel 경로를 사용한다. normal buffer는
  로컬 scrollback, tracking alternate buffer는 controller fence를 통과하는 TUI wheel 입력이다.
  alternate buffer의 화면 밖 원문은 Naru가 갖고 있지 않으므로 여러 redraw에 걸친 전체 transcript
  범위를 합성하지 않는다. 범위 조정은 현재 buffer 좌표에 적용되고 마지막으로 선택한 문구를 복사한다.
- wire/schema/Host payload 변경은 없다. 이 웹 변경만 배포하면 Naru-only upgrade가 가능하지만
  D019 등의 Host 변경을 함께 넣으면 실제 distribution plan의 restartServices를 따라야 한다.

## D021. 일반 클릭은 TUI에 전달하고 드래그가 확인된 뒤에만 선택한다

- D020 구현은 mouse down 순간 선택을 시작해 일반 클릭에도 선택 도구가 잠깐 나타나고 TUI
  클릭을 막았다. 이를 보완해 mouse down은 선택 UI 없이 보류하고, 3px를 넘는 이동이 확인된
  경우에만 최초 위치에서 로컬 드래그 선택을 시작한다.
- 이동이 없는 클릭과 작은 손떨림은 mouse up에서 원래 좌표·modifier의 down/up을 xterm 경로로
  한 번씩 전달한다. 협상된 mouse encoding과 기존 controller fence를 그대로 사용한다.
  반복 클릭도 TUI로 전달한다. 일반 클릭 판정까지 press 전달이 지연되며, Alt 입력은 기존처럼
  즉시 TUI 경로를 사용한다. Blur·dispose는 보류한 클릭을 전달하지 않고 회수한다.
- 일반 shell, 모바일 길게 누르기·선택, 기존 드래그 copy와 edge scroll은 유지한다.
  Host·wire contract·저장 형식 변경은 없으며 새 web artifact와 별도 배포 plan으로 적용한다.

## D022. 병렬 브랜치의 결정·Task 번호 충돌은 main 쪽을 재부여한다

- 상태: `model/claude` 통합(2026-10-07)
- `main`과 `model/claude`가 같은 시기에 D013·D014·D015와 T63을 각각 다른 의미로 사용했다. Claude 계열은
  운영 별도 앱 배포 문서와 workstation 결정에서 참조하므로 그대로 두고, `main` 쪽만 D013 → D019,
  D014 → D020, D015 → D021, T63 → T69로 바꿨다. 이미 기록된 커밋 메시지는 바꾸지 않으므로 이전
  번호는 이 대응으로 읽는다.
- D018과 D019는 같은 mouse encoding 복원·touch wheel 경로를 서로 다른 CLI 인수로 기록한 것이다.
  통합 source는 하나의 `TerminalMouseEncoding`과 `scrollTerminalAt` 구현만 유지한다. wire·DB 계약
  변경은 없다.

## D023. Claude Pane은 마지막 Claude 대화 ID만 저장해 재개한다

- 상태: T71 완료·운영 배포와 사용자 인수(2026-10-10)
- hook `SessionStart`(시작·재개·`/clear`)가 보낸 Claude session ID를 기존 Pane/runtime·cwd fence를
  통과한 경우에만 Pane별로 저장한다. 값은 UUID 형식만 받으며, 대화 원문·transcript 경로는 읽거나
  저장하지 않는다.
- Claude Pane 재시작은 저장된 ID가 있으면 `--resume <id>`로 실행한다. CLI의 기본 resume은 같은 session
  ID를 유지한다. "새 Claude 시작"은 저장된 ID를 지운 뒤 인자 없이 시작한다. 대화가 CLI에서 사라졌다면
  재개가 실패하고 사용자는 새로 시작한다.
- DB v18은 `panes.claude_session_id` nullable 열만 추가한다. 기존 Pane은 NULL이며 migration 전 backup
  계약을 그대로 따른다. Pane REST 응답은 선택 필드 `claudeSessionId`를 더하고 구 web은 이를 무시한다.
  WebSocket frame과 Host public protocol은 바꾸지 않는다. web은 Claude Pane 종료 시 workspace를 다시
  읽어 재개 가능 여부를 반영한다.

## D024. 해소된 프로젝트의 Web Push 알림은 기기별 알림 ID 목록으로 닫는다

- 상태: T47 완료·운영 배포와 사용자 실기기 인수(2026-10-10)
- 프로젝트의 집계 상태가 완료·입력 필요·실패에서 벗어나면, 마지막 정리 뒤 그 프로젝트 알림 전송을
  시도한 기기에만 정리 push를 보낸다. 기기별 마지막 정리 시각은 DB v19의 `push_project_clears`에
  둔다. 전송이 실패한 기기는 이전 정리 시각으로 되돌려 다음 해소에서 다시 시도한다. 404·410
  endpoint는 기존처럼 subscription을 삭제한다.
- 정리 payload는 `{ version: 1, type: "clear", eventId, projectId, alertEventIds }`이다.
  `alertEventIds`는 그 기기에 지난 정리 이후 보낸 알림 event ID를 최신순 최대 32개 담는다. 서비스
  워커는 같은 프로젝트 tag의 알림 중 ID가 목록에 있는 것만 닫고 서버를 조회하지 않는다. 그 사이 새
  알림이 자리를 대신했다면 ID가 목록에 없어 유지되므로 순서 역전과 오프라인에서도 결과가 같다.
- 정리 시점에 전송 중이던 알림도 목록에 넣는다. 기기에 표시되지 않은 ID는 닫을 대상이 없을 뿐이다.
  같은 ms의 경계는 미정리로 본다. 같은 프로젝트 topic을 써서 push service가 아직 전달하지 않은 신호는
  이후 메시지가 대체한다.
- 정리 payload는 기존 알림과 모양이 달라 구 서비스 워커는 무시한다. 정리 push는 알림을 새로 표시하지
  않으므로 Chromium 계열은 사이트 engagement 예산이 부족할 때 기본 알림을 띄울 수 있어 실제
  Android·Samsung Internet에서 확인한다. 7일 보존을 넘긴 전달 기록은 정리 대상에서 빠진다. 기존 알림
  payload와 subscription은 그대로이며 v19는 테이블만 추가한다.
