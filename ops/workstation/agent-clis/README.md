# Agent CLI 설치·업데이트

Naru Pane, 로컬 셸과 ssh 셸은 같은 npm 전역 Codex·Claude Code 설치본을 쓴다. Workstation intent의
`codexExecutable`·`claudeExecutable`은 버전 이름이 없는 package 내부 실제 파일을 가리킨다.

- Codex: `<npm root>/@openai/codex/node_modules/@openai/codex-<platform>/vendor/<target>/bin/codex`
- Claude Code: `<npm root>/@anthropic-ai/claude-code/bin/claude.exe`

distribution은 symlink가 포함된 실행 경로를 거부하고, Naru는 Pane을 시작할 때마다 경로만 확인한다.
그래서 npm이 같은 경로의 파일을 교체하면 Naru 재설정이나 Host 재시작 없이 다음 Pane 시작부터 새 버전을
쓴다. Homebrew cask나 Codex standalone처럼 버전별 경로를 쓰는 설치본은 intent에 넣지 않는다.

## 업데이트

```sh
ops/workstation/agent-clis/update-agent-clis.sh --check   # 버전과 PATH 해석만 확인
ops/workstation/agent-clis/update-agent-clis.sh           # 두 CLI를 최신으로 설치
```

갱신할 Pane에서 Ctrl+C로 CLI를 종료한 뒤 "Codex 작업 재개" 또는 "Claude 작업 재개"로 같은 대화를
다시 연다. 실행 중인 다른 Pane은 기존 버전으로 계속 동작한다. Claude Code 자체 자동 업데이트는 사용자
설정 `DISABLE_AUTOUPDATER=1`로 끄고 이 명령으로만 갱신한다.

`--ssh-daemon`은 ChatGPT 앱의 SSH 원격 접속이 쓰는 Codex app-server daemon package도 갱신한다.
이 daemon은 `~/.codex/packages/standalone`의 자체 사본에서 실행되며, 갱신 시 재시작되어 연결된 SSH
Codex 세션이 끊긴다. 지정하지 않으면 버전만 보고한다.

스크립트는 root 실행을 거부하고, Homebrew cask가 `claude` 링크를 소유하면 npm 설치 전에 중단한다.

Claude Code와 Codex의 `update-agent-clis` 스킬은 같은 `SKILL.md`를 hardlink로 공유한다. Codex는 symlink인
`SKILL.md`를 읽지 않는다. 파일을 교체 저장하는 편집기는 hardlink를 끊으므로 `--check`가 이를 경고한다.
