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

### T52. Pane resize·로딩·유휴 상태의 blink와 입력 focus 유실 개선

- [x] 로컬 terminal restore·resize·유휴·입력 경로를 안정화하고 격리된 fixture의 자동화와
      성능 검증을 완료했다. 실제 기기의 반복 blink·focus 유실, 로딩 waterfall·resize blank/stun
      인수와 첫 입력 전 특정 Pane 본문 공백은 해결을 주장하지 않고 T56으로 이관했다.
- 사용자 보고(2026-09-14, T29·T53 배포 후): Pane resize 시 화면이 비거나 멈춘 듯한 blank/stun
  상태가 너무 오래 지속된다. 로딩 중 blink가 많으며 waterfall도 간헐적으로 나타난다. 아무 조작을
  하지 않아도 체감상 짧은 간격으로 Pane이 반복해서 깜빡이고 현재 입력 focus가 해제되어,
  키보드 입력 중 다시 focus를 확인·복구해야 한다. Windows Edge PWA와 Android Samsung
  Internet PWA에서 모두 발생한다고 보고했으며, 다른 브라우저에서도 비슷하게 느껴진다고 한다.
  정확한 주기·trigger는 아직 계측하지 않았고, T29·T53과의 인과관계나 각 증상의 공통 원인은
  확인되지 않았다.
- 추가 보고(2026-09-14, Android Samsung Internet PWA): 모바일 키보드가 열리며 화면이 위로
  움직일 때 터미널이 검게 비거나 채팅이 위로 말려 올라간 듯 보이고, 다시 입력하면 돌아온다.
  9443 테스트 서버의 수정본에서도 재현됐다. 화면 캡처에서는 앱 전체가 아닌 특정 Terminal
  Pane의 본문만 비어 있으며, 해당 Pane에 한 번 입력한 후에는 focus를 여러 번 옮겨도 정상적으로
  보인다. 캡처에는 브라우저 주소 표시줄이 있어 이 재현의 PWA 설치 모드는 확인되지 않았다.
- 완료 범위:
  - 안정된 로컬 연결·제어권에서 120초 유휴와 120초 연속 입력 동안 renderer 교체·숨김·freeze·
    focus 유실·연결/visibility 변화를 계측해 0건임을 확인한다.
  - 같은 runtime reconnect에서 renderer와 focus를 보존하고, 다른 UI로 옮긴 focus를 빼앗지
    않는다. 단일 controller handoff의 generation fencing과 한글 조합·확정 회귀를 보존한다.
  - Pane/split·viewport·keyboard resize와 반복 로딩을 자동화한다. T50의 style-preserving
    freeze를 일반 resize에서 유지하고, keyboard 높이 변화에서는 freeze 없이 terminal tail·
    scroll offset·focus를 보존한다. 1440px·768px·360px와 동적 viewport를 확인한다.
  - 격리 fixture에서 blank frame·중간 restore 화면 노출과 성능 목표를 검증한다. 실제 기기의
    동일 증상 여부는 이 결과로 판정하지 않는다.
- 선행 조건: PI-00, T20, T27, T50
- lane: Mobile UI
- 연계: T29의 한글·이미지 입력 회귀를 보존한다. T46/T48은 helper focus·draft lifecycle의 별도
  backlog다. 실제 PWA의 일반 Pane focus 유실과 첫 입력 전 본문 공백은 T56에서 추적한다.
  T52의 keyboard viewport 자동화 통과가 그 증상의 해결을 뜻하지는 않는다.
