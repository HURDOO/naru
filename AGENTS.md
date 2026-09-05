# AGENTS.md

## 기준 문서

- Naru application 변경: `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`,
  `docs/TASKS.md`
- DurableSession Core·Host·client·CLI 변경: `docs/durable-session/SPEC.md`,
  `docs/durable-session/ARCHITECTURE.md`
- Gateway·distribution 변경: `docs/workstation-v0/SPEC.md`,
  `docs/workstation-v0/ARCHITECTURE.md`, `docs/workstation-v0/DECISIONS.md`
- Private Ingress 변경: `docs/private-ingress-v0/`의 SPEC, ARCHITECTURE, DECISIONS, TASKS

구현 전에 해당 문서와 canonical Task의 선행 조건을 확인한다. 계약이 충돌하면 임의로 구현하지 않고
충돌 범위와 선택지를 기록한다. 완료된 계약을 소급 수정하지 말고 새 결정과 migration을 추가한다.

## 개발 규칙

- TypeScript strict mode와 pnpm만 사용하고 Node.js 24 LTS를 기준으로 검증한다.
- 기존 변경을 보존하고 관련 없는 파일을 정리하거나 되돌리지 않는다.
- public contract 변경은 versioning, consumer 호환성과 migration을 함께 설명한다.
- 오류, 빈 상태, 권한 거부, reconnect와 단일 controller handoff를 정상 흐름과 함께 테스트한다.
- UI 변경은 키보드와 focus 표시, 1440px·768px·360px 및 동적 viewport를 확인한다.

표준 진입점은 `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm test:e2e`다. 운영·distribution 변경에는 관련 operations, distribution, production smoke를
추가한다.

## 보안과 운영

- 이 앱은 설치한 OS 사용자 권한의 shell을 노출한다. authentication, exact Origin, source policy,
  project `realpath`, app capability와 generation fencing을 약화하지 않는다.
- token, password, cookie, private key, terminal/Codex 원문과 실제 instance path·domain·IP를 source,
  fixture 또는 구조화 로그에 기록하지 않는다.
- 예시는 `.invalid`, `.example.test`, 임시 디렉터리와 식별 불가능한 fixture만 사용한다.
- public bind, port forwarding, DNS·VPN·certificate 변경, service install/restart, data migration,
  browser permission과 remote repository 변경은 각각 사용자 승인 경계다.
- 실제 path는 `realpath` 뒤 승인 root 내부인지 다시 확인하고 symlink escape를 거부한다.
- production 작업을 개발·테스트 명령으로 우회하지 않는다.

## Task와 완료

- application 상태는 `docs/TASKS.md`, Private Ingress 상태는
  `docs/private-ingress-v0/TASKS.md` 한 곳에서 관리한다.
- 구현 시작 시 대상 Task만 `[-]`, 검증과 integration gate 완료 뒤 `[x]`로 바꾼다.
- 동작, 실행한 검증과 결과, 남은 위험 또는 사용자 결정을 완료 보고에 기록한다.
- remote 추가·push와 release publish는 별도 명시적 승인 전에는 수행하지 않는다.
