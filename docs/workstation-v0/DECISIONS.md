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
