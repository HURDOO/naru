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

## 요청 범위 유지보수: TUI 출력 선택·복사 (2026-09-29)

- 마우스 추적 TUI에서 desktop 왼쪽 드래그를 로컬 선택으로 처리하고 Ctrl/Cmd+C·V와 연결했다.
  일반 shell 선택과 Alt+앱 마우스 입력은 유지한다. 선택 후 repaint가 원문을 바꾸지 않도록
  선택 문구를 renderer 메모리에 보관하고, 실제 입력·붙여넣기 뒤 선택을 종료한다(D020).
- 모바일 선택 drag·handle 가장자리 scroll도 alternate buffer에서는 D019의 wheel 경로를 쓴다.
  화면 밖 TUI 원문을 이어 붙이는 transcript 전체 선택은 제공하지 않는다.
- 검증: Node 24.19.0, 관련 unit 31건, 기존 모바일 복사 E2E 3건과 mouse-tracking TUI fixture E2E
  4건 통과. 1440/768/360px 드래그·한글/emoji copy·paste, 동적 높이, keyboard focus, 양방향
  edge scroll 및 release 후 정지를 확인했다. 세 크기 screenshot 확인, web typecheck·build와
  변경 파일 lint·format 통과. 실제 Codex/Claude 버전별·실제 모바일 기기 인수는 수행하지 않았다.
- 사용자 승인 후 각 현재 배포 source 위에 이번 web 수정만 추가한 별도 artifact를 만들고
  claude-lab → 운영 순서로 Naru-only upgrade를 완료했다. 두 artifact의 non-web payload는 이전과
  동일하며 새 receipt·승인 digest·maintenance completed를 확인했다. Doctor는 claude-lab 25개,
  운영 29개 check 모두 통과했고, 양쪽 Host/Gateway PID는 유지되며 Naru PID만 바뀌었다.
  실제 기기의 새 웹 버전 선택·복사 인수와 기존 T69의 미완료 인수·상태는 변경하지 않는다.
- 배포 후 일반 클릭 회귀 보완: down에서 즉시 선택하던 동작을 3px 초과 drag 판정 뒤로 옮겼다.
  일반·반복 클릭은 원래 좌표/modifier의 down/up을 xterm에 한 번씩 전달하며 선택 UI를 켜지 않는다
  (D021). 로컬 관련 unit 22건, 1440/768/360px 클릭 전달·드래그 copy와 모바일 E2E 7건 및
  web build·typecheck·변경 파일 lint 통과. 별도 승인된 정확한 계획으로 claude-lab과 운영에
  `tui-click-claude-20260929-r1`, `tui-click-primary-20260929-r1`을 순서대로 적용했다.
  양쪽 새 receipt·승인 digest·maintenance completed와 Doctor 25/25·29/29를 확인했으며,
  Host/Gateway release 및 PID는 유지되고 Naru만 재시작됐다. 실제 사용자 기기의 클릭 인수는
  남아 있으며 기존 T69의 미완료 인수·상태는 변경하지 않는다.
- 후속 사용자 확인: 일반 클릭·드래그 copy는 동작하지만 드래그를 놓은 뒤 선택 강조가 사라졌다.
  Any-event mouse tracking의 hover 입력이 xterm 선택을 지우는 경로를 로컬 Chrome에서 재현했다.
  Naru 선택이 활성 상태이면 보관한 범위로 native 강조만 복원하고, repaint 뒤에도 복사 원문은
  갱신하지 않도록 보완했다. 입력·붙여넣기·취소에 따른 선택 종료는 유지한다.
  관련 unit 28건과 E2E 7건, web typecheck·build·변경 파일 lint 통과. 1440/768/360px에서 release 후
  hover에도 강조가 보이는 screenshot과 keyboard focus·동적 viewport·모바일 copy/scroll 회귀를
  확인했다. 이 강조 보완은 아직 미배포이며 새 artifact와 별도 승인 계획이 필요하다.
- 재개(2026-10-06): 임시 배포본·checkout 파일이 정리되어 canonical Git에 남은 base와 설치본의
  source map에서 source를 복구하고 후보를 다시 만들었다. 두 후보 모두 non-web payload가 현재
  설치본과 동일하다. 운영 unit/distribution 106건·claude 114건, 각 operations 64건·E2E 7건·
  production-mode smoke 1건, build·typecheck·변경 파일 lint/format이 통과했다.
  운영은 Doctor 29/29이고 Naru-only 새 계획을 준비했다. claude-lab의 이전 readiness 실패는
  해소됐지만 Claude 업데이트 뒤 사라진 이전 executable 경로를 설정이 참조하여 target environment
  검사가 차단된다. 설치 패키지의 native import는 정상이다. 현재 canonical Claude 경로로 바꾸는
  read-only reconfigure 계획은 Host/Gateway/Naru 재시작을 요구하므로 Naru-only 승인 범위로
  실행하지 않는다. 새 후보 배포·설정 변경은 아직 수행하지 않았다.

## 대기 작업

### T70. 운영 primary의 Claude 통합과 claude-lab 철거

- [-] 통합 `main`(T63부터 T69까지의 Claude·Codex 변경과 D020/D021 선택 강조 보완 포함)을 운영 primary에
  배포해 한 instance에서 Codex와 Claude Code Pane을 함께 사용한다. 이후 T67의 별도 claude-lab
  route와 instance를 철거한다. 이번 단계는 준비만 하며 운영 mutation은 사용자 실행 승인 뒤 수행한다.
- 선행 조건: `model/claude` 통합(D022), T67 사용자 인수 완료, primary 현재 receipt·추가 앱 등록 확인.
- 단계와 승인 경계:
  1. clean committed `main`에서 Node 24 artifact를 빌드·검증한다.
  2. `upgrade`: 현재 receipt의 승인 설정을 그대로 두고 artifact만 바꾼다. Host payload가 바뀌므로
     Host·Gateway·Naru가 모두 재시작되고 실행 중인 PTY는 종료된다. Naru 시작 시 DB v16 → v17
     migration이 실행되며, Naru가 migration 전 무결성 검사를 거친 backup을 먼저 만든다.
  3. `reconfigure`: 같은 artifact에서 `claudeExecutable`을 추가하고 claude-lab route를
     `additionalGatewayApps`에서 제거한다. Host 설정이 바뀌므로 세 runtime이 다시 재시작된다.
     2와 같은 maintenance window에서 연달아 수행한다. 이 plan은 2 적용 뒤에만 계산할 수 있다.
  4. claude-lab instance의 서비스 중지·LaunchAgent 제거와 data 보관은 distribution 명령이 없으므로
     별도 철거 절차와 승인을 준비한다. Claude 대화 원문은 CLI 소유이며 primary에서 `/resume`으로
     다시 연다.
- 완료 조건: 각 plan digest 승인과 maintenance `completed`, 새 receipt·build, Doctor 전체 통과,
  primary에서 Codex·Claude Pane 생성·입력·reconnect·Claude hook 상태와 선택 강조 실기기 인수,
  claude-lab route 401/404 확인과 서비스 부재. rollback은 이전 receipt와 migration 전 DB backup
  복원을 함께 계획한다.
