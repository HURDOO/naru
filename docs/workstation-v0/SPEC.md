# Private Agent Workstation v0 명세

## 상태

Workstation v0는 완료·동결됐다. 이 문서는 public contract의 유지 기준이며 새 ingress 구현은
`docs/private-ingress-v0/`에서 additive하게 진행한다.

## 구성요소

- DurableSession Host: Session, PTY, runtime, sequence와 attachment/control
- Workstation Gateway: passkey browser session, exact Origin, app assertion과 ingress
- Naru: Project/Pane/layout과 application authorization
- Distribution: immutable macOS arm64 release, receipt, maintenance와 rollback

## 계약

- 한 installation은 한 OS 사용자가 소유하며 component socket, data와 service namespace를 분리한다.
- Browser는 Gateway의 canonical HTTPS Origin 하나를 사용한다.
- Gateway는 자기 cookie를 Naru에 전달하지 않고 short-lived app-scoped assertion을 발급한다.
- Naru는 registered app credential로 private Host UDS에 연결한다.
- Exactly one controller가 input/resize를 수행하고 observer는 explicit control 전환 전까지 read-only다.
- Gateway/Naru restart는 Host PTY를 종료하지 않는다. Host restart 뒤에는 Session을 stopped로 표시한다.
- Package는 external DNS, VPN, route, firewall과 certificate issuance를 변경하지 않는다.

## Distribution

Artifact는 pinned Node.js 24 runtime, Host/Gateway/Naru, CLI, web release, dependency license와 file manifest를
포함한다. Source commit, lockfile, Node input과 payload digest를 검증하고 install/upgrade/reconfigure/
rollback마다 fresh plan approval을 요구한다.

T73/WV0-D014 이후 component 의존 payload·설정이 바뀐 서비스만 새 release로 옮기고 재시작한다.
Gateway-only 변경에서는 Naru의 실행 process·release·웹 경로·설정을 유지한다. Receipt의
`runtimePinVersion: 2`가 독립 Naru pin을 허용하며, 필드가 없는 receipt는 기존 의미로 계속 읽는다.
서명 키·Origin·공유 인증 계약 변경은 별도의 consumer 호환성 경계를 유지한다.

## 제외

- multi-user/RBAC와 concurrent writer
- public internet exposure와 automatic network mutation
- Host/OS restart를 가로지르는 process persistence
- remote password reset, arbitrary plugin loader와 marketplace
