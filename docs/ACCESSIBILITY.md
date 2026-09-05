# 접근성 정책과 검증 기준

이 문서는 공개 source의 반복 가능한 접근성 계약을 정의한다. 특정 사용자, 기기 또는 과거 release의 인수
증거는 포함하지 않는다.

## 자동 검증

- Playwright E2E는 로그인, 시작 실패, desktop workspace, 768px tablet, 360px narrow workspace와
  사라진 Project 복구 상태를 검사한다.
- axe 검사는 지원되는 WCAG 2 A/AA, 2.1 A/AA와 2.2 A/AA 규칙을 적용한다.
- 자동 검사 통과는 screen reader와 실제 mobile IME 검증을 대신하지 않는다.

## 키보드와 초점

- 로그인 입력 뒤 submit button이 오고 Enter로 제출할 수 있어야 한다.
- Project 등록·전환 뒤 Project heading으로, Pane 추가·삭제 뒤 새 active tab 또는 Pane으로 초점이
  이동해야 한다.
- Overlay는 열릴 때 내부의 의미 있는 control로 초점이 이동하고 Escape로 닫으면 trigger로 돌아가야 한다.
- Split separator는 접근 가능한 방향 이름, 가시적인 focus outline과 arrow-key 조절을 제공해야 한다.
- Terminal의 일반 `Tab`은 shell/TUI 입력으로 유지한다. `Shift+Tab`은 terminal 밖의 다음 관리 control로
  이동하며 입력 요소가 이 동작을 설명해야 한다.
- Mobile special-key toolbar는 이름과 44px 이상의 target을 제공한다. Toggle/latch 상태는
  `aria-pressed` 또는 `aria-expanded`로 노출해야 한다.
- Prompt 취소나 요청 실패 뒤에는 기존 trigger로 초점을 복구해야 한다.

## 이름·역할·상태·명암

- Connection과 Pane 상태는 텍스트와 semantic status를 함께 제공하고 색상에만 의존하지 않는다.
- Terminal input, Pane split/restart/close와 Project rename/remove control은 대상 이름을 포함한 label을
  가져야 한다.
- `tablist`/`tab`/`tabpanel`과 separator semantic을 유지한다.
- 오류, empty state, placeholder, secondary text와 focus indication은 AA 명암 기준을 지켜야 한다.

## Terminal screen reader mode와 한계

Screen reader mode는 명시적인 toggle로 제공하고 상태를 `aria-pressed`로 노출한다. 기본 입력과 IME를
보존하기 위해 기본값은 꺼짐이다. Full-screen CLI의 내부 읽기 순서와 동적 출력 알림은 각 CLI renderer의
한계가 있으므로 Naru가 완전한 접근성을 보장하지 않는다. Pane 상태, restart, close, split과 navigation은
terminal 밖의 일반 HTML control로 계속 사용할 수 있어야 한다.

Release 지원 주장 전에는 keyboard-only flow, 가시적 focus, 선택한 screen reader와 실제 target mobile
browser를 별도로 확인하고 비민감 결과만 외부 release evidence에 기록한다.