- 준비(2026-10-09): clean `ce01c94`에서 Node 24.20.0 artifact `t70-claude-primary-ce01c94`
  (manifest `a4e74eaf…`, payload `66fb8357…`)를 빌드했다. 후보 intent는 현재 receipt의 승인 설정을
  복사해 upgrade용은 artifact 경로만, reconfigure용은 `claudeExecutable` 추가와 claude-lab route
  제거만 바꿨다. read-only upgrade plan은 `needs-input`(경고 `codex.hook-trust` 1건), 세 runtime
  재시작, Origin·Gateway 설정 불변, digest `2fdeadb7…`이다. reconfigure 미리보기는 현재 Host
  release에 Claude entrypoint가 없어 예상대로 차단되며 새 artifact에는 네 entrypoint가 모두 있다.
  claude-lab의 project root는 모두 primary root의 strict child라 추가 root 설정이 필요 없다.
  owner-only runbook·intent·admission 초안은 저장소 밖에 둔다. 운영 mutation은 수행하지 않았다.
- CLI 설치 정리(2026-10-10): Codex는 셸이 standalone, Pane이 npm 설치본을 써서 갈라졌고 Claude
  Homebrew cask는 버전별 경로라 업데이트마다 실행 경로가 바뀐다. 셸·ssh·Pane 모두 npm 전역 설치본으로
  통일하고 `claudeExecutable`은 npm package의 `bin/claude.exe`로 둔다. Claude 자동 업데이트는 끄고
  `ops/workstation/agent-clis/update-agent-clis.sh`로 두 CLI를 함께 갱신한다. ChatGPT 앱 SSH 원격용
  Codex daemon package는 앱 소유로 유지한다. 응답 없는 `naru-t62` route는 reconfigure에서 함께 제거한다.
- 실행(2026-10-10, 사용자 승인): 9/13·9/24 테스트 잔여 프로세스 21개를 종료했다. 셸 PATH에서 Codex
  standalone 링크와 installer PATH 블록을 백업 후 제거하고, Claude Homebrew cask를 npm 전역 설치로
  바꿔 Codex 0.162.1·Claude Code 2.1.296으로 갱신했다. 셸과 Naru 실행 경로가 모두 npm package 내부
  실제 파일을 가리킨다. claude-lab의 launchd 서비스 4개를 중지하고 LaunchAgent와 instance 디렉터리를
  삭제 없이 보관했다. primary upgrade plan digest는 준비 시점과 동일함을 재확인했다.

### T68. Claude fullscreen 터치 스크롤

- [x] Claude Code fullscreen의 alternate buffer에서 모바일 수직 드래그를 CLI가 협상한 mouse wheel
      입력으로 전달한다. 일반 shell의 local scrollback과 선택·focus 동작은 유지한다.
- 선행 조건: T52, T56, T63, D002 및 DurableSession snapshot barrier. `main`의 진행 중 Codex
  스크롤 변경은 읽기 전용 참고로만 사용하고 해당 작업 트리는 변경하지 않는다.
- 범위: Host와 standalone PTY snapshot에서 xterm serializer가 누락한 mouse encoding만 복원한다.
  public wire schema·DB를 바꾸지 않고 observer input과 오래된 controller generation을 계속 거부한다.
  `/tui default`의 빈 화면은 별도 원인 조사 대상으로 남긴다.
- 완료 조건: normal/alternate buffer, mouse mode off/on, snapshot/reconnect, observer와 controller
  handoff, 선택·focus 및 1440px·768px·360px·동적 viewport를 격리 fixture에서 검증한다. 실제
  Claude Code·모바일 기기 인수와 운영 배포·Host restart는 별도 승인 경계다.
- 로컬 검증(2026-09-27): Node 24 format·lint·typecheck·build, 관련 unit/integration 42건,
  외부 보호 소켓 권한이 필요한 4개 파일을 제외한 Vitest 810건 통과. Node 26 브라우저 E2E에서
  Claude touch·기존 모바일 복사·Claude reconnect 5건 통과했다. 전체 Vitest의 나머지 4개 파일은
  현재 sandbox의 보호 소켓/외부 프로세스 접근 제약으로 15건 실패했고, Node 24 Playwright의
  Chrome 실행은 같은 sandbox에서 SIGABRT로 막혔다. 실제 Claude Code와 실기기·운영 서비스는
  건드리지 않았다.

### T67. Claude 별도 운영 앱 배포 준비

- [x] Claude용 Naru를 운영 Mac의 별도 앱으로 준비·인수한다. 9443 테스트 서버는
      사용자 후속 승인 전까지 보존하고, 승인 후 별도로 중지한다.
      기존 Gateway의 추가 앱 등록과 DurableSession 경계를 조사하고, 기존 운영 앱 등록을 잃지 않도록
      운영 릴리스의 `additionalGatewayApps` 계약을 현재 source에 통합한다.
- 선행 조건: T63, T66, WV0-D011, 현재 운영 receipt/intent와 기존 등록 앱의 보존 확인.
- 완료 조건: 선택한 별도 앱 topology의 Host·Gateway·Naru 격리, Claude activity의 Durable Host
  경로, 인증·project root·runtime fencing, 배포 artifact와 정확한 읽기 전용 plan, operations·
  distribution·production smoke를 검증한다. 실제 mutation은 plan digest 승인 후 별도 수행한다.
- 현재 상태: 외부 Gateway assertion을 받는 별도 Workstation instance와 Claude Host launcher/hook,
  Claude 기본 Pane 2개를 구현했다. Host app ID·subject는 외부 Gateway binding과 일치하고
  credential/socket/data는 독립이다. Cheers만 허용할 수 있도록 선택적 exact root 계약
  (WV0-D012)을 추가했다. Node 24 아티팩트는 clean commit에서 빌드했고 distribution 85건,
  operations 64건, unit 816건(사용 중인 Codex daemon에 접근하는 2개 파일 제외)과 로컬 production
  smoke를 통과했다. 브라우저 E2E 23건 중 첫 실행의 2건은 단독 재실행에 통과했다.
- 운영 적용(2026-09-27): 후속 사용자 승인으로 9443 LaunchAgent만 중지하고 테스트 데이터는
  보존했다. 독립 Claude Workstation을 설치한 뒤 기존 Gateway에 앱을 등록했다. 기존 추가 앱
  2개를 보존했고 기존 Host PID를 유지한 채 Gateway·Naru만 재시작했다. 두 instance의
  `status`·`doctor`는 정상이며, 새 HTTPS 경로는 미인증 요청에 401을 반환한다. 실제 패스키
  로그인, Cheers 연결, Claude Pane 2개 및 hook 상태의 휴대폰 인수는 아직 남아 있어 T67은 진행 중이다.
- 인수 완료(2026-10-09): 사용자가 Claude 별도 앱의 테스트 완료를 확인했다. 별도 앱 운영은 끝내고
  Claude 사용은 T70에서 primary로 통합하며, claude-lab route·instance 철거도 T70에서 수행한다.

### T66. Claude Code 훅 기반 Pane 작업 상태

- [x] Claude Code의 lifecycle hook을 Pane별 runtime capability로 수신해 `running`,
      `interaction-required`, `completed`, `failed` 상태에 반영한다. 프롬프트·도구 입력·응답·
      transcript 원문은 수신 경계에서 버리고 저장·로그에 남기지 않는다.
