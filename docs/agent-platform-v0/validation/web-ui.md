# AP-T17 검증: 에이전트 웹 화면과 secure input

- 날짜: 2026-10-15. 환경: macOS arm64, Node 24.19(LTS), 격리 DurableSession Host, 임시 디렉터리.
- 실행 방법: `pnpm build`(web은 `NARU_APP_BASE_PATH=/`) 뒤 UI sandbox를 띄운다.

  ```sh
  node --import tsx tests/spikes/agent-platform/ui-sandbox.ts
  ```

  - sandbox 구성: 빌드한 Naru 서버와 web, 격리 Host, 임시 project, 가짜 runtime이다.
  - 가짜 runtime: 같은 export를 가진 SDK stand-in, `SessionStart` hook을 부르는 Claude TUI stand-in,
    `apps/server/test/fake-codex.ts`를 쓴다. 모델과 계정은 쓰지 않는다.
  - SDK stand-in은 에이전트 자신의 Naru MCP capability로 실제 경로를 탄다. turn에 다음 단어가 있으면
    해당 동작을 한다.
    - `PLAN`: 의도 계약 제안, 계획, 의존 관계가 있는 작업 3개, Run과 진행 보고
    - `DEMO`: 공유 프로세스와 직접 테스트 요청
    - `APPROVE`: 도구 승인 요청
  - 비밀번호는 실행할 때마다 새로 만든 테스트 값이다. 종료(SIGTERM)하면 임시 디렉터리를 지운다.

- 브라우저:
  - 1440px와 768px, 동적 resize는 Chrome에서 확인했다.
  - Chrome 창은 500px보다 좁아지지 않는다. 그래서 360px은 저장소의 Playwright Chromium으로 확인했다
    (360×740, touch, mobile).
  - 서버는 iframe 삽입을 거부한다. 이 설정은 바꾸지 않았다.
- 운영 instance와 사용자 세션은 건드리지 않았다.

## 결과

| 항목                                                                           | 근거                                     | 상태     |
| ------------------------------------------------------------------------------ | ---------------------------------------- | -------- |
| 전체 현황: 프로젝트별 작업·결정 대기·에이전트 수, Main Orchestrator 시작·대화  | 1440, 768, 360 화면                      | **PASS** |
| Main Orchestrator에게 지시만 보내기(project 없는 agent scope)                  | 1440 화면, 기록 응답                     | **PASS** |
| 프로젝트 지시 원문 기록과 최근 지시 표시                                       | 1440 화면                                | **PASS** |
| Project Orchestrator 시작, Chat 개입, `PLAN` turn이 MCP로 계획·작업 생성       | 1440 화면, 이벤트                        | **PASS** |
| 의도 계약 제안 표시와 승인(키보드 Enter), 승인 뒤 현재 계약으로 표시           | 1440 화면, `agent-platform-http.test.ts` | **PASS** |
| 의도 계약 승인은 사람 기기 lease 없이 거부(409)                                | `agent-platform-http.test.ts`            | **PASS** |
| 작업 그래프: 의존 단계별 배치, 선행 작업 표시                                  | 1440, 768, 360 화면, `agent-task-graph`  | **PASS** |
| 작업 노드: Run(시도·상태·진행 요약), 리뷰, 산출물, 병합 조건                   | 화면, `agent-platform-http.test.ts`      | **PASS** |
| Agent Panel 활동 탭: 이벤트, 관련 작업 이름, 관계                              | 1440, 360 화면, `agent-events.test.ts`   | **PASS** |
| 대화·활동 탭의 방향키 이동과 focus 표시                                        | Chrome 키보드                            | **PASS** |
| Claude 작업자: Chat 개입, turn, 도구 승인 요청 표시                            | 1440, 768, 360 화면                      | **PASS** |
| Codex 작업자 생성과 Chat 개입, turn 전달(202, 가짜 Codex가 turn 수신)          | Playwright 1440                          | **PASS** |
| Inbox 직접 테스트 요청 열기, 선택지와 결정                                     | 360 화면(이전 1440 키보드 확인)          | **PASS** |
| 공유 프로세스: 개입하면 작업공간 터미널이 열리고, 반환하면 에이전트에게 돌아감 | 360 Playwright                           | **PASS** |
| 768px: 목록과 상세를 위아래로 배치, polling 중 상세 scroll 유지                | Chrome(scrollTop 150 → 10초 뒤 150)      | **PASS** |
| 360px: 목록과 상세를 전환(`← 목록`), 모든 화면에서 가로 넘침 0px               | Playwright 10개 화면                     | **PASS** |
| 키보드: 새 control 모두 Tab으로 이동하고 2px focus outline을 표시              | Playwright Tab 40회 기록                 | **PASS** |
| 기록 전환 시 상세 scroll을 맨 위로 되돌림                                      | 화면                                     | **PASS** |
| 실제 Codex·Claude 모델의 이력이 대화 탭에 그려짐                               | 단위 테스트(`agent-history.test.ts`)만   | 미검증   |

- 가짜 Codex는 turn을 item 없이 기록한다. 그래서 Codex 작업자의 대화 탭은 비어 있다. 실제 Codex 이력의
  item 형태(`userMessage`, `agentMessage`, `commandExecution`, `mcpToolCall`)는 단위 테스트로만
  확인했다. 실제 모델 인수(AP-T18)에서 화면으로 확인한다.

## secure input(AP-D003, AP-T12)

| 항목                                                                                | 근거                                    | 상태     |
| ----------------------------------------------------------------------------------- | --------------------------------------- | -------- |
| shell Pane에만 `비밀 입력`이 보인다. Claude·Codex Pane과 observer일 때는 없다       | 화면                                    | **PASS** |
| 마우스로 열고 보내면 실제 zsh `read -s` 프롬프트에 값이 들어간다                    | 셸 비교 결과 일치                       | **PASS** |
| 키보드만으로 연다(Shift+Tab → 도구 모음 → Enter). 값은 화면에 나오지 않는다         | 셸 SHA-256 앞 12자리가 로컬 계산과 일치 | **PASS** |
| 보내면 입력란을 닫고 terminal로 focus를 돌린다. Escape는 보내지 않고 닫는다         | 화면, focus 확인                        | **PASS** |
| browser `localStorage`·`sessionStorage`에 값이 없다                                 | 저장소 검사                             | **PASS** |
| 격리 sandbox의 Naru DB, Host 상태, 서버 로그, 가짜 runtime 로그 어디에도 값이 없다  | sandbox 디렉터리 전체 검색 결과 0건     | **PASS** |
| `terminal.input` frame에 `secure: true`가 붙고, 일반 입력에는 붙지 않는다           | `terminal-connection.test.ts`           | **PASS** |
| 360px에서 에이전트 공유 프로세스를 개입한 뒤 열린다. password 입력란에 focus가 간다 | Playwright 360                          | **PASS** |

