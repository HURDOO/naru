# Workstation v0 결정 기록

## WV0-D001. Core는 generic Session semantics만 소유한다

Codex activity, Project와 UI identity는 Naru integration 경계에 남기고 public DurableSession contract에
넣지 않는다.

## WV0-D002. Host와 application lifecycle을 분리한다

Naru/Gateway restart는 Host PTY를 종료하지 않는다. Host restart 뒤 process persistence를 주장하지 않는다.

## WV0-D003. Browser authentication은 Gateway가 소유한다

Gateway-managed app은 Gateway passkey/session과 namespaced CSRF를 사용하고 app cookie를 중복하지 않는다.

## WV0-D004. Distribution은 immutable transaction이다

Plan과 mutation을 분리하고 exact digest 승인, private receipt, independent maintenance와 rollback을 사용한다.

## WV0-D005. Instance Origin은 구성값이다

Gateway, WebAuthn, Naru, PWA와 Push는 하나의 configured canonical HTTPS Origin에서 파생한다. Source에는
실제 instance Origin을 두지 않는다.

## WV0-D006. Public source와 production은 별도 승인 경계다

Source build, package verification 또는 public repository 준비를 service install, network apply, deploy나
remote push 승인으로 해석하지 않는다.

## WV0-D007. Upgrade는 변경된 runtime만 새 불변 릴리스로 옮긴다

- 상태: accepted (T57)
- 결정: verified artifact의 서비스별 의존 payload를 이전 runtime pin과 비교한다. 새 web release를
  사용하는 Naru는 upgrade에서 재시작한다. Host payload·packaged Node·Host가 실행하는 Codex
  integration/CLI payload가 바뀌면 Host부터 세 runtime을 재시작하고, Gateway payload만 바뀌면
  Gateway와 Naru를 재시작한다. 웹만 바뀌면 Naru만 재시작한다.
- 유지: 바뀌지 않은 Host/Gateway의 launchd definition과 실행 configuration은 이전 immutable
  release를 계속 가리킨다. Receipt의 additive `runtimeReleases`는 실제 서비스별 pin을 기록하며,
  없는 기존 receipt는 세 서비스가 단일 `artifact`를 사용한 것으로 읽는다. Plan digest는 재시작
  범위와 pin을 결합하고 doctor/status는 모든 pin을 검증한다.
- 호환성·migration: 기존 receipt와 설치에는 변환 작업이 없다. 첫 selective upgrade가 새 receipt에
  혼합 pin을 기록한다. 이전 release는 참조되는 동안 보존한다. Reconfigure와 rollback은 새 plan에
  표시되는 영향 서비스만 재시작하되 rollback은 대상 receipt의 pin을 복원한다. 실패 복구는 중지한
  서비스만 이전 definition으로 되돌린다.

## WV0-D008. Gateway가 여러 app의 path routing과 dashboard를 소유한다

- 상태: accepted (T58, additive post-v0)
- 결정: 각 managed app은 겹치지 않는 canonical route prefix와 assertion audience를 가지며 Gateway가
  HTTP·WebSocket prefix 제거, 인증과 app availability를 소유한다. Enabled root app이 없으면 `/`와
  `/_gateway/apps`가 인증된 app dashboard를 제공하고, root app이 있으면 `/`는 그 app에 유지한다.
  Dashboard는 upstream origin·socket path와 실제 instance topology를 노출하지 않는다.
- Naru 연동: `@naru/contracts/naru-app/v1`의 app base path를 distribution config/env, web metadata,
  service-worker scope/cache와 receipt에 동일하게 결합한다. 새 CLI intent는 `/naru`, 값이 없는 기존
  intent·receipt는 `/`로 해석한다. App-managed non-root 구성은 지원하지 않고 거부한다.
