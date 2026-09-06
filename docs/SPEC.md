# Naru 제품 명세

## 상태와 목표

Naru는 한 OS 사용자가 자신의 project, shell과 Codex CLI를 여러 browser form factor에서 이어 쓰는
self-hosted web Agent IDE다. 현재 public baseline은 DurableSession/Workstation v0를 포함하며 다음 활성
program은 Private Ingress v0다.

핵심 목표는 다음과 같다.

1. 허용된 server directory를 Project로 등록하고 전환한다.
2. Codex와 terminal을 여러 Pane으로 배치하고 layout을 보존한다.
3. browser reconnect와 controller handoff에서도 Host가 소유한 PTY를 유지한다.
4. Gateway authentication과 application authorization, Host capability를 분리한다.

## 제품 계약

- Project path는 absolute path를 입력받되 `realpath` 뒤 configured root의 strict child인지 검사한다.
- ProjectGroup은 standalone directory 또는 같은 Git common directory의 connected worktree를 묶는다.
  발견만으로 Project, Pane 또는 PTY를 만들지 않고 사용자의 명시적 연결을 요구한다.
- desktop은 split tree를, 좁은 화면은 같은 tree의 한 Pane projection을 사용한다. viewport 변경으로
  Pane이나 PTY를 재시작하지 않는다.
- Codex와 shell process는 DurableSession Host가 소유한다. Naru와 Gateway restart는 Host PTY를
  종료하지 않으며 Host restart 뒤에는 Session을 정직하게 stopped로 복구한다.
- 정확히 한 controller만 terminal input과 authoritative resize를 수행한다. observer는 read-only다.
- gateway-managed mode는 Gateway passkey/session과 signed app assertion을 사용한다. standalone
  app-managed mode는 별도 compatibility 경계다.
- terminal/Codex 원문은 영구 저장하지 않는다. bounded terminal state와 live draft는 메모리 전용이다.

## 보안 불변조건

- public/wildcard listener와 forwarded identity 추론은 허용하지 않는다. CIDR source admission은
  Private Ingress의 explicit canonical RFC1918 IPv4 allowlist와 독립 Gateway authentication 아래에서만
  허용한다.
- HTTP mutation과 WebSocket은 exact Origin, session, CSRF와 payload 상한을 검사한다.
- Gateway assertion은 Host capability가 아니다. Naru가 app/resource 권한을 확인한 뒤 scoped caller를
  만든다.
- path, socket, credential과 TLS material은 canonical target, owner, mode와 type을 재검사한다.
- password, token, cookie, private key, terminal output과 실제 instance topology를 source나 log에 넣지
  않는다.

## 지원 범위

- host/package: macOS arm64, launchd, Node.js 24 LTS
- browser: 최신 Chrome 계열을 primary target으로 하며 실제 지원 주장은 acceptance evidence가 있는
  조합으로 제한한다.
- network: user-managed private LAN, VPN 또는 proxy 뒤 exact HTTPS Origin
- 사용자 모델: 한 OS 사용자, 한 instance, 한 active controller

## 범위 제외

- public internet hosting, router/firewall/VPN/DNS 자동 변경
- multi-user, RBAC, concurrent writers와 collaboration
- terminal transcript 장기 보존·검색
- Host 또는 OS restart를 가로지르는 process persistence 주장
- arbitrary runtime/plugin marketplace

세부 Core 계약은 `docs/durable-session/`, Gateway/distribution 계약은 `docs/workstation-v0/`, 다음
network program은 `docs/private-ingress-v0/`를 따른다.
