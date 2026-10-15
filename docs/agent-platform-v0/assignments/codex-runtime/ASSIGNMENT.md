# 과제: Codex 런타임 기술 검증 (V01, V02, V04, V11, V08 Codex 측)

```yaml
protocol: naru-coordination/v0
type: task.assigned
taskId: ap-codex-runtime-spikes
sender: integration
recipient: codex-runtime-worker
baseSha: 4eb5433
branch: spike/codex-runtime
```

## 0. 역할과 범위

- 당신은 Naru Agent Platform 전환의 **Codex 런타임 검증 worker**다. integration(root)은
  `upgrade/orchestration` 브랜치의 Claude Code 세션이며 계약 문서·`docs/TASKS.md`·공통 fixture·
  migration 번호를 소유한다. 메시지 규약은 `docs/AGENT_COORDINATION.md`를 따른다.
- 이번 과제는 **구현이 아니라 검증**이다. 결과는 이후 ADR과 Codex 어댑터 설계의 근거가 된다.
  지원 여부는 설치된 실제 버전에서 재현한 동작만으로 판정하고, 공식 문서에 적혀 있다는 이유만으로
  PASS를 주지 않는다.
- 이 worktree(`spike/codex-runtime`)만 수정한다. 제품 코드(`apps/`, `packages/`, `ops/`)는 바꾸지
  않는다. 기존 모듈 동작을 확인하려면 spike 코드에서 import하거나 감싸서 사용한다. 제품 코드를
  바꿔야만 검증할 수 있다면 `decision.request`를 남기고 다른 항목을 계속한다.

### 먼저 읽을 것

1. `AGENTS.md` (저장소 규칙, 보안·운영 경계)
2. `docs/agent-platform-v0/SOURCE_SPEC.md`: 사용자와 합의한 목표 명세 원문. 특히 §2 INV-01~~10,
   §6, §7(GUI/TUI·어댑터), §8.1, §8.3, §14(V01~~V14, P0 판정)
3. `docs/ARCHITECTURE.md`의 "상태와 연속성"(Codex guardian·relay 구조)
4. `docs/DECISIONS.md`의 D009, D012, D025와 `docs/codex-socket-compatibility.md`
5. `docs/durable-session/SPEC.md` §3~§9 (V11에 필요)

## 1. 안전 경계 (반드시 지킬 것)

- **이 Codex 세션 자체가 운영 Naru Host PTY 안에서 실행된다.** Naru, Gateway, DurableSession Host,
  launchd job, 전역 `codex app-server daemon`, 그리고 직접 띄우지 않은 어떤 process도 중지·재시작·
  signal하지 않는다. 정리할 때는 spike가 띄운 PID만 기록해 두었다가 종료한다.
- 운영 Workstation instance 디렉터리, 운영 socket, credential, Naru DB를 읽거나 쓰지 않는다.
  `~/.codex/config.toml`을 수정하지 않는다. CLI 설치·업데이트를 하지 않는다(현재 `codex-cli 0.162.1`).
- DurableSession이 필요한 검증은 **격리 Host**로만 한다. `apps/durable-session-host/test/support.ts`,
  `apps/durable-session-host/test/actual-host.acceptance.test.ts`,
  `apps/server/test/codex-acceptance-fixture.ts`의 격리 패턴(임시 root, 임시 socket과 credential)을 따른다.
- Codex 실행 모드는 두 가지다.
  - **fake model**: `codex-acceptance-fixture.ts`처럼 임시 HOME/CODEX_HOME과 로컬 synthetic
    Responses 서버를 쓴다. protocol·중재·전환 검증에는 이 방식을 먼저 쓴다.
  - **real model**: 사용자가 검증 기간의 넉넉한 사용을 승인했다. 단, 인증 정보를 복사하지 말고 기본
    CODEX_HOME을 그대로 쓴다. 이 경우 사용자 Codex 기록에 thread가 남으므로 첫 prompt를
    `[naru-spike]`로 시작해 식별할 수 있게 한다. 작업 디렉터리는 저장소 밖 scratch git repo
    (`../../experiments/naru-agent-spikes/codex-runtime/workspace/`)를 사용한다.
