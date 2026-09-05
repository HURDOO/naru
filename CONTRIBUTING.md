# Contributing to Naru

Naru는 macOS 사용자 권한의 shell과 private network/authentication 경계를 다루므로 작은 변경도 코드,
계약, 문서와 회귀 증거를 함께 검토한다.

## 시작 전

1. `AGENTS.md`와 변경 scope의 SPEC, ARCHITECTURE, DECISIONS, TASKS를 읽는다.
2. Node.js 24 LTS와 pnpm 11.12.0을 사용한다.
3. 실제 secret, cookie, terminal/Codex 원문, 개인 인증 자료를 issue·commit·fixture에 넣지 않는다.
4. public contract 변경은 versioning과 기존 consumer 호환성을 먼저 설명한다.

## 변경 단위

- TypeScript는 strict mode를 유지한다.
- 정상 흐름과 함께 오류, 빈 상태, 권한 거부, reconnect와 control handoff를 검증한다.
- 사용자 흐름을 바꾸면 keyboard/focus와 1440px, 768px, 360px browser 증거를 추가한다.
- path 입력은 `realpath` 뒤 허용 root 내부인지 다시 확인하고 symlink escape를 거부한다.
- authentication, Origin, app capability, session fencing과 사용자 승인 경계를 약화하지 않는다.
- dependency 변경은 Node 24에서 `node-pty`와 `better-sqlite3` native support, audit, license notice를
  함께 확인한다.

## 검증

최소한 변경 범위의 test와 다음 표준 gate를 통과시킨다.

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

UI·운영·distribution 변경에는 각각 `pnpm test:e2e`, `pnpm test:operations`,
`pnpm workstation:distribution:test`와 필요한 smoke/performance 검증을 추가한다. 실제 service,
network, Passkey, browser permission, deploy와 remote repository 변경은 명시적인 사용자 승인 전에는
수행하지 않는다.

## 제안과 pull request

PR에는 문제, 선택한 설계와 trade-off, 보안·migration 영향, 실행한 검증과 남은 제한을 적는다.
서로 다른 환경의 구현은 core에 조용히 hard-code하지 말고 stable contract나 adapter 경계로 제안한다.
공식 task 상태와 MVP 완료는 integration owner와 사용자가 acceptance evidence를 검토한 뒤에만 바꾼다.

Apache-2.0 아래 의도적으로 제출한 contribution으로 취급되길 원하지 않는 자료는 명확히
`Not a Contribution`으로 표시한다. 자세한 license는 [LICENSE](LICENSE), dependency 고지는
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인한다.