- 선행 조건: T63, D013 및 공식 Claude Code hooks 계약 확인. 사용자 요청에 따라 실행 중인
  9443 서버의 설정·프로세스·데이터와 운영 Host·Naru·Gateway는 건드리지 않는다.
- 검증: hook 입력·설정, 인증된 private IPC, Pane/runtime·cwd fence, 세션 전환·늦은 이벤트,
  승인 대기와 해제·오류·종료, 새로고침·단일 controller 및 Node 24 회귀. 실제 9443 인수는
  사용자가 별도로 승인할 때까지 보류한다.
- 로컬 검증(2026-09-26, Node 24): redacted hook parser·owner-only UDS·capability/cwd/runtime
  fence·상태 전환·후속 도구 이벤트 해제와 stale callback을 검증했다. 모의 Claude 브라우저
  E2E에서 작업 중→입력 필요→작업 중→완료, 1440px·768px·360px와 새로고침을 확인했다.
  format·lint·typecheck·build, Vitest 828건 통과(6건 건너뜀), 민감정보 scan 0건이다.
  전체 E2E 23건 중 21건 통과, 기존 모바일 복사·Codex 스크롤 2건은 전체 실행에서 실패했으나
  별도 재실행은 둘 다 통과했다. 실행 중인 9443·운영 서비스는 변경하지 않았다.

### T65. 격리 9443 Cheers 연결 worktree 루트 허용

- [x] Cheers의 연결 worktree가 놓인 `worktree`·`worktrees` 두 형제 디렉터리를 격리 9443
      서버의 strict-child project root에만 추가한다. 운영 서비스와 일반 root 계약은 변경하지 않는다.
- 선행 조건: T64, D014 및 사용자의 두 디렉터리 허용·테스트 서버 재시작 승인.
- 검증: canonical·owner·symlink 검사, 두 연결 worktree의 발견과 연결 가능성, 범위 밖 경로
  거부, 9443 TLS·로그인·Claude Pane 재연결. 운영 Host·Naru·Gateway는 재시작하지 않는다.
- 로컬 검증(2026-09-26, Node 24): 두 root의 canonical·owner 확인 후 9443 설정을 원자적으로
  갱신하고 테스트 LaunchAgent만 재시작했다. 실제 Cheers Git metadata에서 primary 1개와 연결
  worktree 3개를 허용했고 거부 0개였으며, 각 연결 worktree의 독립 Git 검사도 통과했다. 브라우저
  Cheers 그룹에 발견된 3개가 표시되고 기존 Claude Pane 2개 재시작·새로고침 재연결을 확인했다.
  TLS·Origin 거부·비밀번호 로그인·세션 smoke, format·lint·typecheck·build 및 전체 Vitest
  820건 통과(6건 건너뜀). 첫 전체 Vitest 실행의 보호 소켓 EPERM 11건은 샌드박스 경계로,
  승인된 로컬 실행에서 모두 통과했다. 연결 worktree는 계속 사용자 명시 연결을 요구한다.

### T64. 격리 Claude 9443 인수 기본 작업공간과 명시 프로젝트 연결

- [x] 격리 비밀번호 서버의 새 Project 기본 Pane을 Claude Code 2개와 Dev Terminal로 생성하고,
      사용자 지정 Project 한 경로만 `realpath` 뒤 exact root로 허용한다. 기존 Workspace와 운영
      Workstation 기본값은 변경하지 않는다.
- 선행 조건: T63, D013 및 9443 격리 서버 승인. 운영 배포·Host restart는 범위 밖이다.
- 검증: 기본 Pane 저장·시작, exact root와 sibling/symlink escape 거부, 기존 Workspace 보존,
  9443 TLS·로그인·Claude 실행·reconnect, Node 24 전체 회귀.

### T63. Claude Code Pane 실험 구현

- [x] Codex Pane과 저장된 Codex 세션을 보존하면서 별도 Claude Code Pane을 생성·실행한다.
      Host allowlisted `claude-code` 프로필, standalone 실행, UI와 distribution intent의 선택적
      `claudeExecutable`을 연결한다. 기존 intent는 필드가 없어도 그대로 읽는다.
- 선행 조건: D001~D003, D009, T53, T59 및 Workstation v0 distribution.
- 검증: v16 DB의 Pane/Host 연결 보존 migration, 인증·실행 실패, Pane 생성·재연결·단일
  controller, distribution 구성 및 로컬 UI. 운영 Gateway 등록·reconfigure·실기기 인수는
  exact artifact/intent plan을 별도로 검토한 뒤 수행한다.
- 범위: Claude CLI 자체의 대화 재개 선택기를 사용한다. Claude hook 기반 activity·입력 필요·
  Files 전송·이미지 paste는 이 초기 구현에 포함하지 않는다.

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

- [x] T52에서 이관한 실기기 미완료 범위를 재현·해결한다. Windows Edge PWA와 Android
      Samsung Internet PWA에서 보고된 유휴 중 반복 blink·focus 유실, 초기 로딩 blink·간헐적
      waterfall, Pane resize의 오래 지속되는 blank/stun을 포함한다. 로컬 fixture에서는 주기적
      유휴 blink가 수정 전에도 재현되지 않아 실기기 원인·개선 여부가 확인되지 않았다.
- [x] Android Samsung Internet에서 키보드를 연 상태로 여러 Terminal Pane을 오갈 때 특정
      Pane의 본문만 비어 보이고, 그 Pane에 한 번 입력하면 이후 focus 전환에서도 정상으로 유지되는
      증상을 재현·해결한다. T52의 viewport 가림 개선을 적용한 9443 테스트 서버에서도 재현됐다.
      캡처는 브라우저 주소 표시줄이 보이는 상태였으므로 브라우저 탭과 설치 PWA를 구분해 확인한다.
- 추가 보고(2026-09-16): 노란 active Pane 테두리는 유지되지만 실제 terminal 입력 상태가 약
  10~40초 간격으로 반복 해제되어 다시 눌러야 입력할 수 있다. 같은 시점에 출력이 live tail로
  이동하고 짧은 waterfall이 보이는 경우가 있어, 단순 DOM focus가 아니라 heartbeat·lease·WebSocket
  reconnect, attachment 재생성, staged restore와 renderer lifecycle을 함께 조사한다.
- 로컬 원인·수정(2026-09-16): heartbeat는 안정적이었지만 transient reconnect 상태에서
  `TerminalPane`이 active attachment를 dispose/recreate해 모바일 IME와 실제 DOM focus를 끊고 staged
  restore·renderer lifecycle을 다시 실행했다. Reconnect와 `lease.granted` 뒤 `surface.state` 사이에도
  attachment·renderer·restore identity를 보존하고, 현재 generation의 authority가 확인될 때까지 input은
  fail closed한다. 같은 runtime의 최신 restore는 freeze 안에서 기존 local scroll offset을 보존해
  적용하며, 동일 Pane·connection·runtime·control이고 사용자가 다른 곳으로 focus를 옮기지 않았을 때만
  focus를 복구한다. 실패한 input은 compose를 소비하거나 live tail로 이동시키지 않는다.