- **원문 로그**(JSON-RPC frame, prompt, 모델 출력, terminal 화면)는 저장소 밖
  `../../experiments/naru-agent-spikes/codex-runtime/logs/`(owner-only)에만 둔다. 저장소에는 재현
  스크립트, method/event 이름, 필드 구조, 순서, 그리고 redacted 요약만 남긴다. token, 실제 path·
  domain·IP, transcript 문장은 커밋하지 않는다. 커밋 전에 `pnpm public:scan`을 실행한다.
- remote push, 배포, service install/restart, browser permission 변경은 하지 않는다.

## 2. root가 이미 확인한 사실

- 현재 Codex Pane은 Host PTY 안의 launcher → guardian가 `codex app-server`(private UDS)와
  `codex --remote <relay.sock>` TUI를 함께 소유한다. `apps/server/src/codex-interaction-relay.ts`가
  TUI↔app-server WebSocket을 투명 중계하며 client는 최대 4개, 첫 연결이 primary다(보조 연결은 원격
  `/resume` picker용). relay는 request ID와 `serverRequest/resolved`, turn lifecycle만 메모리에서 추적한다.
  즉 **A안(공유 App Server)의 구조는 이미 있다.** 아직 확인되지 않은 것은 두 client가 같은 thread를
  동시에 다룰 때 app-server가 어떻게 동작하는지와, relay 계층에서 writer를 하나로 강제할 수 있는지다.
- `codex app-server`는 help에 `[experimental]`로 표시된다. 설치 버전의 protocol 원본은 다음
  명령으로 생성해 기준으로 삼는다(출력은 logs 디렉터리에 둔다).
  `codex app-server generate-json-schema`, `codex app-server generate-ts`
  공식 문서는 출발점일 뿐이다: https://developers.openai.com/codex/app-server
- 기본 Codex Pane 인수는 `apps/server/src/launch-profiles.ts`의 `codexArguments`에 있다
  (`workspace-write`, `on-request`, effort, service tier. 기본 Pane은 model을 지정하지 않음).

## 3. 검증 항목

각 항목마다 무엇을 확인할지, 어떻게 확인할지, 무엇을 증거로 남길지, 판정 기준을 정리했다. 결과는
`PASS / PARTIAL / FAIL / NOT TESTED`로 기록하고 정확히 어디까지 지원되지 않는지, 안전한 fallback,
사용자 결정 필요 여부를 함께 쓴다.

### V01. 공유 App Server와 writer 중재 (P0)

확인할 것:

1. 두 client가 같은 app-server에 연결해 **같은 thread**에 동시에 붙을 수 있는가? 한쪽은 실제
   `codex --remote` TUI, 다른 쪽은 spike의 GUI용 JSON-RPC client다. 두 client가 thread의
   item/turn event를 모두 live로 받는가?
2. **TUI가 자기가 시작하지 않은 turn**(GUI가 보낸 turn)을 화면에 live로 렌더하는가? 이 결과가
   "GUI와 TUI가 같은 대화를 보여 준다"는 주장의 핵심 근거다.
3. turn 진행 중이거나 동시에 두 client가 turn을 시작하면 app-server는 어떻게 하는가? 거부하는가,
   queue하는가, 섞이는가? 기본으로 제공되는 중재가 있는가?
4. 승인·elicitation 같은 server request는 어느 client로 가는가(전체 또는 시작한 쪽)? 두 client가
   모두 응답하면 어떻게 되는가?
5. relay 같은 proxy에서 **single writer gate**를 강제할 수 있는가? writer가 아닌 channel의 변경
   method는 결정적인 JSON-RPC 오류로 거부하고, read와 구독은 허용한다. 생성한 schema를 근거로 method를
   `read / conversation-write / approval-response / settings` 등으로 분류한 표를 만든다.
6. turn 경계에서 writer를 GUI→TUI→GUI로 이전할 수 있는가? 진행 중인 turn은 완료를 기다릴지
   `interrupt`할지 비교한다. 이전 뒤에도 thread ID와 이력이 그대로인지 확인한다.