- 로컬 검증(2026-09-14, Node 24·격리 Chrome fixture): 유휴 120초와 연속 입력 120초에서
  focus 유실·renderer 교체·숨김·freeze·연결/visibility 변화가 모두 0건이었다. 같은 runtime
  reconnect는 renderer와 focus를 보존하고, 다른 UI로 이동한 focus를 되찾지 않는다. 키보드
  session에서 freeze 시작은 기존 1회, 수정 후 0회였다. 가상 visual viewport 높이·위치 전환에서
  수정 전 하단 줄 가림이 연속 최대 10프레임, 수정 후 최대 1프레임(각 축소 단계의 observer 전
  샘플)이었고, 안정된 각 단계의 가림·scroll offset 변화·focus 유실은 0건이었다. 단위 테스트
  725건(5건 건너뜀), 전체 E2E 19건, format·lint·typecheck·build가 통과했다. 20회 resize의 완료 p95
  167.4ms·최대 167.7ms, 빈 프레임 0건; 20회 reload의 첫 정상 화면 p95 458.68ms·전체 복원
  p95 463.18ms, 중간 화면 노출 0건이다. Android UA를 사용한 Chrome fixture 결과이며 실제
  Samsung Internet PWA 재현·개선 여부와 동일시하지 않는다. 9443 실기기 재확인에서 T56의
  Pane 본문 공백은 그대로 관찰되어, 앞선 viewport 가림 개선으로 해당 증상이 해결되지는 않았다.
- 종료(2026-09-14): 사용자의 요청에 따라 9443 격리 테스트 서버를 중지했고, listener와
  테스트 Host·Gateway 소켓이 사라진 것을 확인했다. 로컬 fixture에서는 사용자 보고의 주기적
  유휴 blink가 수정 전에도 재현되지 않았다. 실기기에서 미완료인 조사·개선·인수는 T56에 남긴다.

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

### T56. 실기기 Pane blink·focus 유실과 첫 입력 전 본문 공백

- [ ] T52에서 이관한 실기기 미완료 범위를 재현·해결한다. Windows Edge PWA와 Android
      Samsung Internet PWA에서 보고된 유휴 중 반복 blink·focus 유실, 초기 로딩 blink·간헐적
      waterfall, Pane resize의 오래 지속되는 blank/stun을 포함한다. 로컬 fixture에서는 주기적
      유휴 blink가 수정 전에도 재현되지 않아 실기기 원인·개선 여부가 확인되지 않았다.
- [ ] Android Samsung Internet에서 키보드를 연 상태로 여러 Terminal Pane을 오갈 때 특정
      Pane의 본문만 비어 보이고, 그 Pane에 한 번 입력하면 이후 focus 전환에서도 정상으로 유지되는
      증상을 재현·해결한다. T52의 viewport 가림 개선을 적용한 9443 테스트 서버에서도 재현됐다.
      캡처는 브라우저 주소 표시줄이 보이는 상태였으므로 브라우저 탭과 설치 PWA를 구분해 확인한다.
- 조사: 유휴·연속 입력·한글 조합·최초 로딩·Pane/split resize·keyboard 열기/닫기에서 focus/
  blur, renderer 생성·교체, attach/restore, reconnect·control generation, freeze/live 경계를
  계측해 반복 trigger를 구분한다. 첫 focus 전후에는 각 Pane 크기, xterm buffer와 렌더된 행,
  ResizeObserver·visual viewport 이벤트를 비교한다. 입력 원문과 실제 instance 식별자는
  남기지 않는다.
- 완료 조건: 실기기의 충분히 긴 유휴·입력·resize·로딩 관찰에서 반복 blink·focus 유실과
  waterfall이 사라지고, blank/stun 시간을 수정 전후로 비교해 정한 목표를 충족한다. 첫 입력이나
  강제 재시작 없이 각 Pane의 기존 본문이 보이며 Pane 왕복·키보드 열기/닫기·reconnect 뒤에도
  유지된다. 1440px·768px·360px·동적 viewport 자동화와 실제 Edge PWA·Samsung Internet
  브라우저 탭/설치 PWA를 구분한 인수 결과를 기록한다.
- 선행 조건: T52의 terminal renderer 변경과 직렬로 진행한다. T52의 로컬 자동화 결과를
  재사용하되 그 통과를 실기기 인수로 간주하지 않는다.
- lane: Mobile UI

### T57. Workstation upgrade의 서비스별 재시작

- [x] 새 artifact에서 실제로 바뀐 runtime과 설정만 재시작한다. 웹 자산만 바뀐 upgrade에서는
      Naru만 재시작하고 Host PTY와 Gateway 연결을 유지한다.
