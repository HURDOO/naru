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
