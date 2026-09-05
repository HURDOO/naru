# Private Agent Workstation v0 아키텍처

## Trust chain

```text
browser -- HTTPS/WSS --> Gateway -- loopback/assertion --> Naru -- UDS/capability --> Host
```

각 화살표는 독립된 인증·권한 경계다. Network source, Gateway assertion과 Host capability는 서로 대체할
수 없다.

## Runtime namespace

Installation ID와 OS uid에서 non-secret namespace를 만들고 Host, Gateway, Naru와 independent
maintenance job에 서로 다른 private socket/data/service path를 배정한다. Receipt가 exact path, owner,
mode, executable, Origin과 release digest를 고정한다.

## Lifecycle

1. Private intent를 strict schema로 읽는다.
2. Read-only plan이 current state와 candidate digest를 계산한다.
3. 사용자가 exact digest를 승인한다.
4. Independent maintenance worker가 immutable candidate를 설치한다.
5. Host, Gateway, Naru readiness와 browser-to-PTY chain을 doctor한다.
6. 실패하면 package-owned state만 이전 receipt로 rollback한다.

Gateway와 Naru는 재시작해도 Host Session을 다시 attach한다. Host restart는 PTY continuity를 보장하지
않으며 persisted metadata를 stopped로 복구한다.

## Web release

Canonical browser Origin은 instance intent에서 결정론적으로 렌더한다. Manifest, service worker, Passkey
RP hostname과 Push subscription이 같은 Origin을 사용해야 하며 drift는 fail-closed한다. Service worker는
versioned app shell만 cache하고 API, authentication, terminal data와 Gateway login route를 cache하지
않는다.
