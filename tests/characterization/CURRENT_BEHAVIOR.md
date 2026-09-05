# Naru characterization contract

이 문서는 격리 fixture에서 반복되는 자동 characterization 범위만 설명한다. Deployed instance, 실제 Codex
계정·설정, production listener, 기기 또는 사용자 acceptance의 증거가 아니다.

| ID          | 격리 fixture가 고정하는 동작                                                                                        | 자동 관찰                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| CH-PANE-01  | Project 등록은 세 mapped Pane을 만들고 Main/Quick Codex는 한 번만 시작하며 Dev Terminal은 stopped로 둔다.           | `current-naru-lifecycle.characterization.test.ts`                                    |
| CH-PANE-02  | Pane create, natural exit, explicit restart와 close는 한 번에 하나의 PTY incarnation으로 대응한다.                  | `current-naru-lifecycle.characterization.test.ts`                                    |
| CH-PANE-03  | Project workspace read/switch는 중복 PTY를 만들지 않는다.                                                           | `current-naru-lifecycle.characterization.test.ts`                                    |
| CH-PTY-01   | Attach snapshot sequence N 뒤 live output은 N+1부터 이어진다.                                                       | `current-naru-control-auth.characterization.test.ts`, `apps/server/test/pty.test.ts` |
| CH-PTY-02   | Browser disconnect와 same-client reconnect는 같은 fixture runtime을 유지한다.                                       | `current-naru-control-auth.characterization.test.ts`, E2E reconnect flow             |
| CH-PTY-L01  | Compatibility App Server가 직접 소유한 fixture PTY는 server shutdown을 넘어 process persistence를 주장하지 않는다.  | `current-naru-lifecycle.characterization.test.ts`                                    |
| CH-PTY-L02  | Compatibility live output frame shape와 attachment runtime 경계를 고정한다.                                         | `current-naru-control-auth.characterization.test.ts`                                 |
| CH-LEASE-01 | 다른 authenticated browser는 control 요청 전까지 observer로 남는다.                                                 | `current-naru-control-auth.characterization.test.ts`, lease integration tests        |
| CH-LEASE-02 | Explicit takeover는 generation을 증가시키고 이전 browser를 observer로 내리며 stale input을 거부한다.                | `current-naru-control-auth.characterization.test.ts`, lease integration tests        |
| CH-AUTH-01  | App-managed password와 passkey flow는 독립 Naru session cookie를 발급한다.                                          | `current-naru-control-auth.characterization.test.ts`                                 |
| CH-AUTH-02  | REST mutation과 WebSocket upgrade는 session, exact Origin과 필요한 CSRF를 검사한다.                                 | Characterization auth, passkey와 session-cookie tests                                |
| CH-AUTH-03  | Logout은 browser socket을 revoke하지만 current PTY를 stop하지 않는다.                                               | `current-naru-control-auth.characterization.test.ts`                                 |
| CH-APP-01   | Files, Docs와 Tasks는 읽을 수 있고 그 Pane은 PTY를 만들지 않는다.                                                   | `current-naru-application.characterization.test.ts`, document E2E flows              |
| CH-APP-02   | Project/Git target catalog 관찰은 새 runtime을 만들지 않는다.                                                       | `current-naru-application.characterization.test.ts`, project-group tests             |
| CH-APP-03   | Codex activity와 push summary는 authenticated application surface에 투영된다.                                       | `current-naru-application.characterization.test.ts`, activity/push tests             |
| CH-E2E-01   | Desktop reload, mobile projection, takeover, Files/Docs/Tasks와 auth recovery가 fake Codex와 격리 PTY에서 동작한다. | `pnpm test:e2e`                                                                      |
| CH-PATH-01  | Configured root 자체는 Project가 아니며 그 아래 real Project만 허용하고 symlink escape를 거부한다.                  | `apps/server/test/path-policy.test.ts`                                               |

## Deterministic boundary

- Characterization은 in-memory SQLite, bounded fake PTY, fake passkey verification, fixed fake secret과 임시
  Project root만 사용한다.
- Production service, credential, database, listener, network route와 terminal transcript를 사용하지 않는다.
- Random runtime/session identifier는 golden value로 기록하지 않고 reconnect/restart 관계만 비교한다.
- 실제 PTY 또는 browser 인수는 별도의 승인된 isolated environment에서 수행하고 결과를 repository에
  commit하지 않는다.
