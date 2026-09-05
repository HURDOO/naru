# Public baseline inventory policy

이 repository는 private checkout 전체가 아니라 명시적 allowlist snapshot으로 시작한다.

## 포함 범위

- root build/typecheck/test configuration과 lockfile
- DurableSession contract, Host, public client와 CLI
- Workstation Gateway, verifier와 distribution implementation
- Naru server/web reference application과 isolated tests
- public setup/integration skills
- current product, security, architecture와 Private Ingress program 문서
- Apache-2.0, dependency와 bundled font notices

## 제외 범위

- 이전 Git history, stash, worktree metadata와 remote configuration
- local agent/editor configuration과 원본 private project brief
- environment, secret, DB, log, build output, browser artifact와 package cache
- production runbook, actual acceptance evidence, handoff와 historical discussion
- private account, path, domain, IP, tailnet, certificate, receipt와 service state
- one-off worker integration manifests와 migration baseline artifacts

`pnpm public:scan`은 worktree 대신 Git index blob을 읽고, 모든 도달 가능한 commit/tag/blob과 그 이력의
filename도 검사한다. 현재 Markdown의 local link와 비공개 기준 문서 참조도 public inventory에 대해
검증한다. 운영자가 알고 있는 instance 식별자는 저장소 밖 absolute
`NARU_PUBLIC_SCAN_DENYLIST_FILE`로 추가할 수 있으며 scanner는 일치한 literal을 출력하지 않는다.

Release 전에는 표준 test suite, dependency audit, `git fsck`, clean status와 사람이 수행하는 privacy
review를 함께 확인한다. Scanner는 알려진 credential/path pattern과 선택적 denylist만 판정할 수 있으므로
실제 secret 관리나 topology review를 대신하지 않는다.
