# Agent Platform v0 운영 (초안)

- 상태: 초안(2026-10-15). 운영 한도와 pilot project는 사용자 Manual Test 뒤 함께 정한다(AP-D007,
  AP-T19).
- 운영 배포, service 재시작, data migration은 각각 사용자 승인이 필요하다.

## 켜기와 끄기

Agent Platform은 기본으로 꺼져 있다. 켜려면 Naru 환경에 다음을 둔다.

| 변수                            | 뜻                                                                          | 기본값 |
| ------------------------------- | --------------------------------------------------------------------------- | ------ |
| `NARU_AGENT_PLATFORM`           | `1`이면 켠다                                                                | `0`    |
| `NARU_CLAUDE_AGENT_SDK_PATH`    | 사용자가 설치한 Claude Agent SDK의 `sdk.mjs`(AP-D012). 관리형 Claude에 필요 | 없음   |
| `NARU_AGENT_HOLD_IDLE_MS`       | 사람 hold를 입력이 없을 때 자동 반환하는 시간                               | 30분   |
| `NARU_AGENT_HOLD_DISCONNECT_MS` | controller 기기가 없을 때 hold를 반환하기까지의 유예                        | 5분    |

- 끄기: `NARU_AGENT_PLATFORM=0`으로 재시작한다.
  - v20 table과 기록은 그대로 남는다. 기존 project, 작업공간, TUI는 영향을 받지 않는다.
  - 관리형 에이전트가 쓰던 접힌 Pane은 작업공간에 남을 수 있다. 끈 상태에서의 동작은 아직 확인하지
    않았다. 필요하면 사람이 닫는다.
- 첫 시작: v20 migration이 자동 backup 뒤 실행된다(기존 migration backup 계약). 운영 DB에서는 data
  migration 승인 경계다.

## 런타임과 모델

- Claude: 역할별 `claude-opus-5-5`. 사용자 로그인(keychain)을 쓴다.
  - 사용자 settings(`~/.claude`)도 불러온다. 개인 skill, plugin, 권한 허용 규칙, hook이 에이전트에도
    적용된다. Naru 주입 설정(model, 권한 모드, Naru 도구 허용, bridge hook)이 우선한다(AP-D020).
- Codex: 역할별 `gpt-6-astra`. reasoning은 Host profile `codex-main`의 설정(xhigh)을 따른다.
- 모델 표는 코드 상수다(`CLAUDE_AGENT_MODELS`, `CODEX_AGENT_MODELS`). 운영 값은 AP-T19에서 정한다.

## 자율 진행과 사람의 개입

- wakeup: 에이전트마다 한 번에 turn 하나다.
  - 최소 간격 5초, 시간당 60 turn
  - 완료 보고가 없으면 30분 뒤 같은 묶음을 다시 보낸다.
  - 사람 hold 중에는 쌓아 두었다가, 반환할 때 한 번에 보낸다.
- 도구 승인(AP-D017): Naru 도구와 작업 디렉터리 안 편집은 묻지 않는다. 명령 실행은 Inbox에서 사람이
  답한다. 자주 쓰는 명령은 project `.claude/settings.json`이나 개인 `~/.claude/settings.json`에서 미리
  허용할 수 있다.
- 통합(AP-D019): `merge_task`는 작업마다 merge commit을 만든다. 충돌하면 되돌리고 거부한다. push는 하지
  않는다.
- 사람 채널:
  - Handoff는 Inbox와 Web Push(ID만)로 알린다.
  - 승인 대기는 Inbox와 기존 "입력 필요" 알림으로 알린다. 알림을 누르면 그 에이전트가 열린다
    (AP-D021).

## 관찰과 기록

- 구조화 로그 event
  - `agent.tool.failed`: 예상하지 못한 tool 실패. tool 이름과 오류 종류만 남긴다.
  - push 관련: `push.delivered`, `push.suppressed`(사유 `active_client`)
- 원문 기록(AP-D002): 사용자 지시, TUI prompt, 위임, Handoff 결정, 에이전트가 공유 프로세스에 보낸 입력.
  대화 transcript와 terminal 출력은 Naru에 저장하지 않는다. 런타임의 이력에서 다시 읽는다.
- 사람이 terminal에 친 키와 secure input은 어디에도 기록하지 않는다(AP-D003).

## 장애 대응

| 증상                            | 확인                                                          | 조치                                                                 |
| ------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| 에이전트가 `확인 필요`(unknown) | Naru 재시작 뒤 유예 안에 runner가 돌아오지 않음(AP-T10)       | 에이전트 상세에서 `다시 실행`. 대화는 런타임 ID로 이어진다           |
| 에이전트가 `실패`               | 실행하지 못함(Host 한도, 실행 파일). `agent.tool.failed` 로그 | 원인을 고친 뒤 `다시 실행`                                           |
| 진행이 멈춤                     | Inbox의 승인 대기, 열린 Handoff, 사람 hold                    | 답하거나 반환한다. hold는 idle·연결 끊김 시간이 지나면 자동 반환된다 |
| `돌려주기`가 끝나지 않음        | 진행 중 turn이 승인 등을 기다림(writer 전환은 turn 경계에서)  | 승인에 답하면 turn이 끝나고 반환된다                                 |
| 공유 프로세스가 `확인 필요`     | 재시작 때 Host session을 찾지 못함                            | 필요하면 에이전트가 다시 시작한다                                    |
| 웹 빌드 뒤 화면이 옛 버전       | 서버가 시작할 때 asset 목록을 읽음                            | Naru 재시작. PWA는 `지금 업데이트`                                   |

## 정리할 것

- 실제 모델 검증이 남긴 것(사용자 확인 뒤 정리):
  - Claude transcript: `~/.claude/projects/`의 검증 workspace 경로들
  - 검증 run 디렉터리: `~/coding/experiments/naru-agent-spikes/`
