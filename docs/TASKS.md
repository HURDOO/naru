# Naru application 작업 원장

## 상태

- DurableSession / Workstation v0: 완료·동결
- 활성 program: `private-ingress-v0`; current task는 해당 `TASKS.md`를 따른다.
- Private Ingress 상태는 `docs/private-ingress-v0/TASKS.md`에서만 관리한다.

## 표기

- `[ ]` 대기
- `[-]` 진행 중
- `[>]` 명시적 다음 작업
- `[~]` 보류
- `[x]` 완료·검증

PI-00 public baseline은 완료됐다. 각 작업은 public repository의 별도 worktree에서 lane
ownership과 integration gate를 지킨다.

## 대기 작업

### T52. 모바일 keyboard resize의 다중 freeze blink 제거

- [ ] T50의 style-preserving freeze를 유지하면서 한 keyboard session의 freeze/live 경계를 한 번 이하로
      줄인다.
- 선행 조건: PI-00, T20, T27, T50
- lane: Mobile UI

### T53. Codex interaction 후 Pane activity 상태 동기화

- [x] 실제 승인·비차단 질문·MCP elicitation의 미응답 요청을 Pane/Project 입력 필요와 기존 알림 경로에
      반영한다. 응답 제출 직후 해당 요청만 해소하고 follow-up input, cancel, reconnect와 stale frame
      순서에서도 current runtime의 activity만 표시한다.
- 선행 조건: PI-00, T30, T42, T51
- lane: Activity
- 검증(2026-09-14): Node 24.20.0·pnpm 11.12.0에서 format, lint, typecheck, 전체 테스트
  712 통과·5 건너뜀, build, E2E 14 통과, operations·distribution 각 64 통과, production-build
  smoke 1 통과, 전체 작업 트리 public scan 490 files·0 findings. 격리된 실제 `codex-cli 0.154.0`에서
  승인·비차단 질문·fake Chrome MCP elicitation의 요청별 해소, IPC 재연결, `/new`·`/resume`, 저장된
  session ID 재개, 정상 종료·launcher 강제 종료 뒤 child 회수를 확인했다.
- 적용 범위: 새 Host-owned Codex runtime부터 적용한다. 실제 Chrome 권한은 클릭하지 않았고,
  Alt+Up 제스처 자체는 별도로 인수하지 않았다. 기존 hook-only runtime과 실험적 `--remote`의
  CLI 버전 호환 경계는 D009·T54를 따른다. `codex-cli 0.154.0`의 자동 심사는 D010의 별도 notification이고
  hook 자체 승인도 사용자 request를 발행하지 않는다는 고정 source/schema를 확인했다. 자동 심사
  진행·종료가 `interaction-required`를 만들지 않고 다른 미해소 요청을 지우지 않는 회귀 테스트를 둔다.
  이 후속 검증의 관련 테스트 21건과 typecheck·lint·format은 통과했으며, 위의 전체 712건과는 별개다.
- 추가 사용자 인수(2026-09-14): 격리된 HTTPS 테스트 서버에서 실제 `codex-cli 0.154.0` Codex Pane이
  실행 중 상태와 session ID 연결을 유지하는 것을 확인했고 사용자가 동작을 확인했다. 이 테스트 환경은
  전용 Host를 도구 sandbox 밖에서 실행해야 했다. Fastify가 symlink 경로에서 AJV를 해석하지 못하는
  로컬 의존성 로딩 오류는 테스트 worktree의 링크 보완으로 복구했다. 해당 경로로 로드된 원인은
  미확인이고 제품 source나 운영 설치는 변경하지 않았다.
- merge 준비 재검증(2026-09-14): 위 자동 심사 회귀를 포함해 format·lint·typecheck와 전체 테스트
  718 통과·5 건너뜀을 확인했다.

### T54. Codex approval lifecycle 구분

- [ ] 후속 Codex CLI 버전의 자동 심사 protocol 변화 표시·진단과 hook-only 구 runtime의 stale
      interaction-required 한계를 별도 migration으로 다룬다. 현재 인수한 0.154.0의 자동 심사는
      D010에 따라 사용자 입력 필요로 표시하지 않는다.
- 선행 조건: T53 contract/state merge
- lane: Activity

### T55. Codex rolling refresh

- [ ] 승인된 Codex CLI update 뒤 active turn과 session을 보존하며 Pane을 순차 refresh한다.
- 선행 조건: T53, `private-ingress-v0/PI-05`
- lane: Activity/Distribution integration

### 기타 backlog