- 로컬 검증(2026-09-16, Node 24): terminal stability E2E의 120초 유휴와 120초 연속 입력에서
  focus·renderer·hidden·frozen·connection·visibility 변화가 모두 0회였고 3건이 통과했다. 모바일
  input/IME/image/keyboard/touch 4건과 responsive flow, web 단위 108건, typecheck·build·lint·format이
  통과했다. 기존 Fold keyboard-close fixture의 기대 높이 차이와 hook 3건의 환경 실패는 변경 전
  base에서도 동일하게 재현했다. 실제 Edge PWA와 Samsung Internet 브라우저 탭·설치 PWA 인수는
  완료 조건으로 남긴다.
- 실기기 확인·후속 수정(2026-09-17): Host credential rotation의 동일 sequence snapshot 재투영을
  제거한 9443 빌드에서 반복 blink·키보드 유실·live-tail 이동이 사라졌음을 사용자가 확인했다.
  이어 발견된 Codex 출력 긴 누르기의 live-tail 이동은 Codex TUI의 focus-reporting frame을 사용자
  입력으로 취급한 것이 원인이었다. focus in/out frame은 Host로 전달하되 viewport와 mobile Ctrl
  상태를 바꾸지 않도록 분리했다. 선택 범위가 있는 화면의 수직 drag는 선택을 유지한 채 scroll하고,
  선택 drag가 화면 가장자리에 닿으면 자동 scroll하며 범위를 확장한다. 일반 Terminal 화면의 짧은
  tap은 scrollback이 아니라 live prompt로 복귀한 뒤 focus해 키보드 resize 시 빈 배경만 보이는
  상태를 방지한다. 관련 단위 18건, Samsung UA 선택·키보드·IME와 reconnect E2E 7건,
  typecheck·lint·build가 통과했다. 전체 unit은 768건 통과·5건 skip이며, 실제 login shell이 hook
  환경을 다시 주입하는 기존 hook 3건은 이번 변경과 무관하게 실패했다. 새 9443 빌드의 Samsung
  Internet 브라우저/PWA 인수는 남아 있다.
- 추가 보고·후속 수정(2026-09-17): Codex scrollback에서 드래그 선택해도 Android 네이티브
  toolbar가 거의 뜨지 않았다. xterm 선택은 DOM range가 아니고 브라우저에는 Android
  ActionMode를 여는 public API가 없어, helper textarea의 focus·readonly·`inputmode`로 우회한
  9443 빌드들은 툴바 누락을 해결하지 못하거나 Samsung Keyboard를 열어 선택을 깨뜨렸다.
  실기기 결과와 사용자 결정에 따라 모바일 선택은 앱이 소유한 `복사 · 붙여넣기 · 전체 · 취소` 툴바를
  표시한다. 복사는 명시적 사용자 gesture에서 Clipboard API를 호출하고 성공·빈 선택·권한 거부를
  구분한다. 붙여넣기는 제어권을 먼저 확인한 뒤 Clipboard API의 텍스트를 xterm bracketed-paste로
  보내고 Codex의 이미지는 기존 generation fencing·크기 제한 경로로 보낸다. 빈 clipboard·권한
  거부·보기 전용 화면을 구분한다. 긴 누르기 대기 단계부터 선택 종료까지 `contextmenu`와 Android
  compatibility `mousedown`을 xterm보다 먼저 차단하고 touch callout을 비활성화해 네이티브 툴바,
  helper textarea focus·IME 열림을 막으며 툴바·핸들 터치와 선택 상태 스크롤을 유지한다.
  관련 단위 20건과 Samsung UA 선택/입력 E2E 4건, typecheck·변경 파일 lint·format·전체 build가
  통과했다.
  9443 Samsung Internet/PWA의 커스텀 툴바 표시·복사·붙여넣기와 네이티브 툴바 미표시 인수는
  남아 있다.
- 추가 실기기 보고·수정(2026-09-18): 선택 유지 상태의 일반 scroll은 동작하지만, 선택 gesture나
  선택 핸들을 화면 위·아래 가장자리에 둬도 자동 scroll·범위 확장이 시작되지 않았다. Samsung
  Internet이 정지한 손가락에도 미세한 `pointermove`를 연속 발생시키는데 두 edge-scroll 경로가
  매번 80ms interval을 다시 만들어 발화를 영구 지연한 것이 원인이었다. 같은 edge 안의 jitter에는
  기존 interval을 유지하고 방향이 바뀌거나 edge를 벗어날 때만 교체한다. 반복 jitter 중 위·아래
  선택 gesture와 선택 핸들의 양방향 자동 scroll·범위 확장을 E2E에 추가했다. 관련 touch 단위
  16건과 Samsung UA 선택 E2E 3건, 전체 typecheck·변경 파일 lint·format·web build가 통과했다.
- 실기기 완료(2026-09-23): 사용자가 production 설치 PWA를 실제 기기에 설치한 상태로 계속 사용
  중이며 T56 수정 범위를 완료로 인수했다. 9월 17~18일 실기기 확인과 자동화 결과를 합쳐 반복 blink·
  focus/키보드 유실, 첫 입력 전 본문 공백과 모바일 선택 후속 범위를 완료 처리한다.
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

### T58. Gateway multi-app 경로와 dashboard

- [x] 하나의 Gateway instance에서 여러 app을 겹치지 않는 경로에 등록하고, 인증된 사용자가
      Gateway-owned dashboard에서 앱을 선택할 수 있게 한다. 기존 `appRegistrations`와
      `routePrefix`를 재사용하되 Naru의 root-relative API·WebSocket·asset·PWA 가정을 명시적인
      app base path 계약으로 바꾼다.
- 1차 병렬 범위: `apps/workstation-gateway` 안에서 인증된 app inventory/dashboard, disabled·unavailable
  상태, reserved/overlapping route 거부와 다중 upstream fixture를 구현한다. Browser에 upstream
  origin·socket path와 실제 instance topology를 노출하지 않는다.
- 2차 직렬 범위: T56 web 변경 통합 뒤 Naru base path, app별 service-worker scope/cache, server static
  fallback, distribution config versioning·migration·rollback과 두 app의 HTTP/WSS/auth 격리를 구현한다.
- 완료 조건: root Gateway dashboard와 path-scoped Naru를 포함한 두 개 이상의 app을 한 Gateway에서
  사용하고, 한 app의 장애·cache·WebSocket·assertion audience가 다른 app을 침범하지 않는다. 기존
  root Naru config의 migration과 rollback, 정상·미인증·disabled·unavailable 상태를 검증한다.
- 선행 조건: PI-07. T56과 Gateway-only 1차 범위는 병렬이며, Naru web/base-path 2차 범위는 T56 통합
  뒤 직렬로 수행한다. PI-10 multi-ingress와는 별도 Task다.
- lane: Gateway/App routing; Naru web integration은 Mobile UI 뒤 직렬
- 검증(2026-09-16, Node 24·격리 fixture): 새 CLI intent의 `/naru`와 기존 config/receipt의 `/` 호환,
  app-managed non-root 거부, HTML metadata에서 파생하는 API·WebSocket·manifest·service worker·push
  경로, app별 service-worker scope/cache를 확인했다. Root app 유무에 따른 dashboard 우선순위,
  `/_gateway/apps`, 두 app의 HTTP/WSS와 assertion audience 격리, disabled·unavailable 상태, root
  worker retirement, reconfigure·rollback·doctor의 경로 일치도 검증했다. 전체 단위 769건(5건 건너뜀),
  distribution 71건, operations 64건과 production smoke 1건이 통과했다. Browser E2E 첫 실행은
  21건 중 18건 통과·1건 선행 실패로 건너뜀·2건 timing/중복 renderer 실패였고, 실패 2건은 개별
  재실행에서 통과했다. Terminal stability E2E 3건과 format·lint·typecheck·build도 통과했다. Main
  통합 뒤 관련 회귀 132건과 typecheck·build를 다시 통과했다. 기존 실제
  browser profile의 worker migration, 설치 PWA·실기기와 production instance 인수는 별도 승인 경계에
  남기며 source/fixture 구현 완료를 막지 않는다.
