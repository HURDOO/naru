# AGENTS.md

## 기준 문서

- Naru application 변경: `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`,
  `docs/TASKS.md`
- DurableSession Core·Host·client·CLI 변경: `docs/durable-session/SPEC.md`,
  `docs/durable-session/ARCHITECTURE.md`
- Gateway·distribution 변경: `docs/workstation-v0/SPEC.md`,
  `docs/workstation-v0/ARCHITECTURE.md`, `docs/workstation-v0/DECISIONS.md`
- Private Ingress 변경: `docs/private-ingress-v0/`의 SPEC, ARCHITECTURE, DECISIONS, TASKS

변경 영역의 관련 절을 읽고, 등록된 Task를 수행할 때는 해당 Task의 선행 조건과 완료 조건을 확인한다.
오탈자·단순 문서 수정에는 관련 없는 계약 문서 전체를 읽지 않는다. 계약이 충돌하면 충돌 범위와
선택지를 기록하고, 그 결정에 의존하지 않는 작업은 계속한다. 완료된 계약을 변경할 때는 기존 결정을
소급 수정하지 않고 새 결정과 필요한 migration을 추가한다.

## 개발 규칙

- TypeScript strict mode와 pnpm만 사용하고 Node.js 24 LTS를 기준으로 검증한다.
- 기존 변경을 보존하고 관련 없는 파일을 정리하거나 되돌리지 않는다.
- public contract 변경은 versioning, consumer 호환성과 migration을 함께 설명한다.
- 동작 변경은 정상 흐름과 영향을 받는 오류·빈 상태를 검증한다. 인증·권한 변경에는 권한 거부,
  세션·제어 변경에는 reconnect와 단일 controller handoff를 포함한다.
- UI 레이아웃·입력·반응형 변경은 키보드와 focus 표시, 1440px·768px·360px 및 동적 viewport를
  확인한다. 단순 문구·문서 변경은 영향을 받는 화면이나 문서의 표시를 확인한다.

표준 진입점은 `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm test:e2e`다. 일반 수정은 변경 범위에 맞는 검사를 선택하고, 문서만 변경하면 해당 파일의
format과 내용·참조 일관성을 확인한다. Task나 integration gate에서 전체 검증을 요구하면 그 조건을
따른다. 운영·distribution 동작 변경에는 관련 `pnpm test:operations`,
`pnpm workstation:distribution:test`, `pnpm test:production-smoke`를 추가한다.

격리된 로컬 fixture를 사용하는 검증은 요청 범위 안에서 실행하고, 이번 변경으로 생긴 실패를 수정한
뒤 관련 검사를 다시 실행한다. 통과 후에는 새 변경·실패·미해결 우려가 없는 한 검사를 확대하거나
반복하지 않는다. 실제 instance를 사용하는 인수 검증은 로컬 fixture 검증과 구분해 운영 승인 경계를
따른다.

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

요청 범위의 조사·수정·로컬 검증은 진행한다. 운영 변경은 정확한 대상, 영향과 검토 가능한 결과를
준비한 뒤 필요한 승인을 받는다. 동일한 대상·범위와 유효한 plan digest에 이미 받은 승인은 반복
요청하지 않는다. 대상·상태가 바뀌어 plan이 무효화되면 새 plan을 준비하고 승인을 받는다.

## Task와 완료

- application 상태는 `docs/TASKS.md`, Private Ingress 상태는
  `docs/private-ingress-v0/TASKS.md` 한 곳에서 관리한다.
- 등록된 Task를 수행할 때 시작 시 대상 Task만 `[-]`, 해당 완료 조건과 검증·integration gate를
  충족한 뒤 `[x]`로 바꾼다. 별도 Task가 없는 작은 유지보수는 요청 범위로 수행하며, 이를 위해
  무관한 Task를 시작하거나 큰 Task 전체를 완료 처리하지 않는다.
- 요청한 변경과 관련 검증, 이번 변경으로 생긴 회귀 수정까지 완료한다. 추가 승인이나 외부 입력이
  필요한 부분만 남으면 준비된 결과와 정확한 미완료 범위를 보고한다.
- 동작, 실행한 검증과 결과, 남은 위험 또는 사용자 결정을 완료 보고에 기록한다.
- remote 추가·push와 release publish는 별도 명시적 승인 전에는 수행하지 않는다.