- [x] T29 모바일 prompt·image input 완성
  - Galaxy Samsung Internet PWA에서 xterm에 직접 입력하는 한글 IME 조합·확정, 삭제, Enter와 영문 입력이
    중복·누락·조기 전송 없이 동작한다. 기존 `한글 입력` textarea 보조 경로는 유지한다.
  - browser가 paste event에 제공한 이미지는 Codex Pane의 기존 bounded PNG 전송 경로로
    전달하고, 미제공 clipboard와 전송·권한 오류는 구분한다. 파일 선택·preview·새 composer
    전송 버튼은 범위에 넣지 않는다.
  - controller handoff·reconnect에서 stale 입력을 거부하고, 자동화된 keyboard·focus·viewport
    회귀와 실제 Galaxy IME·이미지 clipboard 인수 결과를 확인한 뒤 완료한다.
  - 진행 (2026-09-13): Android touch의 xterm input-only 삭제·Enter 보조와 lease/control/runtime
    fence, textarea 보조 경로의 이미지 paste 수신 및 browser 제공 `items`·`files` 처리 구현.
    설치된 xterm 6.0.0 단독으로도 확정된 한글 `이전내용` 삭제 뒤 같은 길이의 새 입력에
    숨은 textarea 전체 내용을 다시 전송하는 Chromium 재현을 확인했다. 초기 T29 Android
    보조 입력은 xterm의 지연 diff와 함께 DEL을 두 번 전송하는 회귀도 만들었다. Android의
    비조합 keyCode 229 입력만 xterm의 지연 diff에서 분리하고,
    확정 텍스트 삭제·입력 후 숨은 textarea 이력을 초기화한다. xterm의 활성 한글 composition
    경로와 screen reader 경로는 유지한다. [xterm.js #4173](https://github.com/xtermjs/xterm.js/issues/4173)의
    Android 삭제 후 이전 조합 재전송 보고와 유사하나 Samsung Keyboard 실기기 원인으로
    확인된 것은 아니다. 확정 직후 같은 task의 복합 IME 이벤트 순서는 실기기 확인이 남았다.
    Samsung Internet UA를 쓴 Chromium 모의 테스트는 실제 Samsung Internet 엔진이나
    clipboard 동작을 검증하지 않는다. Node v24.19.0에서 format·lint·typecheck·build 통과,
    unit 703 통과(5 skip), E2E 15 통과. 1440px·768px·360px, 동적 viewport, focus 흐름은
    E2E에서 확인했다. 이전 한 차례 core-flow activity timeout은 안정된 최종 재실행에서
    재현되지 않았으며 원인은 확인되지 않았다.
  - 별도 조사: xterm 6.0.0에서 첫 한글 조합의 0ms 전송을 지연시키고 다음 조합을 잇는
    독립 재현은 [xterm.js #6089](https://github.com/xtermjs/xterm.js/issues/6089)와 유사하지만,
    사용자가 보고한 확정 텍스트 삭제 후 재전송 증상과는 다른 경로다.
  - Galaxy 인수 확인 (2026-09-14): 사용자는 Samsung Keyboard와 Samsung Internet 설치 PWA에서
    수정한 직접 한글 입력이 잘 동작하고, 길게 눌러 선택하는 이미지 붙여넣기도 동작한다고
    확인했다. Samsung Keyboard 클립보드 패널의 이미지 항목은 빗금 표시와 함께 비활성화되어
    탭해도 동작하지 않는다. [Android 이미지 키보드 안내](https://developer.android.com/develop/ui/views/touch-and-input/image-keyboard)에
    따르면 editor가 `EditorInfo.contentMimeTypes`로 수용 MIME을 IME에 알리고 `commitContent`로
    이미지를 받는다. [Chromium Android 구현](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/android/ime_adapter_android.cc)은
    초점이 맞은 rich editable 요소에만 `image/*`를 광고한다. 현재 xterm과 보조 입력의
    `textarea`에는 그 경로가 열려 있지 않을 가능성이 크지만, Samsung Internet PWA의 실제
    내부 동작이나 브라우저 차이를 확인한 것은 아니다. 기존 길게 누르기 붙여넣기는 유지한다.
  - 잔여 범위: Samsung Internet의 `이미지 복사`와 Samsung Gallery의 `클립보드에 복사`를
    각각의 입력 경로에서 따로 검증한 결과는 없다. 사용자는 길게 누르기 이미지 붙여넣기가
    동작한다고 확인했지만, Samsung Keyboard 클립보드 패널 이미지 선택은 현재 비활성화되어
    있다. paste event에 이미지 데이터가 없으면 현재 붙여넣기 경로로 전송할 수 없다. 이
    패널을 활성화하려면 rich editable 입력 경로가 필요할 수 있으며, 기존 한글 IME와 focus
    동작에 영향을 주는 별도 설계·실기기 검증이 필요하다.
  - 선행 조건: PI-01, 다른 Mobile UI lane 작업과 직렬
- [ ] T40 Docs/Tasks view state 보존
- [ ] T44 모바일 output 선택·복사
- [ ] T46/T48 모바일 helper focus·draft lifecycle
- [ ] T47/T37/T38/T39는 Private Ingress cutover 뒤 재검토
