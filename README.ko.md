# Naru

[English](README.md)

**집에 있는 Mac에서 시작한 Codex와 터미널 작업을, 내 다른 기기에서 그대로 이어서.**

Naru는 내가 관리하는 Mac에서 실행 중인 Codex와 터미널을 데스크톱이나 모바일 브라우저에서 이어 쓸
수 있게 해 주는 개인용 웹 개발 환경입니다. 브라우저를 닫거나 기기를 바꿔도 작업은 Mac에서 계속
실행됩니다. 허용된 사설 네트워크로 다시 접속하면 같은 작업 화면에서 이어갈 수 있습니다.

## Naru로 할 수 있는 일

- 다른 기기에서 같은 터미널이나 Codex 작업을 이어서 사용합니다.
- 여러 터미널, Codex 작업, 문서와 파일을 작업 창에 배치하고 그 구성을 보존합니다.
- Git 워크트리를 자동으로 찾아 보여 주되, 사용자가 선택하기 전에는 연결하거나 실행하지 않습니다.
- 여러 브라우저에서 같은 상태를 보면서도 터미널 입력 권한은 정확히 한 곳에만 부여합니다.
- Naru 서버나 선택 사항인 게이트웨이가 재시작돼도 실행 중인 세션에 다시 연결합니다.
- Workstation Gateway를 사용하면 패스키 로그인, 설치형 웹 앱과 푸시 알림을 구성할 수 있습니다.

DurableSession Host나 운영체제가 재시작된 뒤에도 프로세스가 살아 있다고 주장하지는 않습니다. Host가
재시작되면 세션 기록은 복원하되, 기존 프로세스는 중지된 것으로 정확히 표시합니다.

## 동작 방식

```text
데스크톱 또는 모바일 브라우저
             |
             v
Workstation Gateway (선택)     패스키, 접속 출처와 네트워크 정책
             |
             v
Naru 서버 + 웹 화면             프로젝트, 작업 창, 파일과 화면 구성
             |
             v
DurableSession Host            터미널 프로세스, 출력과 입력 권한
             |
             v
        셸 / Codex CLI
```

실행 중인 프로세스와 터미널 상태는 DurableSession Host가 맡습니다. Naru는 그 주변의 프로젝트와 작업
화면을 관리하고, Workstation Gateway는 별도의 인증 및 사설망 접속 경계를 제공할 수 있습니다. 각
계층은 서로 다른 권한을 사용하며, 사설망에 접속했다는 사실만으로 사용자를 인증하지 않습니다.

## 실행하기 전에

> [!WARNING]
> Naru의 터미널은 설치한 운영체제 사용자와 같은 권한으로 명령을 실행합니다. 일반 사용 환경에서는
> Naru 앞에 Workstation Gateway를 두고, Gateway의 패스키 인증과 정확한 접속 출처(Origin) 검증, 범위가
> 제한된 앱 증명을 사용하세요.
>
> Gateway를 사용한다고 잘못된 네트워크 설정까지 안전해지는 것은 아닙니다. 접속을 받는 주소와 허용할
> 기기를 정확한 사설망 값으로 제한하고, TLS·DNS·VPN·방화벽·공유기 설정을 직접 검토하세요. Naru를
> 공용 인터넷에 직접 노출해서는 안 됩니다.

현재 지원하는 호스트와 패키지는 Apple Silicon 기반 macOS입니다. 한 명의 운영체제 사용자와 하나의
개인 인스턴스를 전제로 하며, 여러 사용자나 역할별 권한 관리는 지원하지 않습니다.

## 소스에서 실행하기

Node.js 24 LTS와 pnpm 11.12.0을 설치한 뒤 다음 명령을 실행합니다.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm password:hash
pnpm dev
```

`.env`의 모든 예시 값을 개발 환경 전용 값으로 바꾸세요. 실제 비밀값, 프로젝트 경로, 도메인, IP 주소,
인증서나 터미널 출력은 커밋하지 마세요. 전체 설정 방법은 [시작 안내](docs/GETTING_STARTED.md), 로컬
개발 환경 밖에서 사용하기 전에는 [현재 제한 사항](docs/LIMITATIONS.md)을 확인하세요.

## 보안 경계

- 프로젝트 경로는 `realpath`로 확인하며 승인된 최상위 폴더 안에 있어야 합니다.
- 상태를 바꾸는 HTTP 요청과 WebSocket 연결은 정확한 접속 출처, 세션과 메시지 형식을 검사합니다.
- 게이트웨이 인증 정보는 Naru로 전달하지 않고, 짧은 수명의 제한된 증명으로 교환합니다.
- Host 접근 권한은 애플리케이션, 호출자, 세션, 실행 프로세스와 세대에 묶입니다.
- 쿠키, 비밀키, 접근 권한 원문과 터미널·Codex 출력은 데이터베이스나 구조화 로그에 저장하지 않습니다.
- DNS, VPN, 방화벽, 공유기나 인증서 설정을 자동으로 바꾸지 않습니다.

인증, 네트워크, 프로세스 제어 또는 경로 처리를 변경하기 전에는 전체 [보안 모델](docs/SECURITY.md)과
[기술 구조](docs/ARCHITECTURE.md)를 읽어 주세요.

## 저장소 구성

| 경로                               | 역할                                     |
| ---------------------------------- | ---------------------------------------- |
| `apps/server/`, `apps/web/`        | Naru 서버와 반응형 웹 화면               |
| `apps/durable-session-host/`       | 터미널 프로세스의 실행, 출력과 입력 권한 |
| `packages/contracts/`              | 버전이 지정된 통신 규약과 실행 형식      |
| `packages/durable-session-client/` | 공개 TypeScript 클라이언트               |
| `apps/cli/`                        | 같은 사용자를 위한 로컬 세션 명령줄 도구 |
| `apps/workstation-gateway/`        | 패스키 게이트웨이와 사설망 접속 어댑터   |
| `ops/workstation/distribution/`    | macOS arm64 독립 실행 패키지             |
| `skills/`                          | 설치, 연동과 운영을 돕는 스킬            |

## 검증 명령

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

기여하려면 [CONTRIBUTING.md](CONTRIBUTING.md)를 먼저 확인해 주세요. Naru는
[Apache License 2.0](LICENSE)으로 배포되며, 의존성·실행 환경·포함 글꼴에 대한 고지는
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 정리되어 있습니다.