- 완료 조건: plan이 정확한 재시작 범위와 유지할 서비스별 불변 릴리스를 승인 digest에 묶는다.
  maintenance·receipt·doctor·status·실패 복구가 혼합 릴리스 상태를 일관되게 다루고, 기존
  receipt는 기존 단일 릴리스 의미로 계속 읽는다. Host/Gateway/Naru 변경 및 후속 upgrade·rollback
  fixture에서 재시작 범위와 단일 controller reconnect를 확인한다.
- 선행 조건: Workstation v0 distribution과 T52 병합. 운영 upgrade는 새 artifact와 fresh plan의
  별도 승인 뒤 수행한다.
- lane: Distribution
- 검증(2026-09-15, Node 24·격리 fixture): 웹-only upgrade의 `restartServices=[naru]`, 이전
  Host/Gateway release pin·launchd definition·PTY 보존, Gateway payload 변경 시 Gateway/Naru,
  Host payload 변경 시 세 runtime 재시작을 확인했다. 혼합 pin receipt의 후속 upgrade·rollback,
  status/doctor와 Naru readiness 실패 복구에서 Host/Gateway 무재시작을 검증했다. 전체 단위
  728건(5건 건너뜀), distribution 67건, operations 64건, production smoke 1건과 제어권
  전환·Host 요청 E2E 2건, format·lint·typecheck·build가 통과했다. 현재 운영 릴리스와 T52
  artifact의 read-only 비교에서도 web payload만 달랐고 새 계획 코드는 Naru만 재시작하도록
  선택했다. 기존 운영 계획 digest는 무효이며, 실제 배포는 새 committed artifact와 fresh plan의
  승인 경계에 남긴다.

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
- [-] T44 모바일 output 선택·복사
  - 모바일의 Codex·shell Pane에서 출력 텍스트를 길게 눌러 선택하고 범위를 조정해 명시적인
    복사 동작으로 일반 텍스트를 clipboard에 쓴다. 긴 누르기를 가로채는 브라우저를 위해
    선택 도구 진입점도 제공한다. 입력에 초점이 있을 때의 긴 누르기는 기존 붙여넣기에
    남겨두고 선택 도구를 사용한다. 보기 전용 화면에서도 선택·복사할 수 있다.
  - 빈 선택과 clipboard 거부를 분명히 알리고, 선택 내용은 저장·로그·Host 전송하지 않는다.
    기존 스크롤·스크롤바·한글 IME·이미지 붙여넣기·focus·reconnect·controller handoff를
    보존한다. renderer 교체나 column reflow 뒤에는 무효 선택을 복사하지 않는다.
  - 완료 조건: Node 24의 unit·터치 E2E에서 정상·빈 상태·오류, 1440px·768px·360px와 동적
    viewport를 확인한다. Samsung Internet 실기기 브라우저/PWA 인수는 fixture 결과와
    구분해 기록한다. 선행 조건 PI-01; 다른 Mobile UI lane 작업과 직렬.
  - 로컬 검증(2026-09-15, Node 24.19.0·격리 Chrome fixture): 길게 누르기 단어 선택,
    핸들·키보드 범위 조정, 명시적 선택 도구, Codex·shell·observer 복사와 빈 선택·clipboard
    거부를 확인했다. 입력 focus 중 긴 누르기와 기존 스크롤·이미지 붙여넣기·한글 IME,
    1440px·768px·360px, 동적 viewport, reconnect·제어권 전환 회귀를 통과했다. 전체 unit
    731건 통과·5건 건너뜀, E2E 22건 통과, format·lint·typecheck·build와 공개 scan
    495 files·665 objects·0 findings. 로컬 shell에 상속된 실제 hook 환경은 검증 명령에서
    제거했다. 기존 작업 트리의 변경을 보존하려고 별도 worktree에서 수행했다.
  - 남은 인수: 실제 Samsung Internet 브라우저 탭·설치 PWA에서 긴 누르기, 입력 중 이미지
    붙여넣기, 선택 핸들, clipboard 권한·focus를 확인한다. 로컬 Chromium UA fixture 통과를
    실기기 인수로 간주하지 않는다. main integration gate와 운영 반영도 별도다.
- [ ] T46/T48 모바일 helper focus·draft lifecycle
- [ ] T47/T37/T38/T39는 Private Ingress cutover 뒤 재검토