방법: 격리 app-server(UDS) 하나와 spike proxy를 만든다. 제품 relay를 바꾸지 않고 같은 형태의 proxy를
spike에 구현한다. TUI는 node-pty나 격리 Host에서 실행하고 화면은 `@xterm/headless`로 직렬화해 비교한다.

증거: frame 순서 요약(method 이름, 방향, channel), TUI 화면 snapshot의 redacted 판정 결과,
재현 명령.

PASS 기준: 같은 thread를 양쪽에서 live로 관찰할 수 있고, 동시 write는 native 기능이나 proxy로
결정적으로 차단되며, 이전 뒤 thread와 이력이 보존된다.

### V02. Stop/Release → TUI Resume → GUI 복귀 (P0, A안 실패 시 fallback)

- GUI 전용 app-server에서 thread를 진행한다 → turn 완료를 기다리거나 interrupt한다 → GUI
  client를 닫고 app-server를 종료한다 → TUI를 `codex resume <id>`로 실행하거나 `--remote` 뒤
  `thread/resume`으로 연다 → TUI에서 turn을 진행한다 → TUI를 종료한다 → GUI가 다시
  `thread/resume`한다 → TUI에서 진행한 turn이 이력에 있는지 확인한다.
- 실패를 주입해 본다: 존재하지 않는 ID로 resume, TUI를 turn 도중 kill, app-server crash. 각 경우
  thread 상태와 부분 turn이 저장되는지, 어떤 rollback이 가능한지 기록한다.
- **K1 근거로 꼭 확인할 것**: app-server를 재시작한 뒤 GUI가 **app-server API만으로**
  (thread 읽기·resume 응답의 item 등) Chat 화면 전체 이력을 다시 구성할 수 있는가? Naru가
  transcript를 따로 저장하지 않아도 되는지가 여기에 달려 있다. rollout 파일을 직접 파싱하는 방식은
  비공식 경로로 간주하고 따로 표시한다.

### V04. Codex native subagent: L1 lifecycle, L2 transcript, L3 interactive, L4 PTY

- 0.162.1에 있는 multi-agent·subagent 관련 기능을 찾는다. `codex features list`를 보고, 생성한
  schema에서 agent/spawn/collab/subagent 관련 item·notification을 찾는다. real model이 필요하다.
- 기능마다 다음을 확인한다.
  - L1: 생성과 종료 event, 자식 ID, 부모 ID
  - L2: 자식의 진행 내용이 실시간으로 오는가(어떤 notification, 자식별 thread ID 존재 여부)
  - L3: 실행 중인 자식 thread에 client가 직접 메시지를 보낼 수 있는가
  - L4: 자식이 독립 PTY나 TUI를 가지는가
- config로 native subagent를 끄거나 제한할 수 있는지(SOURCE_SPEC §8.1의 "native 억제")도 확인한다.

### V11. App Server process와 DurableSession 연결

- TUI 없이 app-server와 GUI client만 쓰는 "headless Codex agent"를 격리 DurableSession Session 안에서
  실행한다. 다음을 확인한다.
  - (a) PTY에 observer가 attach되거나, controller가 바뀌거나, resize가 일어나도 private UDS
    JSON-RPC protocol이 손상되지 않는가
  - (b) PTY에 사용자가 attach해 볼 수 있는 관찰용 console을 띄울 수 있는가. 예: redacted event를
    한 줄씩 출력하는 작은 renderer. 이 console은 protocol channel과 분리돼야 한다.
  - (c) PTY 입력이 protocol을 오염시키지 않는가
  - (d) Host를 재시작하면 Session이 정직하게 stopped로 표시되고, thread는 런타임 저장소에서
    resume할 수 있는가
- 기존 relay 구조에 GUI channel을 추가하는 방식과 비교한 짧은 설계 메모를 남긴다. 코드는 바꾸지 않는다.

### V08. Codex 측 agent 간 통신

- Codex에 thread 간 native 메시징이나 handoff 기능이 있는지 확인한다(subagent 제외).
- managed 경로 prototype을 만든다. stdio MCP stub(`naru_stub`)에 tool 두 개를 둔다:
  `send_message(to, verbatim, origin_instruction_id)`와 `inbox()`. 저장은 임시 JSON 파일로 한다.
  Codex thread 두 개가 이 stub으로 메시지를 주고받게 하고, 발신자·원문·원본 지시 ID가 손실 없이
  전달되는지 확인한다.