- 같은 시험의 일반 입력으로 친 명령줄(fixture 값 포함)은 terminal에 보인다. 그래서 디스크 검색은 화면에
  나오지 않은 두 번째 fixture 값으로 했다.
- Host 입력 중복 제거 fingerprint는 process마다 만든 key의 HMAC-SHA-256으로 바꿨다. 이전에는 salt 없는
  SHA-256을 메모리에 60초 두었다(V10 후속). 중복 제거 동작은 기존 Host 테스트로 확인했다.
- 한계: 프로그램이 직접 출력하는 값은 secure input으로도 숨길 수 없다. 입력란 아래 안내문에 그렇게
  적었다.

## 남은 일

- Home의 리소스 사용량과 최근 성과 요약은 아직 수집하지 않는다. 화면에 그렇게 표시한다(AP-T19에서
  범위를 정한다).
- `콘솔 보기`·`TUI 보기`는 지금 연 프로젝트의 작업공간에서 Pane을 찾는다. 그래서 Main Orchestrator의
  Pane이 다른 프로젝트에 있으면 열지 못한다. 이것은 코드로 확인한 한계이고, 화면으로 시험하지 않았다.
- 웹 빌드를 바꾸면 Naru 서버를 다시 시작해야 새 asset을 제공한다. 이것은 기존 동작이다. sandbox도
  재시작해야 한다.

# AP-T20 검증: 에이전트 화면 재설계 (AP-D022)

- 날짜: 2026-10-16. 환경은 위와 같다(격리 Host, 임시 디렉터리, 가짜 runtime). 운영 instance와 사용자
  세션은 건드리지 않았다.
- sandbox의 SDK stand-in을 `ui-sandbox-sdk.mjs`로 옮기고 넓혔다.
  - Claude session과 같은 모양의 이력을 만든다: 생각, 도구 호출과 결과, markdown 답.
  - 모든 동작은 에이전트 자신의 Naru MCP capability로 한다. 메인 오케스트레이터는 `@project`로 언급된
    project의 오케스트레이터를 띄우고 `PLAN`을 위임한다. 프로젝트 오케스트레이터는 의도 계약, 계획,
    작업자 둘과 리뷰어 하나, 의존 관계가 있는 작업 넷을 만들고 작업자에게 위임한다. 작업자는 편집,
    명령 승인 요청(`APPROVE`), 결정 요청(`ASK`)을 한다.
- 브라우저: 저장소의 Playwright Chromium(1440×900, 768×1024 touch, 360×740 touch, 동적 resize).

| 항목                                                                                    | 근거                                                                           | 상태     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| 관제실 입력창에서 목표를 보내면 메인 → 프로젝트 오케스트레이터 → 작업자로 팀이 만들어짐 | 1440 화면: project 둘의 그래프, 승인 2, 결정 2, 의도 계약 2                    | **PASS** |
| 작업 흐름 그래프: 단계, 곡선 연결선(진행 중 연결선 움직임), 담당, 나를 기다림 표시      | 1440·768 관제실과 흐름 화면                                                    | **PASS** |
| 나를 기다리는 것: 승인을 그 자리에서 답함, 결정·의도 계약은 시트에서 답함               | 1440 화면(선택지로 결정 → 카드 사라짐), 키보드로 시트 열기·Esc 닫기·focus 복귀 | **PASS** |
| 대화: 요청 말풍선(오케스트레이터 이름, 원본 지시), 답은 글, 도구·생각은 접힌 회색 줄    | 1440·768·360 화면, `agent-conversation.test.ts`                                | **PASS** |
| 대화 안의 승인과, 직접 써서 이어받기(구분선, 내 말풍선, 답, 돌려주기)                   | 1440 화면: 승인 → 보내기 → hold와 turn                                         | **PASS** |
| 작업 맥락: 맡은 작업, 진행 단계, 완료 조건, 산출물, 리뷰와 병합 조건, 프로세스, 동료    | 1440 화면, 768은 버튼으로 여는 겹침 패널                                       | **PASS** |
| 흐름: 선택한 작업의 기록·산출물·병합 조건, 휴대폰은 단계 목록과 아래 시트               | 1440·768·360 화면                                                              | **PASS** |
| 타임라인: turn, 사람 hold, 질문, 병합                                                   | 1440 화면, `agent-model.test.ts`                                               | **PASS** |
| 가로 스크롤 없음, 콘솔 오류 없음                                                        | 1440·1024·768·600·360·1280×640 resize, 모든 화면에서 0                         | **PASS** |
| 키보드와 focus 표시                                                                     | Tab 이동마다 2px outline, 메뉴 화살표 이동, 시트 focus                         | **PASS** |
| 실제 Claude·Codex 이력이 같은 모양으로 그려짐                                           | 이력 모양은 SDK 타입과 Codex 생성 타입으로 맞춤, 단위 테스트                   | 미검증   |

- 고친 것(검증 중 발견):
  - 칩을 누르면 focus가 칩으로 가서 입력이 칩에 들어감. 칩이 focus를 가져가지 않게 하고, caret을 commit
    직후에 놓는다.
  - list reset이 component 여백을 덮음(`:where()`로 바꿈). 접힌 줄의 음수 margin 때문에 글자가 잘림.
  - project가 여럿이면 작업자 번호가 겹침. 목록에 project 이름을 붙인다.
  - 768px 대화 머리말 제목이 사라짐. 휴대폰 흐름 그래프가 한 단계만 보임(단계 목록으로 바꿈).
  - 승인을 기다리는 turn에 "일하는 중 · N초"가 보임. "승인을 기다리는 중"으로 바꿈.
- 남은 것: 실제 모델 이력으로 그려지는지는 테스트 앱(naru-next)에서 사용자가 확인한다.

# AP-T22 1단계 검증: 위쪽 메뉴, 작업공간 세로 목록, 쓰는 사람 표시 (AP-D027~D031)

- 날짜: 2026-10-16. 격리 sandbox(`ui-sandbox.ts`, 임시 Host·DB, 가짜 runtime). 운영 instance와 테스트
  앱(naru-next)은 건드리지 않았다.
- sandbox는 공백이 없는 경로의 Node 24로 띄운다. Claude stand-in의 shebang이 `process.execPath`라서, 경로에
  공백이 있으면(`Application Support` 아래 Node) 에이전트 runner가 `CLAUDE_AUTH_REQUIRED`로 실패한다.
- 브라우저: 저장소의 Playwright Chromium(1440×900, 768×1024, 360×740). 검사 script는 `test-results/ap-t22/`
  (git 밖)에 두었다.

