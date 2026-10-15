# OpenCode Gateway adapter v1

독립 OpenCode/OmO 서버를 기존 Workstation Gateway의 `/omo/`에 연결한다. Browser는 기존 HTTPS
Origin과 Passkey/session을 사용하고, Gateway는 `omo` audience의 일회용 signed assertion을 발급한다.
Adapter는 issuer/audience/owner/Origin/expiry/replay를 검증한 뒤 owner-only password로 정확한
`127.0.0.1` OpenCode upstream에 HTTP/SSE/WebSocket을 전달한다. Browser cookie, CSRF와 assertion은
OpenCode로 전달하지 않는다. Directory/path 선택은 승인 root의 realpath containment를 검증한다.

Gateway의 인증·source policy·CSRF·Origin 계약은 변경하지 않는다. OpenCode가 실행하는 shell과 모델
tool은 설치 OS 사용자 권한이다. 이 adapter는 OpenCode tool 실행에 OS sandbox를 추가하거나 Naru
DurableSession의 controller semantics를 OpenCode PTY에 부여하지 않는다.

## Build and compatibility

Node 24와 pnpm으로 `pnpm --filter @naru/opencode-gateway build`를 실행한다. 별도 임시 디렉터리에
공식 OpenCode `v1.18.35` archive를 풀고 아래 순서로 공식 UI를 빌드한다.

```sh
node ops/workstation/opencode/prepare-ui.mjs <extracted-opencode-v1.18.35>
pnpm --dir <extracted-opencode-v1.18.35> install --ignore-scripts
OPENCODE_CHANNEL=prod pnpm --dir <extracted-opencode-v1.18.35> --filter @opencode-ai/app build
```

Upstream commit은 `53d1eabb61e21162157817bf677da0a4ad3332e3`, source archive SHA256은
`3092a7b9f55d80c42a9c1bb2e2cc0a9961316673faf92b741577257a1576dd59`이다. 준비 스크립트는 UI router,
same-origin fetch, protocol probe와 SSE/V2 client path를 조정한다. Public metadata와 manifest도
`/omo/`에 한정한다. Gateway CSRF는 memory에만 보관하며 명시적 `CSRF_DENIED`만 한 번 refresh/retry한다.
버전 또는 알려진 integration point가 달라지면 build를 거부한다. Backend executable SHA256도 매
시작 때 확인하므로 CLI 자동 교체 후에는 재검증한 새 설정이 필요하다.

Adapter 0.1.1의 additive `GET /omo/api/_naru/project-roots`는 인증된 owner에게만
`{ version: 1, defaultDirectory, roots }`를 `no-store`로 전달한다. 각 경로는 기존 config의 canonical
approved root이며 요청마다 realpath containment를 다시 확인한다. UI는 이 목록 안에서 폴더명과
전체 경로를 검색하며 Mac home이나 `/`에서 검색을 시작하지 않는다. 이전 adapter에는 이 endpoint가
없으므로 새 UI와 adapter를 같은 release로 교체한다. 기존 Gateway/adapter config v1은 불변이다.

공식 UI의 route classifier는 `/omo`를 제외한 pathname을 읽고 실제 browser URL과 tab link는
`/omo/`를 유지한다. Solid transition 중 새 draft/context와 command 등록의 초기값을 제공해
프로젝트 선택, 새 세션, 첫 메시지 후 session 전환과 reload/reconnect를 연결한다.

UI source의 MIT license와 pinned pnpm lockfile을 독립 release와 함께 보존한다. OpenCode와 OmO의
provider login/agent routing은 각 도구의 사용자 설정이며 Codex·Claude Code 인증을 복사하지 않는다.

## Lifecycle and operations

`src/main.ts`는 owner-only v1 config, verifier public keys와 backend password를 읽는다. Backend와
adapter는 서로 다른 localhost port만 사용한다. Config에는 exact Gateway Origin/issuer/owner,
approved project roots, immutable UI root, executable digest와 각 private file reference가 필요하다.

독립 owner LaunchAgent는 로그인 후 `RunAtLoad`/`KeepAlive`로 실행한다. 자식 OpenCode 종료 시 job을
종료해 launchd가 재시작하고, job 종료 시 backend를 함께 종료한다. 실행 중 `caffeinate -i`로 idle
sleep만 막는다. 재부팅 직후 로그인 전 실행이나 FileVault 잠금 해제를 보장하지 않는다.

Service 설치/시작과 기존 Gateway의 `additionalGatewayApps`에 `{ appId: "omo", routePrefix: "/omo",
upstreamPort: <adapter-port> }`를 추가하는 `reconfigure`는 독립 승인 경계다. Receipt-owned Gateway
config를 직접 편집하지 않는다. 실제 CLI plan의 restart 범위와 fresh digest를 확인한 뒤 적용한다.
제거는 해당 registration만 제거한 새 reconfigure와 독립 job 중지를 각각 승인한다. 기존 OpenCode
세션·provider credential은 보존한다. Port forwarding, public bind, DNS/TLS/source-policy 변경은 없다.

이미 등록된 OmO의 UI/adapter update는 새 immutable release와 owner-only config/LaunchAgent 후보를
준비한 뒤 exact digest 승인을 받아 독립 OmO job만 교체한다. 기존 config에서 UI root 외의 필드를
보존하고 Gateway registration/config/receipt와 Naru/Host job은 변경하지 않는다. 이전 job의 PID 종료와
label 해제를 확인한 뒤 새 definition을 bootstrap하며 이전 release/definition은 복구용으로 보존한다.

로컬 검증은 `pnpm exec vitest run apps/opencode-gateway/test`, package typecheck/build, Gateway의
기존 auth/source/proxy regression과 아래 실제 UI fixture를 사용한다. 실제 운영 Passkey 및 Windows
기기 접속, provider login 뒤 유료 모델·멀티 에이전트 실행은 별도 인수다.

```sh
pnpm exec tsx ops/workstation/opencode/ui-smoke.ts <built-ui-dist> <installed-opencode-executable>
pnpm exec tsx ops/workstation/opencode/ui-smoke.ts <built-ui-dist> <installed-opencode-executable> --mobile-create
pnpm exec tsx ops/workstation/opencode/supervisor-smoke.ts <staged-release> <installed-opencode-executable>
```

Fixture의 새 certificate와 Chrome profile은 테스트 전용이며 운영 certificate/trust store/session을
사용하지 않는다. Fixture directory는 자동 삭제하지 않는다.

Mobile fixture는 360px touch 화면에서 폴더명·전체 경로 검색, 프로젝트 선택, titlebar `+`, 실제 backend
session 생성, reload/SSE reconnect와 두 번째 draft 전환을 검증한다. 유료 모델 호출은 fixture에서만
응답을 대체한다. 1440/768/360px·동적 viewport와 keyboard focus, ErrorBoundary 화면도 확인한다.

Supervisor fixture는 compiled release와 포함된 Node로 두 차례 시작·종료하고 OmO agent load,
unsigned 요청 거부, backend password와 executable digest 거부를 확인한다. Live OpenCode data와
credential 대신 fixture-only data/cache를 사용한다.
