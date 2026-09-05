# Naru

Naru는 실행 중인 shell과 Codex CLI 작업을 데스크톱·모바일 브라우저에서 이어 쓰는 개인용 웹 Agent
IDE입니다. DurableSession Host가 PTY와 runtime을 소유하고, Naru는 Project·Pane과 반응형 UI를,
Workstation Gateway는 선택적인 Passkey·private ingress 경계를 담당합니다.

```text
private HTTPS browser
        |
        v
Workstation Gateway -- signed app assertion --> Naru
                                                    |
local Session CLI -------- app capability ----------+
                                                    v
                                           DurableSession Host
                                                    |
                                                PTY / Codex
```

## 주요 기능

- server project 등록, Git worktree 발견과 명시적 연결
- 여러 Codex·terminal Pane과 저장되는 split layout
- observer 한 명 이상과 정확히 한 명의 controller, 명시적 handoff/preempt
- reconnect 및 Naru/Gateway restart 뒤 같은 Host runtime 재연결
- public TypeScript client와 local `durable-session` CLI
- optional Gateway Passkey, PWA/Web Push와 macOS arm64 standalone distribution

Host가 재시작되면 이전 process나 terminal 화면이 살아 있다고 주장하지 않고 Session을 `stopped`로
표시합니다. multi-user/RBAC, public internet hosting과 transcript 영구 저장은 현재 범위가 아닙니다.

## Source development

Node.js 24 LTS와 pnpm 11.12.0이 필요합니다.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm password:hash
pnpm dev
```

`.env`의 모든 placeholder를 개발 instance 전용 값으로 바꾸세요. 실제 secret, project path, domain,
IP 또는 certificate를 commit하지 마세요. 자세한 절차는 [Getting started](docs/GETTING_STARTED.md)와
[known limitations](docs/LIMITATIONS.md)를 확인하세요.

## 보안 경계

- terminal은 설치한 OS 사용자와 같은 권한으로 실행됩니다.
- project는 매 요청에서 `realpath`로 정규화하고 승인 root 밖 symlink를 거부합니다.
- terminal/Codex 원문, cookie, private key와 credential은 DB나 구조화 로그에 저장하지 않습니다.
- Gateway cookie·forwarding header는 upstream에 전달하지 않고 짧은 app assertion으로 바꿉니다.
- network 접근은 authentication이 아니며 public bind와 암묵적 network mutation을 지원하지 않습니다.

상세 위협 모델은 [Security](docs/SECURITY.md)를 참고하세요.

## 검증

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
pnpm public:scan
```

## 구성요소

| 경로                               | 역할                                |
| ---------------------------------- | ----------------------------------- |
| `apps/durable-session-host/`       | PTY lifecycle, event와 control      |
| `packages/contracts/`              | versioned protocol과 runtime schema |
| `packages/durable-session-client/` | public TypeScript client            |
| `apps/cli/`                        | same-user local Session CLI         |
| `apps/workstation-gateway/`        | Passkey Gateway와 ingress adapter   |
| `apps/server/`, `apps/web/`        | Naru reference application          |
| `ops/workstation/distribution/`    | macOS arm64 standalone package      |
| `skills/`                          | setup·integration·operation skills  |

Naru source는 [Apache License 2.0](LICENSE)으로 배포됩니다. Third-party runtime과 font 고지는
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.