| 항목                                                                                      | 근거                                                                  | 상태     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| v21 마이그레이션: 보이던 배치는 "내 배치", "기본"은 빈 자리와 함께, Pane·legacy 그대로    | `workspace-views.test.ts`(v20 DB에서 올림, 공유 프로세스 터미널 제외) | **PASS** |
| 작업공간 만들기·저장·삭제, 작업공간별 version 충돌, 32개 제한, 잘못된 배치 거부           | `workspace-views.test.ts`, `app.test.ts`(lease·CSRF 거부 포함)        | **PASS** |
| 작업공간 안에서 새 Pane: 빈 자리 채우기, 옆에 나누기, 빈 작업공간                         | 같은 테스트, 1440 화면 "Claude 시작"                                  | **PASS** |
| Pane 끄기가 모든 작업공간에서 그 Pane을 뺌, 작업공간 삭제는 Pane을 끄지 않음              | 같은 테스트                                                           | **PASS** |
| 이름 바꾸기와 원래 이름으로, board의 `paneNames`, 관제실에 바꾼 이름                      | 테스트, 1440 화면(관제실의 에이전트 이름)                             | **PASS** |
| 처음 화면은 관제실, 메뉴 셋, rail 없음, 휴대폰에서도 세 항목                              | 1440·768·360 화면                                                     | **PASS** |
| 세로 목록: 작업공간 추가 → 이름 → ＋로 넣기 → 끌어 놓기 → 완료, 다시 읽어도 유지          | 1440 화면 흐름 10단계                                                 | **PASS** |
| 에이전트 Pane이 목록에 `에이전트`로 보이고, 머리줄에서 끼어들기 → `나 · 끼어든 중` → 놓기 | 1440 화면, 관제실 목표로 만든 팀                                      | **PASS** |
| 768px은 목록이 서랍, 360px은 목록부터 보이고 칩으로 Pane과 빈 자리를 고름                 | 768·360 화면                                                          | **PASS** |
| 가로 스크롤 없음, page error 없음, Tab 이동마다 focus outline                             | 1440·768·360                                                          | **PASS** |
| 새 화면이 없는 server(agent API 없음)의 가로 탭 화면                                      | `pnpm test:e2e` 29개 중 27 통과, 실패 2개는 아래                      | **PASS** |

- e2e 실패 2개는 이번 변경과 관계없는 기존 불안정으로 확인했다.
  - `terminal-stability` "same-runtime reconnect": 단독 재실행 2회 모두 통과.
  - `mobile-output-copy` "touch로 출력 복사": 변경 전 코드(`ce237a6`, 이후 커밋은 문서뿐)에서도 4회 중 3회
    실패한다(clipboard에 앞 시험의 값이 남음).
- 고친 것(검증 중 발견):
  - 768px에서 목록이 Pane 폭을 줄여 머리줄과 제목이 깨짐 → 601~1100px은 목록을 서랍으로 연다.
  - 집중 보기와 휴대폰에서 빈 자리(예: Claude 자리)를 고를 수 없음 → 칩에 빈 자리를 넣었다.
  - 관제실의 "메인 오케스트레이터 · …"와 프로젝트 오케스트레이터 칩이 이름을 고정 문구로 씀 → 바꾼 이름을
    쓰게 했다.
- 하지 않은 것(1단계 범위 밖이거나 남은 것):
  - 대화를 에이전트 Pane으로 옮기기, 맡긴 일 작업공간(2단계).
  - 내 Pane에 대한 에이전트의 쓰기 요청과 허락(AP-D030). 에이전트가 사람 Pane에 쓰는 MCP 경로가 아직 없다.
    hold 중 거부된 시도를 요청으로 보여 주는 것도 남았다.
  - 편집 화면의 배치 틀(1·2·3·4칸) 고르기. 지금은 끌어 놓기와 경계 끌기로 배치한다.
  - 머리줄 제목을 두 번 눌러 이름 바꾸기. ⋯ 메뉴의 이름 바꾸기만 있다.

# AP-D033 검증: 꺼진 에이전트 정리

- 날짜: 2026-10-16. 격리 sandbox와 Playwright Chromium 1440.
- 단위·route 테스트:
  - `agent-platform-core.test.ts`: 실행 중인 에이전트가 섞이면 아무것도 바꾸지 않음, 에이전트 actor 거부, 같은
    요청 재시도는 한 번만 적용, 목록에서 빠짐, 지시 기록 유지, 위임·실행·hold 거부.
  - `agent-platform-http.test.ts`: lease 없으면 거부, Pane 제거, board `retiredAgents`, 실행 중이면 409.
  - `agent-model.test.ts`: 정리 대상 고르기, 정리 뒤에도 번호 유지.
- 화면: 관제실에서 목표로 팀을 만든 뒤 리뷰어와 작업자 2를 대화 메뉴로 정지 → "꺼진 에이전트 정리 2" → 시트에서
  작업자 2 체크를 뺌 → "1개 정리" → 리뷰어만 관제실 목록과 작업공간 목록에서 사라지고, 작업자 2는 남아 이름이
  그대로다. page error 없음.
- 한계: 휴대폰 관제실에는 에이전트 목록이 없어 정리 버튼도 없다. 1440·768에서 쓴다.

# AP-D034 검증: 멈춘 일 알아차리기, 맡긴 일 카드, 위임 확인

- 날짜: 2026-10-16. 격리 sandbox(`SANDBOX_STALL_MINUTES=1`, 임시 Host·DB, 가짜 runtime)와 Playwright
  Chromium. 운영 instance와 테스트 앱은 건드리지 않았다. 검사 script는 `.local/ap-t22/`(git 밖)의 `jobs.mjs`,
  `jobs-finished.mjs`, `pane-menu.mjs`다.
- sandbox stand-in에 목표 낱말을 더했다(`ui-sandbox-sdk.mjs`):
  - `QUIET`: 묻지 않는 작업자. 팀이 멈출 수 있다.
  - `LIVE`: 도구 호출 하나를 stream으로 보내고 45초 머문다.
  - `MISDELEGATE`: 리뷰를 task scope로 리뷰어에게 보낸다.
  - `FINISH`: 작업을 모두 끝낸다.

