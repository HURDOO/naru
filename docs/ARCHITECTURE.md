# Naru 기술 아키텍처

## Runtime 구조

```text
private HTTPS browser
        |
        v
+-------------------------+
| Workstation Gateway     |  passkey, Origin, CSRF, source policy
+------------+------------+
             | exact loopback + signed principal
             v
+-------------------------+
| Naru server/web         |  Project, Pane, layout, app authorization
+------------+------------+
             | private UDS + scoped app capability
             v
+-------------------------+
| DurableSession Host     |  PTY, runtime, event sequence, control
+------------+------------+
             |
         shell / Codex
```

## Ownership

| 영역                                                          | 소유자              |
| ------------------------------------------------------------- | ------------------- |
| browser authentication, exact Origin과 ingress                | Gateway             |
| Project, Workspace, Pane, Files/Docs/Tasks, Codex semantics   | Naru                |
| Session, PTY, runtime generation, terminal sequence와 control | DurableSession Host |
| DNS, VPN, route, certificate material과 renewal               | instance operator   |
| install receipt, immutable release와 package-owned services   | distribution        |

Gateway assertion, Naru app authorization과 Host capability는 서로 대체할 수 없다. Browser network
접근도 authentication으로 취급하지 않는다.

## 상태와 연속성

- Host는 Session metadata와 active runtime을 관리하고 bounded snapshot 뒤 sequence event를 제공한다.
- attach/control generation이 바뀌면 old input·resize·resume token을 거부한다.
- Naru는 Pane과 Host Session mapping, Codex activity/session projection을 담당한다.
- Naru 또는 Gateway가 재시작되면 같은 Host runtime에 재attach한다.
- Host restart 뒤 process continuity를 주장하지 않고 persisted Session을 stopped로 표시한다.

## 저장 경계

- SQLite: Project/Workspace/Pane, non-secret view state, activity identity와 migration metadata
- Host private state: Session metadata, app registration과 bounded journal
- memory only: PTY handles, terminal buffer, attachment token, challenge와 live file draft
- never persist: terminal/Codex 원문, browser cookie, capability 원문과 private key

## 배포 경계

Standalone artifact는 pinned Node runtime, application build, license와 manifest를 포함한다. plan과 apply를
분리하고 exact digest 승인 뒤 independent maintenance worker가 package-owned 자원만 변경한다. External
network, DNS와 certificate 상태는 inspect/doctor 대상으로만 취급한다.

Private Ingress v0는 Gateway listener를 `loopback-proxy | direct-private-tls`의 strict adapter로 확장한다.
세부 구현 순서와 freeze gate는 `docs/private-ingress-v0/TASKS.md`가 canonical이다.
