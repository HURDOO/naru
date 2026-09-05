# Naru application 작업 원장

## 상태

- DurableSession / Workstation v0: 완료·동결
- 활성 program: `private-ingress-v0/PI-00`
- Private Ingress 상태는 `docs/private-ingress-v0/TASKS.md`에서만 관리한다.

## 표기

- `[ ]` 대기
- `[-]` 진행 중
- `[>]` 명시적 다음 작업
- `[~]` 보류
- `[x]` 완료·검증

PI-00 완료 전에는 application feature를 시작하지 않는다. 완료 뒤 각 작업은 public repository의 별도
worktree에서 lane ownership과 integration gate를 지킨다.

## 대기 작업

### T52. 모바일 keyboard resize의 다중 freeze blink 제거

- [ ] T50의 style-preserving freeze를 유지하면서 한 keyboard session의 freeze/live 경계를 한 번 이하로
      줄인다.
- 선행 조건: PI-00, T20, T27, T50
- lane: Mobile UI

### T53. Codex interaction 후 Pane activity 상태 동기화

- [ ] follow-up input, cancel, reconnect와 stale frame 순서에서도 current runtime의 activity만 표시한다.
- 선행 조건: PI-00, T30, T42, T51
- lane: Activity

### T54. Codex approval lifecycle 구분

- [ ] 자동 승인과 실제 사용자 승인 대기를 구분하고 stale interaction-required 상태를 제거한다.
- 선행 조건: T53 contract/state merge
- lane: Activity

### T55. Codex rolling refresh

- [ ] 승인된 Codex CLI update 뒤 active turn과 session을 보존하며 Pane을 순차 refresh한다.
- 선행 조건: T53, `private-ingress-v0/PI-05`
- lane: Activity/Distribution integration

### 기타 backlog

- [ ] T29 모바일 prompt·image input 완성
- [ ] T40 Docs/Tasks view state 보존
- [ ] T44 모바일 output 선택·복사
- [ ] T46/T48 모바일 helper focus·draft lifecycle
- [ ] T47/T37/T38/T39는 Private Ingress cutover 뒤 재검토
