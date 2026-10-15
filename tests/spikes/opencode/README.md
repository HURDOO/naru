# V12 OpenCode/OmO spike scripts

검증 결과는 `docs/agent-platform-v0/validation/opencode.md`에 있다. 이 디렉터리는 재현용 스크립트만
담는다. 새 의존성을 추가하지 않는다. HTTP와 SSE는 Node fetch로 처리하고, `node-pty`와 `@xterm/headless`는
`apps/server`의 의존성에서 resolve한다. 기본 `pnpm test`에는 포함되지 않는다.

## 전제

- OpenCode `1.18.35`, 사용자 설정의 `oh-my-openagent@5.1.28` plugin, 연결된 provider
- 운영 OmO server, Gateway adapter, `~/.config/opencode`는 건드리지 않는다. spike server는 별도
  `127.0.0.1` 임의 port와 임의 password로 직접 띄우고, PID를 기록해 두었다가 종료한다.
- 원문 로그 디렉터리는 저장소 밖 owner-only 경로를 쓴다.
- fresh offline install에서 `node-pty` prebuild `spawn-helper`의 실행 권한이 빠져 있으면
  `posix_spawnp failed`가 난다. 해당 worktree의 `node_modules` 안 파일만 `chmod u+x`로 고친다.

## Spike server

```sh
LOG=<owner-only-log-dir>; WORK=<scratch-git-repo>; PASSFILE=$LOG/../password
umask 077; openssl rand -hex 24 > "$PASSFILE"
cd "$WORK" && OPENCODE_SERVER_PASSWORD="$(cat "$PASSFILE")" \
  opencode serve --hostname 127.0.0.1 --port <port> --print-logs > "$LOG/server.log" 2>&1 &
```

Plugin, MCP, policy 검사용 server B는 사용자 설정을 바꾸지 않고 `OPENCODE_CONFIG_CONTENT`로만 주입한다
(OpenCode가 전역 설정과 merge한다).

```sh
OPENCODE_CONFIG_CONTENT='{"plugin":["file://<repo>/tests/spikes/opencode/naru-observer-plugin.mjs"],
  "mcp":{"naru_stub":{"type":"local","command":["<node>","<repo>/tests/spikes/opencode/naru-stub-mcp.mjs"],
  "environment":{"NARU_SPIKE_MCP_TAG":"server-b-static","NARU_SPIKE_MCP_LOG":"<log>/mcp.jsonl"}}}}' \
NARU_SPIKE_PLUGIN_LOG=<log>/plugin.jsonl NARU_SPIKE_BLOCK_TOOLS=webfetch \
OPENCODE_SERVER_PASSWORD=... opencode serve --hostname 127.0.0.1 --port <port-b>
```

`<node>` 경로에 공백이 있으면 MCP spawn이 `ENOENT`로 실패하므로 공백 없는 경로를 쓴다.

## 실행

```sh
export OPENCODE_SPIKE_URL=http://127.0.0.1:<port> OPENCODE_SPIKE_PASSWORD_FILE=<file> \
  OPENCODE_SPIKE_DIRECTORY=<scratch-git-repo> OPENCODE_SPIKE_LOG_DIR=<owner-only-log-dir>
# 선택: OPENCODE_SPIKE_PROVIDER / OPENCODE_SPIKE_MODEL (기본 openai / gpt-5.6-luna-fast)

node --import tsx tests/spikes/opencode/v12-api.ts basic|permission|abort
node --import tsx tests/spikes/opencode/v12-api.ts history <sessionId>
node --import tsx tests/spikes/opencode/v12-attach.ts            # OPENCODE_SPIKE_PARENT=<id>: child로 생성
node --import tsx tests/spikes/opencode/v12-attach-existing.ts <sessionId> <marker> [typedMarker]
node --import tsx tests/spikes/opencode/v12-children.ts sync|background|intervene
node --import tsx tests/spikes/opencode/v12-identity.ts         # server B, OPENCODE_SPIKE_OTHER_DIRECTORY 필요
```

모든 prompt는 `[naru-spike]`로 시작한다. 스크립트는 marker 존재 여부, 이벤트 종류, 상태, key 이름만
출력한다. 원문 frame과 TUI 화면은 `OPENCODE_SPIKE_LOG_DIR`에만 쓴다.

## 정리

spike server PID와 직접 실행한 tool process만 종료한다. 생성된 `[naru-spike]` 세션은 증거로 남긴다.
지우려면 spike server에서 `DELETE /session/<id>`를 호출한다(공유 data dir이므로 운영 OmO UI 목록에도
같은 project 아래에 보인다).