| 항목                                                                                            | 근거                                                    | 상태     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------- |
| scope와 다른 `delegate` 인자 거부, 사람이 끈 에이전트에게 위임 거부                             | `agent-platform-hitl.test.ts`                           | **PASS** |
| 잘못 보낸 리뷰가 리뷰어에게도 작업자에게도 가지 않음                                            | 1440 화면 흐름(`MISDELEGATE`, 에이전트별 지시 기록)     | **PASS** |
| 오케스트레이터가 사람이 프로젝트 에이전트에게 직접 한 말을 읽음                                 | `agent-platform-hitl.test.ts`                           | **PASS** |
| 작은 이벤트로 프로젝트 오케스트레이터를 깨우지 않음, 자기 등록은 깨움                           | `agent-platform-hitl.test.ts`, `agent-platform-wakeups` | **PASS** |
| 재시작 뒤와 지시할 때 꺼진 에이전트 다시 실행(10분에 한 번), 사람이 끈·잡은 에이전트는 그대로   | `agent-platform-hitl.test.ts`                           | **PASS** |
| 멈춤: 오케스트레이터 먼저, 그다음 사람, 진행하면 사라짐, 확인시키기 뒤 다시 오케스트레이터      | `agent-platform-hitl.test.ts`, `agent-platform-http`    | **PASS** |
| 사람이 기다리는 것이 있거나 일하는 중이면 멈춤으로 보지 않음, 원인 고르기                       | `agent-platform-hitl.test.ts`                           | **PASS** |
| 멈춘 팀이 관제실 "진행 멈춤"과 카드 배너에 원인·경과("2분째 그대로")와 함께 보임                | 1440 화면(`QUIET`, 의도 계약 승인 뒤 약 3분)            | **PASS** |
| 카드의 "오케스트레이터에게 확인시키기" 뒤 배너가 사라짐                                         | 1440 화면                                               | **PASS** |
| 기기 알림: 프로젝트마다 하나, 잘못된 payload 무시, 누르면 관제실(`NARU_PUSH_STALL`·`naruStall`) | `pwa-build.test.ts`                                     | **PASS** |
| 맡긴 일 카드: 큰 그림 단계, "작업 4개 중 1개 완료", 의존 순서 번호, "2·3번이 끝나면 시작합니다" | 1440 화면, `jobs-model.test.ts`                         | **PASS** |
| "지금" 줄과 에이전트 목록에 실행 중인 도구("Edit · src/session.ts")                             | 1440 화면(`LIVE`), Claude·Codex 변환은 hitl 테스트      | **PASS** |
| 끝난 일은 접혀 있고, 펼치면 단계가 모두 완료, 목표를 두 번 쓰지 않음                            | 1440 화면(`FINISH`)                                     | **PASS** |
| 에이전트 Pane 메뉴에 "Pane 끄기" 없음(내 Pane에는 있음), API도 409                              | 1440 화면, `agent-platform-http.test.ts`                | **PASS** |
| 768px, 360px(휴대폰은 지금 하는 일만, "나눈 일 4개 모두 보기"), 360×520 동적 viewport           | 화면, 가로 넘침 검사                                    | **PASS** |
| Tab으로 작업 줄에 닿고 focus outline이 보이며 Enter로 흐름 화면을 염                            | 1440 화면                                               | **PASS** |
| page error 없음, lint, typecheck, format, vitest 전체(1037)                                     | 명령 결과                                               | **PASS** |
| 기존 화면                                                                                       | `pnpm test:e2e` 29개 중 27 통과, 실패 2개는 아래        | **PASS** |

- e2e 실패 2개는 AP-T22 1단계 때와 같은 기존 불안정이다. `terminal-stability`는 단독 재실행에서 통과했고,
  `mobile-output-copy`는 변경 전 코드에서도 실패한다.
- 고친 것(검증 중 발견):
  - "확인시키기"를 눌러도 배너가 남음: 사람에게 알린 기록이 하나라도 있으면 사람 단계로 봤다. 가장 새 기록이
    단계를 정하게 고쳤다.
  - "1분째 그대로"처럼 경과가 짧게 나옴: 마지막 이벤트(멈춤 기록, 상태 보고 포함)부터 셌다. 마지막 진행부터
    세고, board가 `lastProgressAt`을 주어 화면이 계속 센다.
  - 360px에서 단계 줄이 5px 넘침: 단계가 줄어들지 못했다.
  - 기다리는 작업의 "작업" 칸이 진행 중처럼 파랬음, 의존 번호가 "3·2번"으로 나옴.
- 확인하지 못한 것:
  - 실제 Claude·Codex에서 "지금" 줄: stand-in stream과 변환 단위 테스트로만 확인했다.
  - 실제 기기의 멈춤 알림: service worker 단위 테스트로만 확인했다.
  - 실제 모델 오케스트레이터가 지침대로 한국어로 답하고 `project.stalled`에 움직이는지: 테스트 앱에서 본다
    (MANUAL_TESTS 12).
- 테스트 앱 적용 뒤(build `naru-next-edc95b4`, DB v22, doctor 25/25): 재시작 직전 떠 있던 에이전트 6개를 Naru가
  다시 실행했다. 그중 리뷰어 하나는 3초 만에 끝나 `failed`가 됐다.
  - 원인: 한 번도 차례를 받지 않은 에이전트였다. Claude는 대화에 ID를 먼저 붙이고 첫 차례에야 저장한다. 그래서
    저장된 대화가 없는 ID를 이어 띄우려다 Claude가 바로 끝났다. SDK `getSessionMessages`로 확인하니 그 ID는
    메시지 0개, 살아 있는 리뷰어는 1개 이상이었다.
  - 고침: Claude runner는 이어 띄우기 전에 그 대화에 저장된 메시지가 있는지 보고, 없으면 새 대화로 시작한다
    (`resumableRef`). 읽기에 실패하면 전처럼 이어 띄운다. `agent-runtime-claude-runner.test.ts`.
  - 이 수정은 다음 테스트 앱 업그레이드에 들어간다.

# AP-D035 검증: 결정을 내 말풍선으로

- 격리된 UI sandbox(stand-in Claude)에서 `@sample PLAN …`을 맡겨, 의도 계약과 작업자의 질문(`ASK`)이 오게 했다.
  브라우저 스크립트는 git에 넣지 않는 `.local/ap-t22/decisions.mjs`다.

| 항목                                                                                                | 근거                                                        | 상태     |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------- |
| 의도 계약 승인 뒤 프로젝트 오케스트레이터 대화에 "나 · 의도 계약 v1 승인" · "이 계약으로 진행"      | 1440 화면, `agent-platform-http.test.ts`                    | **PASS** |
| 대화의 질문 카드에서 답하면 "나 · 질문에 답함" 말풍선(답 원문, "선택 · 설정 안에", 답한 질문)       | 1440 화면, `agent-conversation.test.ts`                     | **PASS** |
| 말풍선은 질문 뒤에 오고, "여기부터 내가 직접 대화 중" 줄을 만들지 않음                              | 1440 화면                                                   | **PASS** |
| 질문 카드가 "답했습니다. 내 답은 아래에 있습니다."로 바뀜                                           | 1440 화면, `agent-conversation.test.ts`                     | **PASS** |
| 다른 에이전트의 질문에 한 답, 열린 질문은 그 에이전트의 결정이 아님. 같은 wakeup이 두 번 와도 한 번 | `agent-platform-http.test.ts`, `agent-conversation.test.ts` | **PASS** |
| 768px, 360px, 360×520 동적 viewport에서 가로 넘침 없음                                              | 화면, 가로 넘침 검사                                        | **PASS** |
| Tab으로 "답한 질문"에 닿고 focus outline이 보이며 Enter로 펼침                                      | 1440 화면                                                   | **PASS** |
| page error 없음, lint, typecheck, format, vitest 전체(1039)                                         | 명령 결과                                                   | **PASS** |