- 호환성·migration: reconfigure는 Gateway registration과 Naru release를 한 transaction으로 옮기고,
  rollback은 대상 receipt의 root/non-root 경로를 정확히 복원한다. Root를 비운 Gateway의 인증된
  retirement worker는 과거 Naru root worker와 root cache만 회수하고 path-scoped app cache는 보존한다.
  기존 browser profile·설치 PWA와 실제 production migration은 source/fixture 검증과 분리된 승인
  경계다.

## WV0-D009. 같은 launchd label의 재시작은 이전 process의 완전한 종료 뒤에만 허용한다

- 상태: accepted (T60)
- 결정: Host·Gateway·Naru를 중지하기 전에 exact launchd label의 PID를 관찰한다. `bootout` 뒤에는
  label이 해제되고 그 PID가 더는 존재하지 않는 조건을 bounded wait로 함께 확인한 뒤에만 같은
  label을 bootstrap한다. PID 재사용 가능성, 조회 권한 실패와 timeout은 종료 미확인으로 취급해
  fail-closed한다.
- 시작 계약: 세 runtime plist는 `RunAtLoad=true`이므로 bootstrap 자체가 시작 요청이다. 별도의
  `kickstart -k`로 새 process를 다시 교체하지 않고 readiness로 기동 완료를 확인한다.
  `RunAtLoad=false`인 independent one-shot maintenance job의 bootstrap 뒤 kickstart는 유지한다.
- 복구: candidate readiness 실패 뒤 이전 receipt topology를 복원할 때도 같은 quiescence 계약을
  적용한다. 중지 확인 실패 시 다음 candidate 또는 rollback bootstrap을 시도하지 않고
  `manual-required`로 남긴다.

## WV0-D010. 종료 미확인 오류는 transaction 복구에서도 재시작을 차단한다

- 상태: accepted (T61)
- 배경: T60의 종료 대기 실패 뒤 복구가 launchd label 부재만 보고 bootstrap을 재시도할 수 있었다.
- 결정: stop 실패를 내부 typed error로 전달하고 transaction은 설정 snapshot만 복원한다.
  이전 PID 종료를 확인하지 못했으므로 candidate·rollback runtime을 시작하지 않고
  `manual-required`로 종료한다. 정상적인 readiness 실패는 기존 자동 복구를 유지한다.
- 호환성: 기존 결과 상태와 receipt schema를 그대로 사용하며 데이터 migration은 없다.
  이미 가동 중인 runtime에는 영향이 없고 새 maintenance 실행기 배포 이후 적용된다.

## WV0-D011. 별도 upstream app은 승인된 intent로만 Gateway에 추가한다

- 상태: 기존 운영 릴리스의 additive 계약을 현재 source에 통합. 신규 앱의 운영 등록·배포는 별도 계획과 승인 대상.
- 결정: 기존 intent의 선택적 `additionalGatewayApps`는 app ID, 겹치지 않는 route prefix, 정확한
  `127.0.0.1` upstream port만 받는다. Gateway assertion audience는 app ID로 분리하고 Gateway
  인증·Origin·source policy는 공유한다. 기존 Naru의 Host registration, DB, profile와 environment는
  변경하지 않는다. 등록 앱의 별도 Host·Naru 프로세스, 자격 증명과 가용성은 이 Workstation
  transaction 밖에서 독립적으로 준비한다.
- 운영 경계: receipt-owned Gateway config를 수동 편집하지 않는다. 새 artifact를 검증한 뒤 기존
  설치의 `reconfigure`와 exact plan digest로 Gateway/Naru만 교체한다. 운영 Host 재시작을 요구하는
  artifact upgrade와 설정 변경을 하나의 plan으로 합치지 않는다.
- 호환성·제거: 필드가 없는 기존 intent/receipt는 추가 앱 0개로 읽는다. 구 CLI는 새 필드를
  거부하므로 지원하는 CLI artifact가 필요하다. 등록 해제는 필드를 제거한 새 `reconfigure` plan으로
  수행하고 기존 receipt·backup을 보존한다. 별도 upstream의 설치·제거는 별도 승인 경계다.