- 운영 인수(2026-09-24): T58 구현을 포함한 source가 production에 배포됐고, 사용자가 기존 실제
  browser profile의 Gateway와 설치 PWA에서 path-scoped Naru를 계속 사용하며 정상 동작을 확인했다.
  별도 승인 경계였던 service-worker migration·설치 PWA·production instance 인수를 완료로 수용하며
  추가 T58 후속 Task를 남기지 않는다.

### T59. Codex 0.156.1의 간접 Unix 소켓 지원과 시작 실패 진단

- [x] 기존 직접 Unix 소켓과 Codex 0.156.1의 symlink endpoint를 모두 안전하게 지원하고,
      새 Codex Pane의 시작·재개와 실패 원인 표시를 검증한다. 구현·격리 테스트 서버 인수와
      배포 후보 준비까지 진행하며 운영 배포는 실행하지 않는다.
- 조사 근거(2026-09-24, 격리 재현): `codex-cli 0.155.0`은 지정 endpoint에 실제 소켓을 만들고,
  `0.156.1`은 실제 소켓으로 향하는 symlink를 만든다. 기존 relay의 `lstat().isSocket()` 및
  canonical path 검사가 이를 거부해 10초 readiness timeout과 child 정리 뒤 약 13초에 종료한다.
  app-server stderr 무시와 relay catch의 일반 종료 처리 때문에 구체적인 원인이 표시되지 않는다.
  설치·인증·기본 설정 검사는 통과하며, `--no-daemon`만 추가해도 간접 endpoint는 유지됐다.
- 선행 조건: T53/D009의 relay·guardian 계약과 T57의 runtime 의존성별 배포 경계를 따른다.
  T54의 approval protocol 확장과 T55의 active-turn rolling refresh 전체 완료는 요구하지 않는다.
- 구현 계획:
  1. 지원할 CLI의 고정 버전 source/help와 격리 실행으로 endpoint 생성·해석 규칙, daemon 공유 여부,
     child 종료와 실제 server 수명 관계를 확인한다. 검증할 버전은 기존 인수 기준 `0.154.0`,
     직접 소켓 대조군 `0.155.0`, 대상 `0.156.1`이며 이후 버전을 자동으로 호환으로 간주하지 않는다.
     D009를 소급 변경하지 않고 새 결정에 신뢰할 endpoint root·연결 검증·소유 프로세스 회수 규칙을
     기록한 뒤 이에 의존하는 구현을 진행한다. 관찰된 링크 목적지를 그대로 승인 root로 삼지 않는다.
  2. Naru Codex adapter 안에 endpoint 해석·검증을 분리한다. 직접 소켓 검사를 보존하고 간접 endpoint는
     예상 위치의 링크, 제한된 링크 해석, 사전에 확정한 canonical root 내부의 최종 소켓과 ancestor의
     owner·mode·type을 확인한다. root escape, 예기치 않은 중간 링크와 순환·과도한 링크 체인을
     거부한다. 연결 직전 재검증과 대상 교체 경쟁의 처리, 실제 peer/예상 app-server 확인 수단을
     명시하고 보장할 수 없는 경우 fail closed한다. 단순 `lstat`→`stat` 교체나 임의 symlink 허용은
     하지 않으며 Naru-owned relay/Host/Gateway 소켓의 기존 검증은 유지한다.
  3. guardian·relay의 준비/연결/종료를 검증된 endpoint와 lifecycle에 맞춘다. 준비 전 누락만 제한된
     시간 동안 재시도하고 정책 위반·child 조기 종료·handshake 실패를 구분한다. 한 Pane 종료나
     launcher 강제 종료로 다른 Pane·외부 Codex daemon을 종료하거나 타 소유 소켓을 삭제하지 않는다.
     동시에 Task가 소유한 child·연결이 누수되지 않는지 확인한다.
  4. 시작 단계별 제한된 오류 코드를 Naru의 기존 오류 경로에 연결해 원인 없이 종료되는 상태를
     없앤다. child stderr·terminal/Codex 원문·실제 path·credential을 영구 저장하거나 그대로
     표시하지 않는다. 새 runtime의 오류가 정확한 Pane에 반영되고 늦은 이전 runtime 오류가
     새 상태를 덮지 않도록 한다. private IPC 확장이 필요하면 version/consumer 호환과 migration을
     명시하며 Core/Host public protocol에 Codex 전용 상태를 넣지 않는다.
  5. 새 결정과 architecture, 지원 버전·실패 진단·migration 설명을 갱신한다. 기존 runtime을 자동
     재시작하지 않는다. 변경된 launcher/guardian은 Host 의존 payload이므로 현재 distribution에서
     Host/Gateway/Naru 재시작이 예상됨을 배포 계획에 밝히고 실제 artifact의 `restartServices`로
     확인한다. Host restart 뒤 기존 PTY 연속성을 약속하지 않는다.
- 완료 조건·검증 gate:
  - endpoint fixture: 직접 소켓·승인된 간접 소켓 성공, 지연 생성·누락·깨진 링크·순환·root escape·
    잘못된 owner/mode/type·중간 링크·연결 직전 대상 교체·다른 peer·조기 종료의 안전한 거부와
    redacted 오류 분류를 검증한다. 실제 플랫폼에서 검증 가능한 항목과 모의 검증을 구분한다.
  - relay/guardian 및 integration fixture: 신규 시작, 저장 session 재개·`/new`·`/resume`, 승인·질문
    lifecycle, Naru 재연결, 단일 controller handoff와 stale generation 거부, 두 Pane 격리,
    정상 종료·launcher 강제 종료·app-server 장애의 child/연결 회수 및 오류 표시를 확인한다.
  - Node 24·pnpm으로 관련 unit/integration, lint·typecheck·build, 변경 파일 format을 통과한다.
    격리된 실제 CLI 버전별 PTY→guardian→relay→TUI 인수를 fake model/MCP로 수행하고 인증/설정
    거부와 시작 실패도 확인한다. 실제 CLI 인수 없이 fixture 통과만으로 버전 지원 완료를 선언하지 않는다.
    관련 browser reconnect/control/오류 표시 E2E, `pnpm test:operations`,
    `pnpm workstation:distribution:test`, `pnpm test:production-smoke`를 통과한다.
  - 지원 버전별 결과와 미지원 조건, 보안 결정, 배포/rollback 영향이 문서에 남으면 구현 완료로
    처리한다. 실제 운영 인수·배포는 새 artifact와 fresh plan digest 승인 후 별도로 기록한다.
- 범위 제외: Codex 자동 update/downgrade, 기존 active turn의 강제 refresh, global Codex 설정 변경,
  운영 service restart와 배포 실행. 이 Task 등록은 해당 운영 변경의 승인이 아니다.
