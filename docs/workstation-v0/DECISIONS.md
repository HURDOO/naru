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
