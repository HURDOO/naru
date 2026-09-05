# Naru v0 시작하기

## 1. 사용할 경로 선택

- **standalone Workstation**: macOS arm64의 일반 v0 설치 경로다. package가 Node 24와 모든 runtime을
  포함하고, 사용자별 launchd service와 private data를 관리한다.
- **source development**: Naru나 protocol을 개발하고 자동 검증할 때 사용한다.
- **standalone Naru compatibility**: 기존 app-managed Naru를 유지하기 위한 경로다. 새 Workstation의
  Gateway-managed 기본 topology와 혼동하지 않는다.

지원·제외 범위는 먼저 [LIMITATIONS.md](LIMITATIONS.md)를 확인한다.

## 2. source development

요구 사항:

- macOS arm64
- Node.js 24 LTS
- pnpm 11.12.0
- 로컬 인증이 끝난 Codex CLI와 canonical shell
- browser E2E용 Google Chrome

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm password:hash
```

`.env`의 placeholder를 실제 개발 전용 값으로 바꾼다. 최소한 `NARU_AUTH_MODE=app-managed`, 생성한
`NARU_PASSWORD_HASH`, 32자 이상의 새 `NARU_SESSION_SECRET`, exact `NARU_ALLOWED_ORIGINS`, 본인이
소유한 `NARU_PROJECT_ROOTS`가 필요하다. 개발 data와 cookie name은 production과 분리한다.

직접 만드는 production web build의 PWA metadata는 `NARU_PWA_BUILD_ORIGIN`에 path 없는 exact HTTPS
hostname Origin을 지정한다. 지정하지 않으면 source build는 배포 불가한 `naru.example.test` fixture를
사용한다. Standalone Workstation artifact는 install 시 intent의 canonical Origin으로 metadata와 manifest를
다시 렌더한다.

```bash
pnpm dev
```

coding agent가 실제 Codex/PTY를 검증할 서버는 sandbox 밖 실행 승인이 필요하다. mock Codex와 격리된
browser 자동화만 sandbox 안에서 실행할 수 있다.

## 3. standalone artifact 만들기

builder는 clean committed worktree, Node 24가 실행되는 darwin-arm64 host와 공식
`node-v24.20.0-darwin-arm64.tar.gz`를 요구한다. Node archive의 고정 SHA-256은
`40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8`이다. builder는 network에서
download하지 않는다.

```bash
node ops/workstation/dev/run-node24.mjs \
  --import tsx ops/workstation/distribution/build-artifact.ts --json \
  --output-parent /absolute/private/output \
  --build-id v0-candidate \
  --node-runtime-archive /absolute/private/node-v24.20.0-darwin-arm64.tar.gz
```

결과에는 expanded artifact와 `naru-workstation-darwin-arm64-v0-candidate.tar.zst`가 생긴다.
`artifact.json`의 source commit, lockfile, manifest/payload digest와 archive SHA-256을 release record에
함께 보존한다. 기존 output을 덮어쓰지 않는다.

## 4. 설치 계획 검토

expanded artifact의 bundled Node로 target macOS 사용자의 GUI login session에서 실행한다. artifact와
intent file은 해당 사용자가 소유한 private canonical path에 둔다.

```bash
<artifact>/runtime/node/bin/node <artifact>/bin/workstation.mjs intent --json \
  --slug <instance-slug> \
  --artifact <artifact> \
  --origin <exact-https-origin> \
  --project-root <dedicated-allowed-parent> \
  --shell <canonical-shell> \
  --codex <canonical-codex>

<artifact>/runtime/node/bin/node <artifact>/bin/workstation.mjs plan --json \
  --intent <private-intent.json> --operation install
```

`--project-root`는 실제 Project가 아니라 등록 가능한 Project를 담는 전용 parent다. `intent` 출력은
`umask 077`인 `0600` file에 저장한다. plan의 exact target, service, Origin, root, warning과 digest를
검토하기 전에는 mutation 명령을 실행하지 않는다.

## 5. 승인된 mutation과 확인

사용자가 fresh plan digest를 승인한 경우에만 다음 형태로 handoff한다.

```bash
<artifact>/runtime/node/bin/node <artifact>/bin/workstation.mjs install --json \
  --intent <private-intent.json> --approve-digest <sha256>
```

CLI가 성공했다는 것은 independent maintenance worker에 요청을 넘겼다는 뜻이다. 반환된 private
`resultFile`의 terminal result와 새 `doctor --json`을 확인해야 설치 완료다. upgrade, reconfigure와
rollback도 각각 fresh plan과 별도 승인을 요구한다.

Passkey bootstrap, Tailscale/DNS/TLS/listener apply, PWA install, notification permission과 Codex hook
trust는 package install 승인에 포함되지 않는다. 자세한 순서와 rollback 의미는
[distribution guide](../ops/workstation/distribution/README.md)를 따른다.

## 6. 개발 검증

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:operations
pnpm workstation:distribution:test
pnpm test:production-smoke
pnpm audit:security
```

변경 범위에 따라 performance와 실제 device acceptance를 추가한다. production deploy나 restart는 이
문서의 설치 절차가 아니라 별도 운영 승인 절차다.
