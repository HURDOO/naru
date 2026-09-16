# Agent coordination v0

이 문서는 같은 Codex root thread에서 별도 worktree를 맡은 worker와 integration agent 사이의
작업 메시지 규약이다. 제품 runtime의 agent-to-agent protocol이 아니며 transport, mailbox daemon이나
새 persistence service를 추가하지 않는다. 코드와 검증 결과는 Git commit으로 전달하고 메시지는
제어 정보만 담는다.

## Topology

- root agent가 사용자 대화, Task 상태, 공통 계약, integration과 최종 검증을 소유한다.
- worker는 서로 직접 협상하지 않고 root agent에만 메시지를 보낸다.
- worker가 실행 중일 때 root는 `wait_agent`로 기다리고, idle worker의 후속 작업은
  `followup_task`로 시작한다.
- 사용자 결정이 필요하면 모든 agent는 turn을 끝낸다. 사용자의 다음 메시지가 root를 다시 시작한다.
- 기존 worker를 재개할 수 없으면 새 worker가 worktree, Git SHA와 handoff를 읽고 Task를 복구한다.

## Envelope

메시지는 다음 YAML 형태를 사용한다.

```yaml
protocol: naru-coordination/v0
type: progress
taskId: t56-focus-stability
messageId: t56-focus-stability/1
sender: mobile-worker
recipient: integration
baseSha: 0123456
payload: {}
```

허용 `type`은 `task.accepted`, `progress`, `decision.request`, `handoff.ready`,
`integration.accepted`, `integration.rework`, `task.cancelled`다. `messageId`는 Task 안에서 유일하고
worker가 단조 증가시킨다.

## Decision request

```yaml
type: decision.request
payload:
  blockingScope: service-worker-scope
  canContinue: true
  recommendation: app별 service-worker scope 사용
  alternatives:
    - root app만 PWA 허용
  reason: root scope가 다른 app navigation을 가로챌 수 있음
```

`canContinue: true`면 worker는 결정과 독립적인 작업을 계속한다. root는 긴급한 전체 blocker가 아니면
여러 요청을 모아 사용자에게 한 번에 제시한다.

## Handoff

```yaml
type: handoff.ready
payload:
  headSha: 89abcde
  completed: []
  tests: []
  deferred: []
  risks: []
  changedPaths: []
  requestedIntegrationOrder:
    after: []
    before: []
```

worker는 handoff 전에 자기 범위의 변경을 commit한다. Terminal/Codex 원문, token, cookie, private key,
실제 instance path·domain·IP와 credential은 메시지, commit이나 테스트 증거에 넣지 않는다.

## Ownership

- root 전용: `docs/TASKS.md`, 계약 문서, root `package.json`, `pnpm-lock.yaml`, 공통 E2E fixture,
  migration 번호와 integration branch.
- worker는 assignment에 명시된 경로만 수정한다. 공통 경로가 필요하면 `decision.request`로 넘기고
  다른 작업을 계속한다.
- worker는 실제 instance 변경, 서비스 restart, browser permission, remote 작업과 배포를 수행하지
  않는다.