## WV0-D012. 단일 Project는 opt-in exact root로만 허용한다

- 상태: T67 source 구현·운영 적용 전.
- 결정: Workstation intent의 선택적 `exactProjectRoots`는 `allowedProjectRoots`에 이미 열거된
  canonical root만 지정한다. 지정된 root 자체와 그 하위 경로를 Project로 사용할 수 있고,
  나머지 root는 기존처럼 strict-child 정책을 유지한다. Naru에는 JSON 환경값
  `NARU_EXACT_PROJECT_ROOTS`로 전달하며 `ProjectPathPolicy`의 realpath·symlink escape 검사가
  적용된다. 이를 통해 특정 Project를 열기 위해 상위 디렉터리의 다른 Project를 함께 허용하지 않는다.
- 호환성·migration: 필드가 없는 기존 intent/receipt와 Naru 환경은 기존 strict-child 의미로
  유지된다. settings digest에 필드를 결합해 값 변경은 새 plan과 승인 대상으로 다룬다.
  기존 설치의 설정을 소급 수정하지 않는다.

## WV0-D013. OpenCode는 별도 adapter를 거쳐 기존 Gateway에 등록한다

- 상태: 요청 범위 연동 구현·격리 검증 및 승인된 운영 등록 완료. Provider/실기기 인수는 별도 확인.
- 결정: 기존 Gateway 계약과 listener를 유지하며 독립 `omo` app을 `/omo/`에 등록한다. 별도
  OpenCode Gateway adapter v1이 short-lived app assertion의 issuer/audience/owner/Origin/expiry/replay를
  검증하고 정확한 localhost OpenCode에 내부 비밀번호로 연결한다. Provider 인증은 OpenCode가
  소유하고 기존 Codex·Claude Code 로그인은 복사하지 않는다.
- Browser: 공식 pinned OpenCode UI의 router/fetch/protocol/SSE integration point에서 `/omo/`와
  Gateway CSRF를 연결한다. CSRF는 메모리에만 두고 명시적 Gateway 거부만 재시도한다. Root-relative
  endpoint를 위해 Gateway 검사를 해제하거나 다른 app route를 재사용하지 않는다.
- 호환성·migration: 기존 intent/receipt·Gateway v1/v2·Naru/Host contract는 불변이다. 새 adapter v1
  config와 독립 release/LaunchAgent만 추가하며 registration은 기존 `additionalGatewayApps`의 새
  `reconfigure` plan과 정확한 digest 승인을 사용한다. Backend/UI version과 executable digest 변경은
  재빌드·재검증 대상이다. 등록 제거와 job 중지는 별도 승인하고 OpenCode 세션·credential은 보존한다.

## WV0-D014. Gateway와 Naru의 배포 pin을 독립적으로 유지한다

- 상태: T73 구현·격리 검증 완료(2026-10-10), 운영 미적용.
- 배경: WV0-D007은 모든 upgrade에서 Naru를 새 artifact로 옮기고 웹 release를 다시 렌더했다.
  Gateway 단독 변경도 Naru의 코드·인증 키·설정과 관계없이 재시작됐다. Gateway는 기존 서명 키와
  session 저장소를 재사용하므로 이 결합을 런타임 필수 의존성으로 취급하지 않는다.
- 결정: package는 하나로 유지하되 Host/Gateway/Naru의 검증된 의존 payload와 실제 설정을 각각
  비교한다. Gateway-only upgrade와 추가 앱 등록 reconfigure는 Gateway만, Naru 코드·웹 변경은
  Naru만 재시작한다. 변경 없는 component와 그 immutable release·LaunchAgent·환경 파일을 유지한다.
  Host 의존 payload·설정 변경은 기존처럼 세 runtime을 재시작한다. Origin·app base path 등 Naru
  환경을 바꾸는 설정은 Naru도 재시작한다. 공유 인증 계약 변경은 별도 versioning·consumer
  migration 대상이며 기존 assertion·Origin·source·capability 검증을 완화하지 않는다.