- lane: Naru Codex integration / Distribution verification
- 진행 결과(2026-09-24): endpoint·relay 구현과 고정 오류 코드, D012 및 architecture를 반영했다.
  실제 CLI 0.154.0·0.155.0·0.156.1의 local synthetic model 인수에서 두 Pane 시작·응답·attachment
  재연결·저장 session 재개·sibling 유지가 통과했다. 운영 관련 64건, distribution 72건,
  browser core-flow 8건·controller handoff 1건·production smoke 1건이 통과했다.
  [지원 경계와 재현 명령](codex-socket-compatibility.md)을 기록했으며 운영 배포는 실행하지 않는다.
  세 버전의 실제 fake MCP 질문→입력 필요→확인 제출→완료 인수도 통과했다. 구버전 bind 직후
  권한 공개 경쟁을 별도 fixture로 고정했고 정상 Host 종료에는 오류 코드를 출력하지 않는다.
  최종 후보 `t59-codex-20260924-r2`의 bundled launcher로 0.156.1 MCP·재개 인수도 통과했다.
  읽기 전용 upgrade plan은 모든 필수 검사 통과, hook trust 경고로 `needs-input`이다.
  준비 당시 restart 대상은 Host/Gateway/Naru였으며 운영 실행은 별도 승인으로 분리했다.
  이후 승인된 r2 배포는 독립 maintenance에서 실행됐으나 launchd 종료 경합으로 실패했고
  자동 복구도 `manual-required`로 끝났다. 독립 SSH 복구와 T60의 r4 배포 뒤 실제 Codex 실행을
  사용자가 확인했다. 원격 push는 하지 않았다.

### T60. Workstation launchd 재시작 종료 경합 방지

- [x] Host·Gateway·Naru upgrade와 실패 복구에서 이전 launchd process의 종료를
      제한 시간 내 확인한 뒤 같은 label을 다시 bootstrap하고, `RunAtLoad` runtime을
      불필요하게 `kickstart -k`하지 않도록 배포 transaction을 보완한다.
- 배경: T59 production upgrade에서 Naru→Gateway→Host `bootout` 직후 Host가 아직
  종료 중인데 같은 label을 bootstrap해 candidate 시작과 이전 receipt 복구가 모두
  즉시 실패했다. Maintenance는 `manual-required`로 종료됐고 종료 완료 시각은
  worker 실패 기록보다 느렸다. 기존 fake runtime은 `bootout`을 즉시 `unloaded`로
  바꾸어 이 경합을 재현하지 못했다.
- 완료 조건:
  - 중지 전 exact service PID와 launchd label을 관찰하고, `bootout` 뒤 label 해제와
    이전 PID 종료가 모두 확인될 때까지 bounded wait한다. PID 재사용·권한 불명·
    timeout은 fail-closed하고 다음 bootstrap을 실행하지 않는다.
  - `RunAtLoad=true`인 세 runtime은 bootstrap 후 readiness로 시작을 확인하고,
    one-shot maintenance에 필요한 kickstart만 유지한다.
  - 지연된 종료를 모사한 unit/integration과 실제 macOS launchd fixture에서 종료 전
    bootstrap이 없고, 정상 upgrade·readiness 실패 후 이전 receipt 복구·timeout 거부를
    확인한다.
  - Node 24의 format·lint·typecheck·변경 범위 test·build,
    `pnpm workstation:distribution:test`, `pnpm test:operations`,
    `pnpm test:production-smoke`를 통과한다. T59의 실제 Codex 0.156.1·MCP 인수를
    candidate bundled launcher로 다시 통과한다.
  - 검증된 clean committed artifact와 fresh upgrade plan을 준비하고 Host 재시작·PTY
    중단, exact digest, source admission과 rollback 경계를 운영 실행 전 다시 검토한다.
- 선행 조건: T59, WV0-D004, WV0-D007
- lane: Workstation distribution / production recovery
- 완료(2026-09-24, Node 24.20.0): same-label 재시작 전에 이전 label 해제와 PID 종료를 함께
  기다리고, 확인 불가·timeout은 다음 bootstrap 없이 거부하도록 구현했다. `RunAtLoad` runtime의
  중복 kickstart를 제거하고 maintenance kickstart만 유지했다. 지연 종료 unit·timeout 및 정상
  upgrade·readiness 실패 복구를 포함한 distribution 74건, 전체 unit 804건(6 skip), format·lint·
  typecheck·build, operations 64건과 production smoke 1건이 통과했다. 격리된 실제 launchd job은
  종료 요청 뒤 약 4.2초 후 `unloaded`로 완료됐고 조기 반환하지 않았다. Clean commit의 `r3`
  artifact bundled launcher로 실제 Codex 0.156.1·fake MCP 질문/확인·재개 인수를 통과했으며,
  fresh plan에서 Host·Gateway·Naru 재시작과 hook trust 경고를 확인했다.
- 운영 결과(2026-09-24): 독립 SSH 복구 후 `t60-launchd-20260924-r4`가 receipt sequence 20으로
  배포됐다. Maintenance 완료, 승인 target 일치와 status/doctor의 전체 필수 검사 정상을 확인했고
  사용자가 Naru 및 실제 Codex 실행 정상을 확인했다. 당시 배포 source는 `9556d37`이다.
- 후속 검토: label이 사라졌지만 이전 PID 종료가 미확인인 timeout 뒤 transaction의 자동 복구가
  bootstrap을 재시도하는 누락을 격리 재현했다. 다음 보완 항목에서 다룬다.

### T61. 종료 미확인 상태의 자동 복구 재시작 차단

- [x] T60의 stop 오류를 transaction 복구까지 보존해 candidate와 이전 release 모두 bootstrap을
      거부한다. 기존 설정·receipt는 보존하고 `manual-required`로 남긴다. 정상 readiness 실패의
      자동 복구는 유지한다. Public protocol·receipt schema·migration 변경은 없다.
- 완료 조건: Host/Gateway/Naru 각각 label 해제 뒤 PID 종료 미확인 상황을 transaction fixture로
  검증하고, distribution·operations·production smoke·lint·typecheck·build·format을 통과한다.
  T59/T60과 이번 보완을 main에 정리하되 사용자 기존 변경을 분리하고 운영 재배포·원격 push는 하지 않는다.
- 선행 조건: T60. 운영 r4는 그대로 유지하고 이번 보완은 다음 승인된 배포부터 적용한다.
- 완료(2026-09-24, Node 24.20.0): 내부 종료 미확인 오류를 보존해 설정 snapshot만 복원하고
  runtime 재시작 없이 `manual-required`로 종료한다. 세 서비스별 transaction 회귀를 포함해
  distribution 77건, operations 64건, production smoke 1건, lint·typecheck·build·변경 파일
  format과 공개 scan(0 findings)이 통과했다. Smoke의 최초 sandbox Chrome SIGABRT는 정상
  브라우저 권한의 동일 로컬 검사에서 해소됐다. T59/T60과 함께 main 통합 대상으로 정리했고
  기존 사용자 변경은 제외했다. 운영 배포·재시작·원격 push는 실행하지 않았다.

### T62. 태블릿 다중 Pane keyboard resize stun·waterfall 해소

