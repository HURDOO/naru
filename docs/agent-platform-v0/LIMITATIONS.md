# Agent Platform v0 제한 사항

지원하지 않거나 일부만 지원하는 것을 숨기지 않고 적는다(A16). 결정 근거는 각 항목의 결정 기록에 있다.

## 런타임

- OpenCode·OmO 관리형 에이전트는 없다(AP-D018 proposed). 운영 `/omo/`는 그대로 쓴다.
- native subagent(Claude Task, Codex `/subagents`)는 관찰만 한다. Naru에서 입력하거나 멈추지 않는다
  (AP-D014). 끝난 child의 transcript는 Naru에 보관하지 않는다.
- Claude의 Chat↔TUI 전환은 stop-resume이다. 진행 중 turn이 끝난 뒤 바뀐다. Codex는 같은 thread를 live로
  공유한다(AP-D011).
- 모델은 역할별 고정 값이다(Claude `claude-opus-5-5`, Codex `gpt-6-astra`). 화면에서 고르는 기능은 없다.

## 신원과 보안

- agent 신원은 같은 OS 사용자 권한 아래의 책임 추적 수단이다. 격리 장치가 아니다(V13, AP-D013). 에이전트는
  native git이나 shell로 Naru 규칙(예: merge gate)을 우회할 수 있다(AP-D004).
- secure input은 Naru 경로를 보호한다. 프로그램이 화면에 직접 출력한 값은 숨기지 못한다.
- 사람이 직접 연 terminal Pane은 에이전트에게 보이지 않는다. 에이전트는 자기 공유 프로세스만 다룬다
  (AP-D016).

## 작업 흐름

- 통합은 fast-forward만 한다. 갈라진 branch는 rebase와 재리뷰가 필요하다. push와 PR은 하지 않는다(AP-D016).
- worktree는 project 옆, 승인된 root 안에만 만든다. git 명령은 하나에 8초를 넘으면 실패한다. 큰 저장소에서는
  worktree 생성이 실패할 수 있다.
- 명령 실행 승인은 사람이 답해야 진행된다. 승인 대기 push는 아직 없다(AP-D017).
- 전역 Handoff(project 없음)는 push하지 않는다.

## 화면

- Home의 리소스 사용량과 최근 성과 요약은 수집하지 않는다.
- `콘솔 보기`·`TUI 보기`는 지금 연 project의 작업공간에서 Pane을 찾는다. Main Orchestrator의 Pane이 다른
  project에 있으면 열지 못한다.
- 웹 빌드가 바뀌면 Naru를 재시작해야 새 asset을 제공한다(기존 동작).

## 검증 범위

- 실제 SSH·ansible 대상의 비밀 입력 흐름은 사용자 Manual Test로 남겼다(A09).
- 실제 모델이 계획부터 리뷰와 통합까지 끝까지 가는 흐름은 비용 때문에 fake로만 확인했다. 실제 모델 인수는
  A02, A04, A06, A07, A08, A12다.