- 웹: Naru pin의 artifact에서 같은 Origin·base path로 렌더한 web release를 유지한다. Gateway만
  바뀌면 NARU_WEB_DIST와 service-worker revision을 바꾸지 않는다. Gateway 기동 뒤 공개 서명 키가
  달라졌는데 Naru가 재시작 대상이 아니면 파일을 갱신하지 않고 transaction을 실패시킨다. 승인된
  coordinated key rotation 또는 verifier reload 구현을 이 작업에 포함하지 않는다.
- receipt 호환성: intent의 v1/v2와 artifact v1은 불변이다. Receipt의 optional
  `runtimePinVersion: 2`가 독립 pin 의미를 명시한다. `artifact`는 마지막 transaction의 package와
  maintenance 설정을, `runtimeReleases`는 실제 component release를 가리킨다. 필드가 없는 기존
  receipt는 이전 규칙(Naru pin = artifact)으로 읽고 첫 승인 mutation에서 version 2를 기록한다.
  알 수 없는 pin version과 선언 없이 분리된 Naru pin은 거부한다. 독립 Naru pin이 있는 receipt는
  이전 CLI의 검증을 통과하지 못하므로 이후 plan·doctor·mutation은 T73 이상 CLI를 사용한다.
  DB·기존 receipt를 소급 변환하거나 파일·release를 삭제하지 않는다.
- 복구: rollback도 대상 receipt의 component pin·설정 차이만 재시작하며 웹 pin을 복원한다.
  `maintenanceArtifact`/공개 `maintenanceBuild`는 요청한 검증된 CLI를 승인 digest에 결합한다.
  과거 artifact로 rollback할 때도 새 독립 pin 규칙을 모르는 과거 worker를 실행하지 않는다.
  실패 복구는 실제 영향 service만 이전 설정으로 복원하며 종료 미확인·서명 키 불일치는 우회하지 않는다.

## WV0-D015. OmO 프로젝트 선택은 adapter의 승인 root에서 시작한다

- 상태: 요청 범위 모바일 오류 수정·격리 검증 및 exact plan 승인 후 독립 OmO 운영 적용 완료(2026-10-11).
- 배경: 공식 UI는 home과 `/`에서 폴더를 검색하지만 adapter는 승인 root 밖 요청을 거부한다.
  프로젝트가 없어 titlebar `+`가 조용히 종료되고, prefix-aware router의 pathname을 root-relative로
  분류해 첫 메시지 뒤 홈으로 돌아가는 문제가 있었다. 새 route의 Solid transition 중 context와
  command memo의 초기값 부재도 확인했다.
- 결정: adapter 0.1.1은 인증된 owner 전용 `GET /omo/api/_naru/project-roots`로 canonical root와
  default directory를 version 1/no-store JSON으로 제공한다. UI는 그 범위에서 검색하고 실제 API의
  realpath·symlink escape 검증을 유지한다. Route classifier만 base-relative pathname을 사용하며
  browser URL/link와 fetch는 `/omo/` 안에 둔다. 새 context와 command 등록에 동기 초기값을 제공한다.
  프로젝트 없는 `+`는 승인 폴더 picker를 열며 취소 시 draft를 만들지 않는다. Session layout key와
  view도 동기 초기값을 제공하고, session subtree는 parent route가 이미 검증한 서버 identity를
  유지해 unmount 중 소멸한 param을 다시 해석하지 않는다. Parent의 server key 검증은 그대로 유지한다.
- 호환성·migration: Gateway·Naru·Host와 adapter config v1은 변경하지 않는다. Metadata가 없는
  이전 adapter와 새 UI를 섞지 않고 같은 독립 immutable release로 update한다. Exact digest 승인
  뒤 OmO job만 교체하며 OpenCode auth/session data와 이전 release/definition을 보존한다.
  Gateway registration/config, source admission, receipt와 Naru/Host service는 변경하지 않는다.