- [>] 태블릿에서 소프트 키보드가 열리거나 닫힐 때 여러 visible Pane이 동시에 resize되며 입력과
  화면 갱신이 잠시 멈추고 단계적인 waterfall처럼 보이는 성능 문제를 재현·계측하고 해소한다.
  T52·T56에서 완료한 blank·focus·renderer lifecycle 안정화는 유지하며 완료 Task를 다시 열지 않는다.
- 사용자 보고(2026-09-24): 태블릿의 다중 Pane 레이아웃에서 키보드가 열리면 각 Pane의 크기 변경이
  한꺼번에 일어나고, 단일 Pane 모바일 화면보다 긴 stun과 resize waterfall이 체감된다.
- 추가 보고(2026-09-24): 모바일 overlay 프로젝트 목록을 열어 다른 프로젝트를 선택하면 새 workspace가
  열린 목록 뒤에서 먼저 load·resize되고, 이후 목록이 닫히며 다시 layout·resize되어 한 번의 전환이
  두 번의 로딩처럼 보인다. 프로젝트 선택, target workspace commit, overlay 닫기와 focus 복구를 하나의
  일관된 UI transition으로 묶어 최종 geometry가 아닌 중간 상태에서 Pane fit·Host resize를 시작하지
  않게 한다. Desktop rail/pinned sidebar의 의도적인 폭 변경은 별도 동작으로 보존한다.
- 조사·구현 범위:
  - 실제 키보드 전환에서 `visualViewport`·window resize, workspace layout, Pane별 `ResizeObserver`,
    fit 측정·적용, xterm reflow·render와 authoritative PTY resize의 순서·중복·소요 시간을 계측한다.
    terminal 원문, project path와 실제 instance 식별자는 수집하거나 로그에 남기지 않는다.
  - 여러 Pane의 같은-frame DOM read/write와 fit/reflow가 직렬 waterfall을 만드는지 확인하고, 원인에
    맞춰 animation-frame 단위 batch/coalescing, 동일 geometry 중복 제거와 hidden/collapsed Pane 작업
    억제를 적용한다. 중간 크기를 무조건 모두 Host에 보내지 않되 마지막 확정 크기와 controller
    generation fencing은 보존한다.
  - 모바일 프로젝트 선택 경로의 `flushWorkspace`·workspace load/commit·overlay close·focus 순서를
    계측하고, 성공 시 target Pane을 최종 viewport에 한 번만 배치한다. load·flush 실패에서는 현재
    workspace와 프로젝트 목록의 재시도 가능 상태를 보존하고 잘못된 프로젝트로 focus하거나 resize를
    보내지 않는다.
  - active Pane의 입력·focus·IME, terminal tail과 local scroll offset, 선택 범위, reconnect와 단일
    controller handoff를 보존한다. 성능 개선을 위해 Pane·renderer·PTY를 재생성하지 않는다.
- 완료 조건:
  - Samsung Internet 설치 PWA의 태블릿에서 shell·Codex를 섞은 다중 visible Pane으로 키보드
    열기·닫기를 반복해 수정 전후 event 수, frame gap/long task와 interactive recovery 시간을 비교한다.
    마지막 viewport 변화 뒤 불필요한 후속 resize waterfall이 없고 사용자가 체감 stun 해소를 인수한다.
  - 동일 geometry의 중복 fit·terminal·Host resize는 0건이고, 한 animation frame에서 같은 Pane의
    resize 적용은 최대 1회다. 최종 terminal geometry와 Host authoritative geometry가 일치한다.
  - 모바일 overlay에서 프로젝트를 선택하면 목록 닫기와 target workspace 표시가 중간 Pane geometry
    노출 없이 한 전환으로 끝나고, target Pane별 최초 authoritative resize는 최종 geometry만 보낸다.
    project flush/load 실패, 현재 프로젝트 재선택과 desktop rail navigation 회귀도 검증한다.
  - 1440px·768px·360px와 동적 viewport 자동화에서 blank frame, focus·키보드 유실, live-tail 이동과
    T29/T44/T52/T56 회귀가 없으며 관련 unit·browser E2E·typecheck·lint·format·web build가 통과한다.
- ownership·병렬 경계: Mobile UI performance lane이 `TerminalPane`의 resize path,
  `terminal-resize`, `App`의 모바일 project selection, `project-navigation`과 viewport/layout scheduler
  및 전용 test를 소유한다. 같은 `TerminalPane`, `App`, `use-workspace-view`, `WorkspaceLayout` 또는
  관련 shared style을 바꾸는 T46/T48 및 다른 UI 작업과는 직렬로 수행한다. T54 Activity와
  distribution 작업은 이 파일 경계를 침범하지 않을 때만 병렬로 진행한다. Host·Gateway·distribution·
  public protocol 변경은 범위 밖이며 필요하면 별도 Task와 integration gate를 만든다.
- 선행 조건: T52, T56. 사용자가 다음 작업으로 지정했으므로 T46/T48보다 먼저 수행한다.
- lane: Mobile UI performance

### T69. Codex native transcript의 휠·터치 스크롤

- [-] Codex 기본 화면 모드를 유지하고 Naru의 PC 휠과 모바일 터치를 지원한다.
- 조사: 실제 CLI 0.156.1은 normal buffer 이력을 쌓지만 0.157.1은 alternate buffer와
  mouse tracking을 사용했다. 일반 scrollback API만 호출하는 터치 경로로는 움직일 수 없다.
- 구현: xterm serializer가 누락한 SGR/pixel mouse encoding을 Host·legacy snapshot에서 복원한다.
  PC reload 후 휠 실패를 수정 전 재현했고 수정 후 통과했다. 터치는 alternate screen의 tracking이
  활성화된 경우 xterm wheel 경로를 사용하고 기존 controller generation fence를 유지한다(D019).
- 검증(2026-09-27, Node 24): 실제 CLI 0.157.1 + synthetic model + Chrome에서 고정 1440/768/360px
  각각 휠·합성 터치·reload·observer 입력 거부·takeover 후 스크롤 3건 통과. 동적 높이의 화면 넘침도
  확인했다. keyboard/focus·접근성 및 observer 기존 E2E 2건, production-smoke 1건, 관련 unit 51건,
  operations 64건, distribution 77건 통과. build·typecheck 통과.
- 전체 unit은 일반 OS 권한에서 806 통과·4 실패·6 skip이었다. hook 3건은 현재 Naru PTY가 상속한
  relay/bootstrap 환경을 테스트 자식에서 제외하자 통과했고 process-runner 1건은 단독 재검증에서
  통과했다. 이들을 스크롤 변경의 회귀로 확인한 것은 아니다.
- 미완료: 같은 세션을 1440 → 768(900 → 620 높이) → 360px로 연속 전환하며 스크롤하면
  출력 일부가 어긋나는 현상이 간헐적으로 관찰됐다. 원인 및 이번 변경과의 인과는 미확정이다.
  고정 viewport 테스트로 대체해 이 문제까지 해결됐다고 판단하지 않는다. 실제 모바일 기기 인수와
  연속 크기 전환 검증을 남기고 Task를 진행 중으로 유지한다. 운영 배포·restart는 하지 않았다.
- 완료 조건: 실제 CLI의 격리 synthetic model에서 PC·터치 스크롤을 확인하고, 일반 shell scrollback,
  observer 입력 거부·controller handoff·reconnect, 키보드·focus와 1440/768/360px·동적 viewport를
  관련 unit/E2E로 검증한다. 운영 설정·배포·restart는 하지 않는다.
