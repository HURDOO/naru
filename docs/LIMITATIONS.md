# Naru Workstation v0 알려진 제한

이 문서는 v0가 의도적으로 보장하지 않는 범위를 공개한다. 아래 항목을 지원 기능으로 해석하면 안 된다.

## Session과 내구성

- DurableSession Host process가 살아 있는 동안 browser 새로고침, reconnect, Naru 또는 Gateway
  restart를 견딘다.
- Host restart, macOS logout/reboot, power loss 뒤에는 동일 process나 terminal 화면을 복원하지 않는다.
  persisted metadata는 실행 중이라고 가장하지 않고 session을 stopped로 표시한다.
- terminal transcript를 장기 저장하거나 검색하지 않는다. bounded snapshot/event는 live continuity용이다.
- Naru의 Codex resume는 신뢰된 lifecycle ID만 사용한다. TUI 내부 `/resume`에서 session을 고르고 첫
  model turn을 보내기 전 재시작하는 구간은 자동 복원하지 않는다.

## Availability와 사용자 모델

- Gateway high availability, zero-downtime failover와 authenticated remote recovery가 없다. Gateway가
  중단되면 remote managed app은 unavailable이고 Host 및 same-user local CLI만 유지된다.
- 한 설치 instance는 한 macOS 사용자 소유다. 여러 OS 사용자가 각자 설치한 instance의 격리는
  지원하지만, 한 instance의 multi-user, RBAC, audit trail과 협업 권한 모델은 없다.
- Naru는 instance 전체에서 한 controller surface를 유지한다. 여러 browser나 Project가 동시에 서로
  다른 terminal을 독립 제어하는 모델이 아니다. observer는 read-only다.

## Platform과 browser

- v0 standalone package는 macOS arm64와 launchd만 지원한다. Linux/systemd, Raspberry Pi, Intel Mac과
  Windows host package는 지원하지 않는다.
- source 개발과 package build의 기준 runtime은 Node.js 24 LTS다. target package는 고정 Node
  v24.20.0을 포함한다.
- 설치형 PWA와 Web Push 실제 지원 주장은 Android Chrome에 한정한다. Samsung Internet에서 설치가
  실패한 결과는 알려진 제한이며 지원 증거로 계산하지 않는다.
- 계약 이전 service worker가 Gateway login을 가로막는 기존 client는 자동 self-heal하지 않는다.
  사용자가 영향을 검토·승인한 경우에만 해당 Origin의 site data를 한 번 reset한다.

## Network과 authentication

- public internet bind, 공유기 port forwarding과 Funnel은 지원하지 않는다. Tailscale Serve 또는
  별도로 관리되는 private ingress만 exact Origin/listener 정책 아래 사용할 수 있다.
- Tailscale account의 MagicDNS, HTTPS Certificates, Certificate Transparency 동의와 ACL은 사용자가
  직접 관리한다. package가 account-level 설정을 대신 변경하지 않는다.
- remote password reset이나 recovery endpoint는 없다. Passkey를 모두 잃은 경우 same-user local admin
  socket을 통한 짧은 일회성 recovery만 제공한다.
- Origin, root, shell, Codex, ingress 변경은 새 plan과 승인 대상이다. 기존 allowlist에 조용히 누적하지
  않는다.

## Integrations

- DurableSession public TypeScript client와 local CLI는 제공하지만 MCP server, third-party app
  marketplace/deployer, external integration runner와 모든 Session을 상시 구독하는 dashboard는 없다.
- app capability와 Gateway assertion은 서로 대체할 수 없다. custom app은 verifier, app registration,
  Host capability와 scope를 직접 올바르게 구성해야 한다.
- 다른 agent provider와 transcript memory, 전용 secret-input delegation은 post-v0 범위다.

향후 후보는 `docs/workstation-v0/TASKS.md`의 post-MVP 영역에 있으며 별도 설계·보안 검토·사용자 승인
전에는 예정된 기능으로 간주하지 않는다.
