# Codex socket compatibility (T59)

## 지원 경계

2026-09-24 macOS arm64·Node 24에서 실제 CLI `0.154.0`, `0.155.0`, `0.156.1`의
Host PTY → guardian → relay → TUI 경로를 격리 인수했다. 로컬 synthetic Responses 서버와
새 HOME/CODEX_HOME을 사용했으며 운영 인증정보·외부 모델 서비스는 사용하지 않았다.
두 Pane 시작, 모델 응답, attachment 재연결, 한 Pane 종료와 저장 session 재개, 다른 Pane 유지가
통과했다. 이후 CLI 버전의 전체 protocol 호환을 자동으로 보장하지 않는다.
추가 `NARU_ACTUAL_CODEX_MCP=1` 인수는 fake MCP의 사용자 선택 요청을 실제 CLI로 발생시켜
Naru의 입력 필요 표시와 확인 후 완료 복귀도 검증한다. 실제 외부 MCP 권한은 사용하지 않는다.

`0.156.1`은 advertised Unix socket 대신 보호 소켓으로 연결되는 symlink를 만든다.
`--no-daemon`만으로 기존 직접 소켓 형태로 돌아가지 않는다. 승인되는 정확한 경로·권한·신뢰 경계는
[D012](DECISIONS.md#d012-codex의-간접-endpoint는-고정된-보호-소켓만-가리킨다)를 따른다.
새 소켓 정책은 Codex app-server adapter에만 적용되며 Naru/Host/Gateway 자체 소켓 정책은 불변이다.

## 진단

실패한 runtime의 PTY에 다음 고정 코드만 출력한다. 원문 child stderr·경로·credential은 복사하지 않는다.

| 코드                                      | 의미                                                      |
| ----------------------------------------- | --------------------------------------------------------- |
| `NARU_CODEX_ENDPOINT_REJECTED`            | socket type·owner·mode·alias 또는 연결 전후 identity 위반 |
| `NARU_CODEX_APP_SERVER_TIMEOUT`           | 제한 시간 내 endpoint가 준비되지 않음                     |
| `NARU_CODEX_APP_SERVER_EXITED`            | app-server가 준비 중 또는 사용 중 종료됨                  |
| `NARU_CODEX_APP_SERVER_CONNECTION_FAILED` | 검증된 endpoint 연결 또는 WebSocket handshake 실패        |
| `NARU_CODEX_TUI_EXITED`                   | TUI의 비정상 종료                                         |
| `NARU_CODEX_RELAY_FAILED`                 | 그 외 relay 오류                                          |

임의 symlink 허용, 보호 디렉터리 chmod, 전역 daemon 종료로 우회하지 않는다. 설치·인증·설정 실패는
기존 launch preflight 오류 경로를 유지한다. CLI 시작 시 새 모델 안내는 socket 장애가 아니며,
인수 fixture는 자기 CODEX_HOME 안에서만 해당 안내를 기확인 처리한다.

## 재현 가능한 격리 검증

Node 24가 PATH의 첫 `node`가 되도록 한 뒤 root-base web build를 준비한다.

```sh
NARU_APP_BASE_PATH=/ pnpm build
NARU_ACTUAL_CODEX=/absolute/path/to/codex pnpm exec vitest run apps/server/test/codex-socket.actual.acceptance.test.ts
NARU_ACTUAL_CODEX_MCP=1 NARU_ACTUAL_CODEX=/absolute/path/to/codex pnpm exec vitest run apps/server/test/codex-socket.actual.acceptance.test.ts
NARU_ACTUAL_CODEX=/absolute/path/to/codex node --import tsx ops/workstation/dev/codex-test-server.ts
```

마지막 명령은 별도로 설정한 테스트 전용 `NARU_TEST_PASSWORD` 환경변수가 필요하다.
임의 loopback port에 실제 Naru와 Host를 열고 URL만 출력하며 비밀번호는 출력·저장하지 않는다.
운영 저장소·세션·global Codex config와 분리되어 있고, CLI 응답은 local synthetic model 결과다.
실제 OpenAI 계정 인증·실서비스 모델 품질·운영 ingress 인수를 대체하지 않는다.

## 배포와 rollback

기존 runtime은 자동 변경하지 않는다. 새 launcher는 Host 의존 payload이므로 upgrade plan의
`restartServices`를 확인해야 한다. Host restart가 포함되면 기존 live PTY는 유지되지 않는다.
운영 configuration·Codex executable·Origin·root는 이번 upgrade에서 변경하지 않는다.
이전 release로 rollback하면 이전 CLI만 지원하던 endpoint 검사도 복원되므로 `0.156.1` 신규 시작
문제가 다시 생길 수 있다. CLI downgrade나 전역 설정 변경은 별도 결정이며 자동 수행하지 않는다.
운영 실행은 검증된 candidate와 fresh digest 승인·source admission 절차 뒤 별도로 수행한다.