- 운영 상태 정정(2026-10-07): 위 "운영 배포·restart는 하지 않았다"는 기록 뒤 운영 instance에
  `t63-native-scroll-20260927-r1` release가 설치되어 현재 Host·Gateway가 이를 실행 중이다. 설치본
  source map의 server·Host·Gateway·CLI source는 이 Task의 커밋 `b3dc7a8` 이후 main과 파일 단위로
  일치한다. 해당 release의 원래 source commit은 정리된 임시 저장소에만 있었다. 실제 기기 인수와
  연속 크기 전환 검증은 여전히 미완료이므로 상태는 `[-]`로 유지한다.
- 번호 재부여(2026-10-07): `model/claude` 통합 시 Claude 계열 T63과 겹쳐 T69로 바꿨다. 커밋 메시지의
  T63·D013·D014·D015 표기는 각각 T69·D019·D020·D021이다(D022).

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
- [x] T44 모바일 output 선택·복사
  - 모바일의 Codex·shell Pane에서 출력 텍스트를 길게 눌러 선택하고 범위를 조정해 명시적인
    복사 동작으로 일반 텍스트를 clipboard에 쓴다. 긴 누르기를 가로채는 브라우저를 위해
    선택 도구 진입점도 제공한다. 입력에 초점이 있어도 출력의 문자·공백 셀 긴 누르기는 선택을
    시작하고 Android 네이티브 선택 동작을 연다. 보기 전용 화면에서도 선택·복사할 수 있다.
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
  - main 통합 검증(2026-09-15): format·lint·typecheck·test·build, 공개 scan
    498 files·673 objects·0 findings, 전체 E2E 22/22 통과. 첫 E2E 실행의 기존 폴더블
    키보드 닫기 시 column 유지 검사는 한 차례 실패했지만, 단독 실행과 전체 재실행에서는
    재현되지 않았다.
  - 실기기 보완(2026-09-15): 범위 선택 뒤 선택되지 않은 출력을 탭해도 새 선택으로 남아
    입력으로 돌아가지 못한다는 사용자 확인을 반영했다. 선택 범위 밖 탭은 선택 모드를
    해제하고 xterm 입력 focus를 복원하며, 선택이 없는 명시적 선택 모드의 첫 탭·드래그와
    핸들 조정은 유지한다. 관련 unit과 터치 E2E가 통과했다.
  - 실기기 재확인(2026-09-16): 입력 focus 중 출력 긴 누르기가 키보드 입력으로 남고, 선택 뒤
    바깥 탭도 해제되지 않았다. 출력 문자가 있는 셀은 focus 여부와 관계없이 긴 누르기 선택을
    시작하고, Samsung Internet이 pointer 처리 중 xterm 선택을 먼저 지워도 마지막 유효 범위를
    유지해 후속 탭을 선택 종료로 처리한다. 후속 확인에서 xterm canvas 선택에는 Android의 기본 선택 메뉴가
    나타나지 않고 pane의 다른 부분을 눌러도 해제되지 않았다. 선택 직후 pane 위에 복사·전체·취소
    도구를 띄운다. 셀 좌표 기반 바깥 판정은 모바일 xterm 줄 배치와 달라 자동화에서도 실패해
    제거했다. 선택 범위가 있으면 메뉴·핸들을 제외한 pane의 짧은 터치를 capture `touchstart`에서
    해제하고, 범위 조정은 핸들로만 수행한다. 관련 unit 4건과 선택·복사 및 기존 Samsung UA
    입력·이미지 E2E 4건이 통과했다.
  - 네이티브 복사 보완(2026-09-16): Samsung Internet의 네이티브 선택 메뉴는 나타나지만
    `복사`가 빈 clipboard로 끝나고 앱 알림도 없다는 사용자 확인을 반영했다. 떠 있는
    복사·전체·취소 메뉴는 제거했다. xterm 좌표 선택을 숨은 입력 요소의 실제 텍스트 선택으로
    동기화하고 `contextmenu` 기본 동작을 허용하며, 네이티브 `copy` 이벤트에 선택한 일반 텍스트를
    제공한 뒤 성공 알림을 표시한다. 터치 종료 중 xterm이 선택을 먼저 지우는 경우에도 보관한
    범위와 텍스트를 사용한다. 선택 핸들과 pane 바깥 탭 해제·focus 복원은 유지한다. Node 24에서
    관련 unit 12건, shell·Codex 네이티브 copy 및 Samsung UA 입력 E2E 3건, typecheck가 통과했다.
  - 네이티브 복사 재보완(2026-09-16): 네이티브 메뉴의 `복사`가 계속 clipboard와 앱 알림에
    전달되지 않고, 공백 셀의 긴 누르기에는 메뉴가 나타나지 않는다는 실기기 결과를 반영했다.
    terminal 내부 요소에 한정했던 `copy` 수신을 현재 선택을 소유한 pane의 document capture로
    옮기고, 메뉴 동작 직전 pane touch가 선택 표시를 먼저 지워도 10초 동안 원문만 보관해 복사
    이벤트에 제공한다. 다른 입력 요소의 복사는 가로채지 않는다. 공백 셀도 선택 모드에 진입하며,
    빈 xterm 선택은 숨은 textarea의 non-breaking space 한 글자로 네이티브 선택 범위를 만든다.
    clipboard에는 placeholder 대신 원래의 빈 값을 제공하고 빈 선택 알림을 표시한다. 관련 unit
    13건과 공백 긴 누르기를 포함한 shell·Codex 네이티브 copy 및 Samsung UA 입력 E2E 3건,
    lint·typecheck·web build가 통과했다.
  - 네이티브 제한과 수용(2026-09-16, 2026-09-24 정리): Samsung Internet의 ActionMode는 앱 선택을
    해제해도 다른 pane에 focus를 옮길 때까지 남을 수 있고, textarea blur·DOM 선택 축소·일시적
    disabled로도 실기기 도구 모음을 안정적으로 닫을 수 없었다. 이후 네이티브 도구 모음에 의존하지
    않고 앱 소유의 복사·붙여넣기·전체·취소 도구 모음을 사용하도록 바꿨으며, 사용자가 이 동작을
    수용했다. 브라우저 ActionMode의 제어 한계는 알려진 플랫폼 제한으로 기록하되 T44의 미해결
    기능 문제나 별도 후속 Task로 취급하지 않는다.
  - 실기기 인수·통합(2026-09-16): 9443 격리 테스트 서버의 Samsung Internet 실기기/PWA에서
    문자·공백 긴 누르기, 네이티브 메뉴, 일반 텍스트 복사, 선택 해제와 키보드 복귀를 사용자가
    확인했다. 효과 없는 네이티브 해제 우회를 제거한 `e642078`까지 main에 fast-forward 통합했고
    테스트 서버를 종료했다. 이후 앱 소유 도구 모음, 붙여넣기와 선택 중 edge 자동 스크롤까지
    실기기에서 확인해 위 플랫폼 제한을 수용하고 T44를 완료 상태로 유지한다.
- [ ] T46/T48 모바일 helper focus·draft lifecycle
- [ ] T47/T37/T38/T39는 Private Ingress cutover 뒤 재검토