- e2e(`pnpm test:e2e`)는 에이전트 대화를 다루지 않아 이번에는 돌리지 않았다.
- 확인하지 못한 것: 실제 Claude·Codex 대화에서의 모습. 대화 구성은 두 런타임이 같은 wakeup 문장을 쓰므로 같은
  길을 지나지만, 실제 런타임 이력에서는 테스트 앱에서 본다.

# AP-D036 검증: 맡긴 일 완료하기와 다시 열기

- 격리된 UI sandbox에서 `@sample PLAN FINISH …`로 작업이 모두 끝난 일을 만들었다. 사람이 작업자 1에게 지시를 하나
  보내 저장된 대화가 있게 한 뒤 완료하고, 다시 열었다. 스크립트는 `.local/ap-t22/complete.mjs`다.
- sandbox stand-in은 이제 대화를 세션마다 임시 디렉터리에 저장한다. 그래서 다시 띄운 에이전트가 Claude처럼 자기
  대화를 이어 간다(`ui-sandbox-sdk.mjs`).

| 항목                                                                                                                 | 근거                                          | 상태     |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------- |
| 작업이 모두 끝나면 받은함 "완료 확인"과 카드 배너, 큰 그림의 "완료"가 현재 단계                                      | 1440 화면, `agent-model`·`jobs-model` 테스트  | **PASS** |
| 완료 확인 창에 작업자 1·2와 리뷰어 1, 오케스트레이터는 없음. 완료 뒤 결과 창                                         | 1440·360 화면                                 | **PASS** |
| 완료하면 작업자·리뷰어가 board에서 빠지고 오케스트레이터는 남음, Pane 지움                                           | board 읽기, `agent-platform-jobs`·http 테스트 | **PASS** |
| 다른 일을 맡은 에이전트, 사람이 잡은 에이전트, 차례 중인 에이전트, 체크를 뺀 에이전트는 남음                         | `agent-platform-jobs.test.ts`                 | **PASS** |
| 열린 작업이 있으면 완료 거부, 다시 완료 거부, 재시도는 같은 결과                                                     | `agent-platform-jobs.test.ts`                 | **PASS** |
| 완료와 그 뒤 runtime의 멈춤 보고가 오케스트레이터를 깨우지 않음                                                      | `agent-platform-jobs.test.ts`                 | **PASS** |
| 병합되고 깨끗한 워크트리·브랜치는 지우고 project 연결을 품. 변경, 병합 뒤 커밋, 실행 중 Pane, 프로세스가 있으면 남김 | `agent-platform-workspace.test.ts`(실제 git)  | **PASS** |
| 다시 열기: 말이 원문 그대로 같은 일의 2라운드로 보이고, 단계는 "계획"                                                | 1440·360 화면, `jobs-model` 테스트            | **PASS** |
| 다시 열면 정리한 세 에이전트가 다시 뜨고, 작업자 1의 대화에 완료 전에 사람이 한 말이 남음(resume)                    | 1440 화면, board·history 읽기                 | **PASS** |
| 라운드의 위임과 작업이 같은 일에 묶이고 라운드 지시는 따로 맡긴 일이 되지 않음                                       | `agent-platform-jobs.test.ts`                 | **PASS** |
| Tab으로 "다시 열기"에 닿고 focus outline, Enter로 창이 열림                                                          | 1440 화면                                     | **PASS** |
| 768px, 360px, 360×520에서 가로 넘침 없음(완료 확인 창 포함)                                                          | 화면, 가로 넘침 검사                          | **PASS** |
| page error 없음, lint, typecheck, format, vitest 전체(1048), DB migration 목록(v23)                                  | 명령 결과                                     | **PASS** |

- 고친 것(검증 중 발견): 정리할 에이전트를 먼저 멈추면 런타임의 멈춤 보고가 정리 기록보다 먼저 와서 오케스트레이터를
  깨웠다. 정리를 먼저 기록하고, 정리된 에이전트의 상태 보고는 wakeup에서 뺐다. 모든 프로젝트에 기본 Pane 기록이
  있어 워크트리가 늘 "쓰는 중"으로 보였다. 실행 중인 Pane만 세게 고쳤다.
- e2e(`pnpm test:e2e`)는 에이전트 화면을 다루지 않아 돌리지 않았다.
- 확인하지 못한 것: 실제 Claude·Codex의 resume(stand-in과 단위 테스트로만 확인), 실제 저장소에서 병합된 워크트리
  정리, 실제 오케스트레이터가 라운드 지시를 같은 일로 다루는지(MANUAL_TESTS 13).

# AP-D037 검증: 이벤트 범위와 오케스트레이터 하나

- 테스트 앱 진단은 결정 기록에 있다. 대화 기록에서 Naru 깨우기 메시지의 이벤트 번호만 셌고 대화 내용은 보지 않았다.

| 항목                                                                                                              | 근거                                                     | 상태     |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------- |
| 프로젝트 오케스트레이터는 전체 목표, 메인에게 한 말, 메인 상태, 다른 프로젝트, 작업자에게 한 말로 깨지 않음       | `agent-platform-wakeups.test.ts`                         | **PASS** |
| 프로젝트 오케스트레이터는 메인의 위임과 사람의 프로젝트 지시로 깸                                                 | `agent-platform-wakeups.test.ts`                         | **PASS** |
| 메인은 프로젝트 작업, 작업자 질문, 작업자 실패로 깨지 않고 전체 목표와 프로젝트 오케스트레이터의 상태 모름으로 깸 | `agent-platform-wakeups.test.ts`                         | **PASS** |
| 재시작 뒤 다시 보낸 묶음만 `resent`이고 깨우기 메시지에 안내가 붙음                                               | `agent-platform-wakeups.test.ts`                         | **PASS** |
| 메인은 오케스트레이터가 있는 프로젝트에 둘째를 만들 수 없고, 없는 프로젝트에는 만듦                               | `agent-platform-core.test.ts`                            | **PASS** |
| 관제실에 맡긴 전체 목표의 이벤트가 메인 대화 하나에만 감                                                          | sandbox(`.local/ap-t22/routing.mjs`), stand-in 대화 기록 | **PASS** |
| 오케스트레이터 둘이면 이름에 번호("sample 오케스트레이터 1·2"), 카드는 일한 오케스트레이터                        | sandbox 1440 화면, `agent-model.test.ts`                 | **PASS** |
| lint, typecheck, format, vitest 전체(1050)                                                                        | 명령 결과                                                | **PASS** |

- 확인하지 못한 것: 실제 모델 오케스트레이터가 새 지침대로 전체 지시를 규칙으로만 다루는지. 테스트 앱에서 본다.

# AP-D038 검증: 주 오케스트레이터 하나에게만 보내기

