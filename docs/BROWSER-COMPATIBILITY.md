# 브라우저 호환성 정책

## 지원 기준

Naru의 기본 자동 브라우저 대상은 프로젝트 Playwright 설정이 선택한 Chromium 계열이다. Release가 특정
Chrome 또는 Android browser 버전을 지원한다고 주장하려면 해당 release commit에서 자동 회귀와 별도의
실기기 acceptance를 다시 수행해 release note에 기록해야 한다. 이 저장소에는 개인 기기, production
listener 또는 과거 release의 인수 결과를 보존하지 않는다.

Safari와 Firefox는 현재 보장 범위가 아니다. Playwright mobile viewport는 반응형 layout 회귀를 검증하지만
Android IME, browser chrome, Fold hardware 또는 OS 알림 동작을 대신하지 않는다.

## 반복 가능한 자동 검증

| 영역               | 검증 진입점                     | 핵심 확인                                                                    |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------------- |
| 핵심 browser flow  | `pnpm test:e2e`                 | 로그인, Project/Pane, reconnect, observer와 controller handoff, 오류·빈 상태 |
| production build   | `pnpm test:production-smoke`    | 정적 build, REST/WSS, PWA manifest·worker, fake Codex와 격리 PTY             |
| terminal rendering | `pnpm test:performance:browser` | scrollback, split, viewport·keyboard resize와 frame continuity               |
| 접근성             | `pnpm test:e2e`                 | keyboard focus, semantic role, desktop·tablet·narrow viewport와 axe 검사     |

UI 변경은 최소 1440px desktop, 768px tablet, 360px narrow mobile과 690px급 Fold viewport에서 확인한다.
동적 viewport 검증은 keyboard 상당 높이 축소와 원래 높이 복귀를 포함해야 하며 같은 renderer, input focus,
runtime identity와 terminal tail을 유지해야 한다.

## Web Push와 PWA 경계

- 알림 permission은 사용자의 명시적 동작 뒤에만 요청하고 `denied` 상태에서 반복 prompt하지 않는다.
- Visible client는 system notification을 억제하며 hidden/offline client만 일반화된 알림을 받을 수 있다.
- Service worker는 versioned app shell만 cache하고 API, 인증, terminal data와 Gateway route를 cache하지
  않는다.
- Canonical Origin 변경은 PWA identity, service worker, Push subscription과 Passkey RP 경계를 함께
  재검증해야 한다.
- 실제 Android background delivery, notification click과 permission 해지는 release별 실기기 검증 전에는
  지원 완료로 주장하지 않는다.

## 실기기 acceptance checklist

실기기 검증은 production과 분리된 instance에서 수행하고 실제 hostname, IP, account, screenshot, terminal
원문 또는 release receipt를 이 저장소에 commit하지 않는다. 비민감 결과는 release 외부 evidence에 둔다.

1. Exact HTTPS Origin에서 로그인하고 비허용 source가 거부되는지 확인한다.
2. Project 전환과 세 종류의 Pane에서 runtime identity가 불필요하게 바뀌지 않는지 확인한다.
3. 세로·가로·Fold 전환과 keyboard 열기/닫기에서 focus, font, color, terminal tail과 입력이 유지되는지
   확인한다.
4. 본문 swipe, scrollbar drag/re-grab, 특수키와 IME 입력을 확인한다.
5. 두 browser context 사이 controller handoff와 이전 controller의 stale input 거부를 확인한다.
6. PWA 설치·업데이트와 opt-in Push를 별도 사용자 승인 경계로 확인한다.
