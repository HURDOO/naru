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

WV0-D007 이후 upgrade plan은 artifact manifest의 runtime 의존 파일과 현재 receipt의 서비스별
release pin을 비교한다. Web-only upgrade는 Naru만 새 release로 옮기고 Host/Gateway는 이전
immutable release의 실행 설정과 launchd definition을 유지한다. Additive receipt pin이 없는
기존 installation은 세 서비스가 receipt의 단일 artifact를 사용한 것으로 해석한다. Doctor는
혼합 pin의 각 artifact와 실제 설정 파일을 검증하며, 실패 복구는 영향을 받은 서비스만 되돌린다.

Runtime 교체와 실패 복구는 같은 launchd label을 즉시 재사용하지 않는다. 중지 전에 관찰한 exact
label의 PID가 종료되고 label이 해제된 두 조건을 bounded wait로 확인한 뒤 새 plist를 bootstrap한다.
확인할 수 없거나 timeout이면 다음 bootstrap을 거부한다. Host·Gateway·Naru는 `RunAtLoad=true`이므로
bootstrap 뒤 별도 `kickstart -k` 없이 readiness를 기다리며, independent one-shot maintenance만
명시적으로 kickstart한다.

종료 미확인 오류는 transaction 복구까지 보존한다. Label이 이미 사라져도 종료 확인으로 해석하지
않으며 기존 설정 snapshot만 복원하고 자동 runtime 재시작 없이 `manual-required`로 남긴다.

## Web release

Canonical browser Origin은 instance intent에서 결정론적으로 렌더한다. Manifest, service worker, Passkey
RP hostname과 Push subscription이 같은 Origin을 사용해야 하며 drift는 fail-closed한다. Service worker는
versioned app shell만 cache하고 API, authentication, terminal data와 Gateway login route를 cache하지
않는다.
