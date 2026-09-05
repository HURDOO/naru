# Workstation development runtime

이 디렉터리는 `workstation-v0/T01`의 현재 worktree 증명과 개발 runtime 격리를 담당한다. tracked
설정에는 개인 worktree 절대경로, credential 또는 secret을 넣지 않는다.

## 명령

- `pnpm workstation:dev:profile`: 현재 Git root에서 결정적으로 계산한 profile과 Naru 개발 환경을
  JSON으로 출력한다. 파일이나 listener를 변경하지 않는다.
- `pnpm workstation:dev:check`: profile 격리 규칙을 검사하고 세 loopback port를 동시에 잠깐
  bind한 뒤 즉시 닫아 충돌 여부를 확인한다.
- `pnpm workstation:dev:prepare`: check 뒤 worktree의 `.local/workstation-dev/**`와
  `/private/tmp/naru-workstation-<uid>/**`에 mode 0700 디렉터리를 만든다. symlink, 다른 owner 또는
  넓은 권한의 기존 디렉터리는 자동 수정하지 않고 거부한다.
- `pnpm workstation:preflight`: 설치된 Node 24를 찾아 그 runtime에서 `better-sqlite3` memory query와
  `node-pty` shell spawn을 실행한다. Naru runtime과 같은 방식으로 설치된 `spawn-helper`에 user
  execute bit가 빠졌을 때만 이를 보완하며, 두 package가 현재 worktree 안에서 resolve되지 않으면
  실패한다.
- `pnpm workstation:mcp:check`: Codex가 사용할 launcher를 Node 24에서 dry-run한다. 현재 cwd가 Git
  root인지 확인하고 `.local/workstation-dev/<profile>/playwright-mcp.json`에 HEAD, Node, Playwright
  entry와 config/package/lock/build hash를 기록한다.

## MCP와 재시작 증거

`.codex/config.toml`은 `cwd`를 고정하지 않는다. Codex가 project MCP를 시작할 때 현재 worktree root를
상속해야 하며 launcher가 그 조건을 fail-closed로 확인한다. launcher는 Node 24에서 이 worktree의
`@playwright/test` CLI만 실행한다. Codex/MCP를 재시작한 뒤 marker의 `repositoryRoot`, `processCwd`,
`playwrightCli`, input hash와 브라우저 smoke를 함께 확인해야 `workstation-v0/T01`의 실제 인수가
완료된다.

profile은 Host/Gateway/Naru data, credential directory, UDS, cookie, loopback port, exact Origin과
launchd label 이름을 모두 분리한다. secret 값은 profile에 포함하지 않으며 실제 Host/Codex PTY
개발 서버는 `AGENTS.md`에 따라 sandbox 밖 실행 승인을 별도로 받은 뒤에만 시작한다.
