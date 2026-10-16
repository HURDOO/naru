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
- 화면: 관제실에서 목표로 팀을 만든 뒤 리뷰어를 대화 메뉴로 정지 → "꺼진 에이전트 정리 1" → 시트에 리뷰어 1
  → 정리 → 관제실 목록과 작업공간 목록에서 사라짐, 작업자 2 이름 유지. page error 없음.
- 한계: 휴대폰 관제실에는 에이전트 목록이 없어 정리 버튼도 없다. 1440·768에서 쓴다.