- **K2/K3 근거로 꼭 확인할 것**: MCP server를 app-server나 thread에 붙이는 방법(`-c mcp_servers...`,
  thread 시작 시 설정 등)을 정리한다. **thread·세션별로 다른 env(예: 세션 전용 token)를 MCP server
  process에 주입할 수 있는지**도 확인한다. 세션마다 MCP를 따로 띄울 수 있는지, app-server 하나에서
  공유되는지도 기록한다.
- Codex↔Claude 왕복은 root가 맡는다. stub의 tool interface는 README에 문서화해 재사용할 수 있게 한다.

### 추가 조사 X1, X2

- X1: TUI에서 사용자가 직접 입력한 prompt가 relay를 지나는 method와 params의 **구조**를 정리한다
  (원문은 커밋하지 않음). Naru가 관리하는 agent 세션에서 사용자 직접 지시를 기록할 수 있는지 판단하는
  근거로 쓴다.
- X2: app-server의 model 목록 API로 실제 사용 가능한 model ID를 기록한다(SOURCE_SPEC §3.2의 역할별
  후보 모델 확인용).

## 4. 산출물

- `tests/spikes/codex-runtime/`
  - TypeScript 스크립트. Node 24에서 `node --import tsx <script>`로 실행한다. 이 경로는 root
    `tsconfig.json`의 `tests/**/*.ts`에 포함되므로 `pnpm typecheck`와 `pnpm lint`를 통과해야 한다.
  - 파일명에 `.test.ts`를 쓰지 않는다. 쓴다면 env gate(`skipIf`)로 기본 `pnpm test`에서 빠지게 한다.
  - real model 스크립트는 `NARU_SPIKE_REAL_MODEL=1`이 있을 때만 실행되게 한다.
  - `README.md`에 항목별 실행 명령, 전제 조건, 정리 방법을 적는다.
- `docs/agent-platform-v0/validation/codex-runtime.md`
  - 항목별 상태(`PASS/PARTIAL/FAIL/NOT TESTED`), 설치 버전, 재현 명령, 증거(redacted 발췌와
    logs 디렉터리의 파일명), 정확한 미지원 범위, 안전한 fallback, 사용자 결정 필요 여부
  - V01의 method 분류 표
  - **Codex 0.162.1 Capability Matrix 초안**: SOURCE_SPEC §7.3의 `RuntimeCapabilities` 필드를
    보수적으로 채운다. 검증하지 못한 값은 `false` 또는 `none`으로 둔다.
  - root가 ADR에 쓸 수 있도록 A안과 B안 중 권고와 근거
- 완료 시 같은 디렉터리에 `HANDOFF.yaml`(`type: handoff.ready`, `docs/AGENT_COORDINATION.md` 형식)을
  둔다. 진행 중 막히면 `DECISION_REQUEST.yaml`(`type: decision.request`, `canContinue` 포함)을 남기고
  독립 항목을 계속한다.
- 변경은 `spike/codex-runtime` 브랜치에 commit만 한다. push하지 않는다. 커밋 전에 변경 파일의
  `pnpm exec prettier --check`, `pnpm lint`, `pnpm typecheck`, `pnpm public:scan`을 실행한다.

## 5. 판정 원칙

- 설치 버전에서 재현한 동작만 PASS로 판정한다. 문서·이전 조사·추정은 근거로만 인용한다.
- 지원되지 않는 기능을 유사한 방식으로 흉내 내 성공처럼 보고하지 않는다. 예: 로그로 가짜 TUI를 만들기.
  live attach가 안 되면 안 된다고 쓴다.
- 비공식 경로(rollout 파일 파싱, 비공개 method 등)로만 가능한 것은 `PARTIAL (unofficial)`로 표시하고
  권고에서 분리한다.
- 막힌 항목은 `PARTIAL`이나 `NOT TESTED`로 정확히 기록하고 다음 항목으로 넘어간다. 완료하지 않은
  작업을 완료로 쓰지 않는다.