| 항목                                                                                                 | 근거                                                    | 상태      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------- |
| 오케스트레이터가 둘이면 계획 소유자, 없으면 먼저 만든 것이 주                                        | `agent-platform-wakeups.test.ts`, `agent-model.test.ts` | **PASS**  |
| 프로젝트 지시와 작업자 실패는 주만 깨우고, 지시 받는 쪽도 주 하나                                    | `agent-platform-wakeups.test.ts`                        | **PASS**  |
| 둘째는 이름으로 온 지시에 깨고, `get_delegated_work`에는 이름으로 온 것만 있음                       | `agent-platform-wakeups.test.ts`                        | **PASS**  |
| sandbox: 사람이 둘째를 만들어도 카드는 "sample 오케스트레이터 1"(계획 소유자)                        | sandbox(`.local/ap-t22/routing.mjs`) 1440 화면          | **PASS**  |
| sandbox: 둘째가 있는 동안 맡긴 새 일은 첫째가 계획하고, 둘째의 대화에는 자기 등록 깨우기 하나만 있음 | stand-in 대화 기록(이벤트 번호만 셈)                    | **PASS**  |
| lint, typecheck, format, vitest 전체(1053)                                                           | 명령 결과                                               | 아래 참고 |

- vitest 전체: 1051개 중 1050개 통과. `ops/workstation/distribution/independent-runtimes.test.ts`의 한 테스트가
  전체 실행 때 5초 제한을 넘었다. 이 변경과 관계없는 배포 도구 테스트이고, 그 파일만 다시 실행하면 11개 모두 통과한다.

# AP-D039 검증: 에이전트 Pane의 대화와 TUI 전환

sandbox(stand-in Claude SDK와 stand-in Claude TUI)에서 `.local/ap-t22/agent-pane.mjs`, `agent-pane-live.mjs`로
확인했다.

| 항목                                                                                                                        | 근거                       | 상태      |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------- |
| 작업자 Pane이 콘솔이 아닌 대화(말풍선, 접힌 도구 줄, 질문 카드, 입력창)로 열리고 "대화"가 눌려 있음                         | 1440 화면                  | **PASS**  |
| 대화 아래의 터미널은 `inert`라 focus와 입력을 받지 않음                                                                     | DOM 확인                   | **PASS**  |
| "TUI"를 누르면 같은 Pane에서 Claude TUI로 이어받고(runner 멈춤 → resume) TUI가 보임                                         | 1440 화면, 터미널 출력     | **PASS**  |
| 일하는 중이면 "멈추고 TUI로"를 먼저 묻고, 취소하면 대화에 남고, 고르면 차례를 멈추고 TUI로 감                               | 1440 화면                  | **PASS**  |
| "대화"로 돌아오면 "내가 직접 대화 중"으로 이어 가고, 보낸 말이 말풍선으로 보임                                              | 1440 화면                  | **PASS**  |
| 에이전트 메뉴의 "실행 콘솔 보기"로 콘솔을 보고, "대화"로 돌아옴                                                             | 1440 화면                  | **PASS**  |
| Tab으로 "대화"에서 "TUI"로 가고 focus 테두리가 보임                                                                         | 키보드                     | **PASS**  |
| "놓기"로 오케스트레이터에게 돌려주면 입력창이 "보내면 이어받습니다"로 바뀜                                                  | 1440 화면                  | **PASS**  |
| 다른 Pane과 함께 있는 작업공간에서도 에이전트 Pane만 대화로 보이고 터미널 표시는 숨김                                       | 1440 분할 화면             | **PASS**  |
| 768 분할(Pane 약 165px)과 360·360×520에서 대화와 머리줄이 넘치지 않음                                                       | 768, 360 화면              | **PASS**  |
| `paneView` 규칙(Claude는 runner·TUI, Codex는 고른 것, 콘솔은 runner에서만)                                                  | `agent-pane-views.test.ts` | **PASS**  |
| lint, typecheck, format, vitest 전체                                                                                        | 명령 결과                  | **PASS**  |
| e2e 전체: 27 통과, 2 실패(같은 runtime 다시 연결, 터치 복사). 바꾸기 전 커밋도 전체 실행에서 같은 둘(과 하나 더)이 실패한다 | `pnpm test:e2e`            | 기존 실패 |

- 처음 실행에서 TUI로 바꾼 뒤 끝난 runner의 "중지되었습니다" 화면이 남는 것을 찾아 고쳤다(새 runtime에 다시 붙기).
- 다시 붙기를 모든 터미널 Pane에 두었더니 e2e "같은 runtime 다시 연결"이 단독 실행에서도 실패했다. 연결이 끊길 때
  잠깐 끝난 것으로 보이는 순간에 다시 붙어서였다. 다시 붙기는 Naru가 새 runtime을 띄우는 에이전트 Pane에만 두었고,
  그 뒤 단독 실행은 통과한다.
- 확인하지 못한 것: 실제 Claude Code TUI로의 전환은 테스트 앱에서 본다.

# AP-D040 검증: 큰 대화 기록도 읽기

| 항목                                                                                                                                          | 근거                                  | 상태     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------- |
| 스크린샷(2MB)이 든 Claude 기록을 실제 runner 프로세스로 읽으면 바이트 없이 오고, 통로가 끊기지 않음                                           | `agent-runtime-supervisor.test.ts`    | **PASS** |
| 같은 테스트가 고치기 전 코드에서는 15초 뒤 "The runtime did not answer."로 실패(테스트 앱 증상과 같음)                                        | 고치기 전 코드로 실행                 | **PASS** |
| Claude 한 쪽은 512KB 안에서 끊기고 다음 쪽은 그 뒤부터, 끝까지 빠짐없이 읽힘. 답 텍스트는 줄이지 않음                                         | `agent-runtime-claude-runner.test.ts` | **PASS** |
| Codex 큰 turn 둘은 한 쪽에 같이 오지 않고, diff는 그대로, 스크린샷은 바이트 없이, turn이 빠지지 않음                                          | `agent-runtime-codex.test.ts`         | **PASS** |
| 같은 Codex 테스트가 다시 요청하지 않는 코드에서는 turn 하나가 빠져 실패                                                                       | 다시 요청을 뺀 코드로 실행            | **PASS** |
| 이미지 블록, 도구 출력 8,000자, 한 말·도구 입력·diff 보존, 혼자 큰 항목 줄이기, 한도 넘는 쪽은 오류                                           | `agent-runtime-history-page.test.ts`  | **PASS** |
| 테스트 앱 blog의 실제 기록(크기만 셈): 작업자 3 가장 큰 쪽 1,502KB → 226KB, 리뷰어 3,289KB → 171KB, 오케스트레이터 750KB → 127KB, 넘치는 쪽 0 | 로컬 SDK로 같은 방식으로 읽음         | **PASS** |
| lint, typecheck, vitest 전체(1058 통과)                                                                                                       | 명령 결과                             | **PASS** |

