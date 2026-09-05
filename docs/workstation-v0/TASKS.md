# Workstation v0 작업 원장

## 상태

- `[x]` Workstation v0 contract, Host, public client/CLI, Gateway, Naru integration과 distribution
- `[x]` Automatic security, continuity, browser와 package acceptance
- `[x]` Public documentation, license inventory와 reproducible artifact gate

Workstation v0는 완료·동결됐다. 새 listener/network/distribution 변경은
`docs/private-ingress-v0/TASKS.md`에서 관리하며 이 원장에 구현 checkbox를 복제하지 않는다.

## 유지 gate

- public DurableSession protocol compatibility
- Gateway assertion과 Host capability 분리
- exact controller generation fencing
- Gateway/Naru restart 중 Host PTY continuity
- deterministic artifact, license notices와 private receipt
- no public bind, implicit network mutation 또는 secret/terminal logging
