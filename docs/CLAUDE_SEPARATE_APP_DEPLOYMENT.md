# Claude 별도 앱 배포 준비

## 현재 상태

- T67 진행 중. 이 문서는 운영 변경 승인이 아니라 source·검증·plan 준비 목록이다.
- 9443 비밀번호 서버는 실행 중인 Claude Pane 때문에 그대로 유지한다.
- 운영 Workstation은 읽기 전용 `status`·`doctor`에서 정상이다. 운영 Gateway에는 기본 Naru 외에
  승인된 추가 앱 등록이 이미 있으므로, 새 plan은 해당 등록을 누락하거나 대체하면 안 된다.
- 현재 Workstation distribution의 `additionalGatewayApps`는 Gateway route만 등록한다. 추가 앱의
  Naru/Host 서비스, 데이터, 자격 증명과 롤백은 별도 소유다.
- T66의 standalone 훅은 그대로 유지한다. T67은 별도 Host가 서명한 current-runtime bootstrap을
  사용하는 Durable Claude 경로를 구현 중이며, 실제 운영 인수는 아직 하지 않았다.

## 확정 topology — 같은 Gateway 아래 별도 앱

```text
기존 canonical HTTPS Origin
  Gateway (기존 Passkey/session)
    /naru          → 기존 Naru → 기존 Host
    /claude-lab    → 별도 Naru → 별도 DurableSession Host → Claude Code
```

별도 Naru/Host는 기존 app의 DB, Host socket, credential, launchd label, loopback port와 data directory를
공유하지 않는다. Gateway는 기존 instance의 인증을 유지하고 새 app ID에만 짧은 assertion을 발급한다.
새 Naru는 exact Origin·app ID·verifier key를 검사한 후 자기 Host credential로만 PTY에 접근한다.
이 방식에서는 별도 Naru 또는 Gateway 재시작이 Claude PTY를 종료하지 않는다. **별도 Host 재시작은
Claude PTY를 종료한다.** 기존 운영 Host는 변경하지 않는 것이 목표다.

별도 앱은 자체 Workstation instance로 관리한다. 이 instance의 Gateway job은 현재 distribution
lifecycle상 loopback 내부 서비스로 함께 생성되지만, 브라우저 route와 Passkey는 기존 Gateway만
사용한다. 별도 Gateway의 listener를 외부에 노출하거나 별도 bootstrap을 하지 않는다. 기존 Gateway의
`additionalGatewayApps` route가 별도 Naru의 loopback port로 향한다. 향후 내부 Gateway job 제거는
별도 lifecycle 변경이며 이번 배포의 전제는 아니다.

별도 private intent에는 `naruAppBasePath`, `externalGateway`(기존 Gateway instance ID, 새 app ID,
owner subject, owner-only 공개 verifier file), `claudeExecutable`,
`defaultAgentPaneKind: "claude"`를 지정한다. `workstation intent`는 `--app-base-path`,
`--external-gateway <owner-only-json>`, `--default-agent-pane-kind claude`를 제공한다. 새 필드는
optional이므로 기존 receipt는 그대로 읽고, 제거 시 구 배포 의미로 돌아간다. 이 intent는 v1
`ingress.kind: "none"`의 non-root route에서만 허용한다. 계획과 doctor는 외부 공개 키의 owner-only
권한·형식을 검사하고, 계획은 선택된 Host release의 Claude launcher/hook 파일을 확인한다.

Naru가 중단된 동안 Host PTY는 이어지지만 그 사이 발생한 hook 이벤트는 재생되지 않는다. 재연결 후
같은 runtime의 첫 이벤트로 진행 중 turn을 최선 노력으로 복구한다. 이 기간의 작업 상태 정확성은
보장하지 않는다.

## 구현·검증 gate

1. 기존 Gateway의 canonical Origin·Passkey를 재사용하는 별도 앱으로 사용자 선택을 고정한다.
   새 HTTPS listener·Passkey·certificate를 만들지 않는다.
2. WV0-D011의 `additionalGatewayApps` 계약을 현재 source에 반영하고 기존 intent/receipt를 읽으며
   기존 등록 모두를 보존하는지 확인한다. 이 단계는 route 설정을 바꾸지 않는다.
3. 별도 Host/Naru의 생성·검증·기동·중지·복구를 책임지는 operator-owned 배포 단위를 만든다.
   기존 Workstation의 receipt-owned 파일을 수동 편집하지 않는다. app ID, credential, socket,
   loopback port, root policy와 launchd label의 충돌을 fail-closed로 검사한다.
4. Claude Host profile에 signed current-runtime bootstrap을 주고, Claude hook의 redacted lifecycle
   신호를 별도 Naru에서 session/runtime/cwd fence 뒤 반영한다. 기존 Codex/standalone hook과 Host
   public protocol은 유지한다. 새 CLI process부터 hook이 적용되며 기존 runtime을 소급 변경하지 않는다.
5. project root의 canonical containment, Gateway HTTP/WSS assertion audience 분리, reconnect,
   controller handoff, Naru/Gateway restart 중 PTY 연속성, Host restart의 stopped 복구를 테스트한다.
   Node 24 `format`, `lint`, `typecheck`, unit, operations, distribution, production smoke 및 격리
   브라우저 인수를 통과한다.
6. clean committed darwin-arm64 source에서 pinned Node artifact를 빌드·검증한다. 기존 운영
   intent와 추가 app 등록을 보존한 private candidate intent의 read-only `plan`을 만들고,
   `restartServices`, source/admission, warning, rollback target과 `planDigest`를 검토한다.

기존 Gateway route 추가는 우선 **현재 설치된 Gateway release를 그대로 쓰는 reconfigure**로 계획한다.
현재 설치된 release는 추가 app 등록을 이미 지원한다. 이 plan의 `restartServices`에 `host`가 있으면
작업을 중단하고 원인을 재검토한다. 별도 Claude instance만 새 artifact로 설치하며, 기존 Host를
새 source로 올리는 upgrade와 route 등록을 한 번에 묶지 않는다. 기존 추가 app 2개와 기본 Naru
등록이 candidate/rollback 모두에서 유지되는지 비교한다.

## 실행 승인 경계

정확한 artifact와 plan이 나온 뒤에만 신규 서비스 설치, 기존 Gateway `reconfigure`, 필요 시 기존
Workstation `upgrade`를 각각 검토한다. `upgrade`가 Host payload 변경으로 기존 Host를 재시작하면
현재 운영 PTY가 중단될 수 있으므로 이를 별도로 명시한다. `deploy-naru` 절차대로 정확한 digest와
변경 서비스에 대한 승인을 받기 전에는 mutation을 실행하지 않는다. 9443, DNS, VPN, 인증서 발급,
remote repository는 이 작업에서 변경하지 않는다.