- 테스트 앱 로그: 대화 기록 요청 50건이 503 `AGENT_RUNTIME_UNAVAILABLE`로 끝났고, 오늘 것은 모두 15초 대기 뒤였다.
- 확인하지 못한 것: 테스트 앱에 올린 뒤 작업자 3의 대화가 열리는지는 사용자 화면에서 본다.

# AP-D041 검증: 띄운 에이전트가 서버를 끝내고 터미널을 닫기

| 항목                                                                                                                                                                                                                   | 근거                              | 상태     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------- |
| 실제 Host 터미널에서 서버(무한 반복)를 Ctrl+C(`"\u0003"`)로 끝내고 shell이 돌아온 뒤 닫으면, shell이 끝나고 Pane이 작업공간에서 빠지고 목록에서 사라짐. 다시 불러도 같음                                               | `agent-runtime-host.test.ts`      | **PASS** |
| 돌고 있으면 닫기 거부(먼저 끝내야 함), 다른 작업자의 것은 `AGENT_SCOPE_DENIED`, 리뷰어는 `AGENT_ROLE_DENIED`, 같은 key는 한 번만 적용, 오케스트레이터는 프로젝트의 것을 닫음, 사람이 잡고 있으면 `AGENT_HELD_BY_HUMAN` | `agent-platform-core.test.ts`     | **PASS** |
| MCP `close_process`가 목록에 보이고, 요청한 에이전트로 묶여 runtime에 전달되고, 닫은 뒤 `list_processes`가 비어 있음                                                                                                   | `agent-platform-mcp.test.ts`      | **PASS** |
| 지침 문구가 역할별 system prompt에 들어감(모든 역할의 닫기, 오케스트레이터의 사람 확인용 서버)                                                                                                                         | `orchestrationGuidance` 출력 확인 | **PASS** |
| lint, typecheck, format, vitest 전체(1060 통과)                                                                                                                                                                        | 명령 결과                         | **PASS** |

- 확인하지 못한 것: 실제 오케스트레이터와 작업자가 지침대로 Ctrl+C 뒤 닫는지는 테스트 앱에 올리고 다시 띄운 뒤 본다.

# AP-D042 검증: 이전 Naru가 띄운 runner를 쉬는 때 다시 띄우기

| 항목                                                                                                                                                                                                                                  | 근거                                                             | 상태     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------- |
| 실제 runner 프로세스: 차례가 도는 중에 Naru가 바뀌면 그 차례가 먼저 끝나고(`idle`이 `starting`보다 먼저), runner가 한 번 다시 떠 같은 대화(`fake-session-1`)로 이어지고 generation이 2가 됨. 새 runner의 차례 뒤에는 다시 띄우지 않음 | `agent-runtime-supervisor.test.ts`                               | **PASS** |
| gate: `request-restart`는 차례 사이에만, `stop-resume`에서만 받고, 같은 writer로 멈춤→다시 시작→확인                                                                                                                                  | `agent-runtime-writer-gate.test.ts`                              | **PASS** |
| 기존 대화↔TUI 전환, Naru 재시작 재접속, 실제 Host 테스트                                                                                                                                                                              | `agent-runtime-supervisor.test.ts`, `agent-runtime-host.test.ts` | **PASS** |
| lint, typecheck, format, vitest 전체(1062 통과)                                                                                                                                                                                       | 명령 결과                                                        | **PASS** |

- 테스트 앱: 리뷰어 4 runner는 `naru-next-9b2147c`, 2026-10-16 23:44(KST)부터 그대로였고, AP-D040을 올린 뒤에도
  기록 요청 5건이 15초 뒤 503이었다.
- 확인하지 못한 것: 올린 뒤 실제 에이전트 넷이 쉬는 때 다시 뜨고 대화가 열리는지는 테스트 앱에서 본다.

# AP-D044 검증: 에이전트가 읽는 지시를 열린 일 기준으로 자르기

| 항목                                                                                                                                                                                                    | 근거                          | 상태     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------- |
| 일을 완료하면 그 목표·위임·작업과 정리된 작업자에게 한 말이 오케스트레이터의 지시·받은 일·프로젝트 상태에서 빠지고(`tasksOfCompletedJobs` 1), 다른 열린 일은 그대로. 다시 열면 모두 돌아옴(라운드 포함) | `agent-platform-jobs.test.ts` | **PASS** |
| 사람이 보는 지시 목록, 프로젝트 상태, 에이전트 대화의 지시는 완료한 일도 그대로 보임                                                                                                                    | 같은 테스트                   | **PASS** |
| 위임·작업이 있는 일의 목표는 오래돼도 남고, 일과 상관없는 말은 최근 20개만(23개 중 3개 빠짐, `earlierWordsLeftOut` 3)                                                                                   | 같은 테스트                   | **PASS** |
| 테스트 앱 숫자(내용 없이): 사람 지시 14개, 완료한 일 3개, 일과 상관없는 목표 6개, 에이전트에게 직접 한 말 5개(정리된 에이전트에게 2개)                                                                  | 테스트 앱 DB 읽기 전용 조회   | **PASS** |
| sandbox 대역이 새 결과 모양으로 팀을 만듦(메인 → 프로젝트 오케스트레이터 → 작업자)                                                                                                                      | UI sandbox                    | **PASS** |

- 확인하지 못한 것: 실제 오케스트레이터가 바뀐 지침대로 덜 읽는지는 테스트 앱에 올린 뒤 대화에서 본다.

# AP-D045 검증: 대화를 최신 쪽부터 읽고 탭에 남기기

- 날짜: 2026-10-17. 격리 UI sandbox(Node 24, 공백 없는 경로), 저장소의 Playwright Chromium. 검사 script는
  `.local/ap-d045/`(git 밖). sandbox 대역에 `LONG`(명령 60개와 중간 답)을 더하고, 대역의 `getSessionMessages`를 SDK처럼
  limit 없이 부르면 끝까지 주게 맞췄다.

