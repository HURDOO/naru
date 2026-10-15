# Claude 런타임 검증 spike

Agent Platform V03, V05, V07과 추가 조사(a~d)의 재현 스크립트다. 결과와 판정은
`docs/agent-platform-v0/validation/claude-runtime.md`에 있다. 기본 `pnpm test`에는 포함되지 않는다.

## 전제

- macOS, Node.js 24, 설치된 Claude Code CLI 2.1.296과 로그인된 사용자 계정이 있어야 한다.
  모든 스크립트는 **실제 model을 호출**하므로 사용량이 발생한다.
- 저장소 밖의 scratch git repo를 작업 디렉터리로 쓰고, owner-only log 디렉터리를 준비한다.
  원문 출력(stream-json, PTY 화면, hook payload)은 log 디렉터리에만 기록되고 stdout에는
  redacted 판정만 출력된다.
- spike session은 `--setting-sources project,local`로 사용자 global settings와 그 hook을 제외한다.
  중첩 실행을 피하려고 부모 Claude Code·Naru·Codex 환경 변수 없이 최소 env로 실행한다.
- TUI를 쓰는 스크립트는 scratch workspace의 folder trust dialog를 처음 한 번 자동으로 수락한다.
  이 상태는 사용자 Claude 설정의 해당 경로 항목에 기록된다.

```sh
export NARU_SPIKE_CLAUDE=<claude executable>
export NARU_SPIKE_WORKSPACE=<scratch git repo>
export NARU_SPIKE_LOG_DIR=<owner-only log dir>
# 선택: export NARU_SPIKE_MODEL=sonnet
```

## 스크립트

| 스크립트                    | 항목               | 내용                                                                               |
| --------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `v03-resume-roundtrip.ts`   | V03, (a)           | print turn → PTY TUI `--resume` turn → print `--resume` turn과 hook payload        |
| `v03-concurrent-writers.ts` | V03                | print 두 개를 동시에 resume, idle TUI와 print를 함께 resume                        |
| `v03-background-attach.ts`  | V03                | `--bg` session에 terminal 두 개를 live attach, detach, 실행 중 `--bg --resume`     |
| `v03-print-live-attach.ts`  | V03                | 실행 중인 print session의 목록 노출과 `claude attach` 가능 여부                    |
| `v05-subagent-trace.ts`     | V05                | task 이벤트, Subagent hook, `--forward-subagent-text`, 실행 중 client 메시지, 억제 |
| `v07-agent-teams.ts`        | V07                | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`에서 print와 TUI 모드 비교                 |
| `x-mcp-identity.ts`         | (b)                | session별 MCP server env와 process env 상속                                        |
| `mcp-identity-stub.mjs`     | (b)                | 의존성 없는 stdio MCP stub. token은 hash 앞부분만 반환                             |
| `sdk/`                      | V03, V05, (c), (d) | Agent SDK 0.3.296 스크립트. 저장소 밖에 복사해 `npm install` 후 실행               |

```sh
node --import tsx tests/spikes/claude-runtime/v03-resume-roundtrip.ts
```

## 정리

- `v03-background-attach.ts`는 자기가 만든 background session과 copy만 `claude stop`과 `claude rm`으로
  제거한다. `--bg`가 시작한 transient daemon은 session이 모두 사라지면 스스로 종료되는 것을
  확인했다.
- TUI 스크립트는 `/exit`로 종료하고, 종료되지 않으면 자기가 띄운 PTY만 종료한다.
- spike session의 대화 기록은 Claude Code가 사용자 상태 디렉터리에 저장한다. 필요하면 해당 scratch
  workspace 경로에 대해 `claude purge <path>`로 삭제한다.
