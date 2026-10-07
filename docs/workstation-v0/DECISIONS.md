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