| 항목                                                                                                                                                                                                                                                                                  | 근거                                   | 상태     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------- |
| runner: 최신 쪽, 그 앞 쪽, 처음 쪽이 차례로 이어지고 각 쪽이 시작 위치를 알림. 시작 위치부터 앞으로 다시 읽으면 뒤에 더해진 것까지 옴. 잘못된 cursor 거부                                                                                                                             | `agent-runtime-claude-runner.test.ts`  | **PASS** |
| runner: 20KB 답 60개에서 최신 쪽도 512KB 안이고, 앞 쪽들을 이어 붙이면 빠짐없이 전부                                                                                                                                                                                                  | 같은 테스트                            | **PASS** |
| supervisor: 시작 위치를 `cursor`·`previousCursor`로 바꾸고 처음 쪽은 `previousCursor` null. 이전 runner가 거부하면 첫 쪽을 앞에서부터. Codex는 앞에서부터만                                                                                                                           | `agent-runtime-history-window.test.ts` | **PASS** |
| 실제 runner 프로세스로 최신 쪽 읽기                                                                                                                                                                                                                                                   | `agent-runtime-supervisor.test.ts`     | **PASS** |
| HTTP: `latest=1`, `before`, `cursor`, 빈 요청이 각각의 읽기로 가고, 둘을 같이 보내면 400                                                                                                                                                                                              | `agent-platform-http.test.ts`          | **PASS** |
| 화면 1440: 다시 연 긴 대화가 요청 1번(`?latest=1`)으로 최신 쪽을 보이고 위에 "이전 대화 보기". 키보드로 누르면 앞 쪽이 위에 붙고 읽던 답이 0px 움직이고 focus가 버튼에 남음. 세 번 더 눌러 처음에 닿으면 버튼이 사라짐                                                                | Playwright, sandbox                    | **PASS** |
| 화면 1440: 다른 작업자 Pane을 열었다가 돌아오면 "대화를 불러오는 중…" 없이 바로 보이고, 마지막 쪽만 다시 읽음(`?cursor=` 2번, `latest` 없음)                                                                                                                                          | Playwright, sandbox                    | **PASS** |
| 768·360 화면(동적 resize): 버튼이 보이고 focus 표시, 가로 넘침 0, 콘솔 오류 0                                                                                                                                                                                                         | Playwright, sandbox                    | **PASS** |
| Host 재시작 없이 올릴 수 있음: Host의 agent entry 넷(Codex·Claude launcher, hook CLI)과 그 chunk가 설치본 build와 바이트 단위로 같음(Codex launcher 21571200c032). 처음 빌드에서는 v1 index chunk가 history schema 둘을 더는 export하지 않아 달랐고, 새 schema가 둘을 확장하게 고쳤다 | 빌드 결과 비교                         | **PASS** |
| lint, typecheck, vitest 전체(1069 통과, 7 skip)                                                                                                                                                                                                                                       | 명령 결과                              | **PASS** |

- 실제 Host 테스트 둘(`agent-runtime-host`, `agent-runtime-codex`의 TUI 전환)은 공백이 있는 경로의 Node로 돌리면 바꾸기
  전 코드에서도 실패했다. 공백 없는 Node 24로는 통과한다.
- 확인하지 못한 것: 테스트 앱의 긴 대화(700개)가 처음 열 때 얼마나 빨라지는지는 올린 뒤 로그로 본다.

# AP-D046 검증: 위쪽 두 쪽 미리 받기와 Codex 최신부터 읽기

- 날짜: 2026-10-18. 격리 UI sandbox(Node 24, 공백 없는 경로), 저장소의 Playwright Chromium과 WebKit(Safari 엔진, scroll
  anchoring 없음). 검사 script는 `.local/ap-d046/prefetch.mjs`(git 밖). 매 프레임 화면 맨 위 블록과 그 위치를 기록해, 블록이
  들어온 프레임에 그 블록이 몇 px 움직였는지 센다. sandbox 대역의 메시지에 SDK처럼 `uuid`를 붙이고, `LONG` 세 번으로 약
  10쪽짜리 대화를 만들었다. WebKit은 service worker가 받은 요청을 Playwright가 가로채지 못해 service worker를 막고 돌렸다.

| 항목                                                                                                                                               | 근거                                                     | Chromium | WebKit   |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------- | -------- |
| 열면 `latest` 1번 뒤에 손대지 않아도 `before` 2번을 받고, 맨 아래(최신)에 머묾                                                                     | Playwright, sandbox                                      | **PASS** | **PASS** |
| 멈춰 있을 때 위에 쪽이 들어오면 보는 블록이 0px 움직임(WebKit 한 번 1px, 소수 픽셀)                                                                | 같은 검사                                                | **PASS** | **PASS** |
| 계속 휠로 올리는 중에도 쪽이 들어온 프레임에 페이지만큼 뛰지 않음                                                                                  | 같은 검사                                                | **PASS** | **PASS** |
| 처음까지 휠로 올라가는 동안 "이전 대화를 불러오는 중…"이 화면에 보인 프레임 0, 처음에 닿으면 줄이 사라짐                                           | 같은 검사                                                | **PASS** | **PASS** |
| 이전 쪽 받기가 503이면 "이전 대화를 불러오지 못했습니다 · 다시 시도", 키보드로 누르면 받고 줄이 사라짐. focus 표시(Chromium `:focus-visible` 실선) | 같은 검사                                                | **PASS** | **PASS** |
| 다른 Pane을 열었다 돌아오면 바로 보이고 `latest`를 다시 읽지 않음                                                                                  | 같은 검사                                                | **PASS** | **PASS** |
| 768·360 화면(동적 resize): 휠로 올리며 쪽이 들어와도 0~1px, 가로 넘침 0, 콘솔 오류 0                                                               | 같은 검사                                                | **PASS** | **PASS** |
| "여기부터 내가 직접 대화 중" 줄이 쪽이 들어올 때 맨 아래에서 옮겨 가 30px 움직이던 것(WebKit)을 고친 뒤 0px                                        | 같은 검사                                                | —        | **PASS** |
| 블록 key가 메시지 id라 위에 쪽이 붙어도 기존 블록 key가 같고, 같은 turn이 두 번 와도 key가 겹치지 않음                                             | `agent-conversation.test.ts`                             | **PASS** |          |
| Codex: 최신 쪽, 그 앞 쪽들을 이어 붙이면 앞에서부터 읽은 turn과 같은 순서로 빠짐없이 같고, 최신 쪽의 `cursor`로 다시 읽으면 같은 turn부터 옴       | `agent-runtime-codex.test.ts`(실제 Host PTY, Codex 대역) | **PASS** |          |
| supervisor: Codex 답의 `previousCursor`를 그대로 쓰고, 이전 Host의 Codex runner가 거부하면 앞에서부터                                              | `agent-runtime-history-window.test.ts`                   | **PASS** |          |
| lint, typecheck, format, vitest 전체(1070 통과, 7 skip; 배포 테스트 하나가 부하로 시간 초과 뒤 다시 돌려 통과)                                     | 명령 결과                                                | **PASS** |          |

- Codex 대역은 실제 Codex(0.162.1)의 cursor 규칙을 따른다: `nextCursor`는 쪽의 마지막 turn을 빼고, `backwardsCursor`는 첫
  turn을 포함한다(Codex `thread-store` `finish_page`). 실제 Codex로 최신부터 읽기는 테스트 앱에 올린 뒤 확인한다.
- WebKit에서 프로그램으로 준 focus는 `:focus-visible`이 되지 않아 focus 표시는 Chromium으로만 확인했다. 같은 CSS 규칙이다.
