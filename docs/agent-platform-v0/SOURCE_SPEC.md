# Naru Agent Platform — 아키텍처 · 검증 · 구현 명세

> **문서 상태:** 구현 착수용 제품/기술 명세 v1.0 · 2026-10-15  
> **수신 대상:** Claude Code(주 구현 총괄), Codex/Sol(전문 검증·구현), 기타 위임받은 에이전트  
> **중요:** 이 문서는 사용자와 합의한 **목표와 제약**을 정의한다. 현행 코드·SDK·CLI·API의 실제 지원 여부를 검증한 결과가 아니다. **Phase 0/1 검증 후, 근거를 남기고 구현**한다.

## 0. Claude에게 주는 최상위 실행 지시

당신은 Naru Agent Platform 전환의 기술 책임자다. 기존의 **Gateway / Naru / DurableSession** 세 코드베이스를 먼저 조사한 뒤, 이 문서의 미검증 사항을 재현 가능한 테스트로 검증한다. **검증이 완료되면 그 결과에 근거하여 실제 구현에 착수하고, 작동하는 통합 결과와 증빙까지 만든다.** 보고서만 작성하고 종료하지 말 것. 그러나 다음 조건이 해당하면 임의로 우회 구현하지 말고 사용자에게 의사결정을 요청할 것.

- 원래 제품 의도·아키텍처를 변경해야 하는 경우
- 비공식·역공학·불안정한 API를 새 핵심 의존성으로 채택해야 하는 경우
- 기존 GUI/TUI/세션/인증 정보를 잃거나 파괴할 위험이 있는 경우
- 공식 기능이 요구 수준에 미치지 못해 제품 경험을 크게 축소해야 하는 경우
- 비용이 큰 외부 실행, 파괴적 명령, 실제 외부 배포·보안 설정 변경이 필요한 경우

**실행 순서:** Phase 0 현행 파악 → Phase 1 핵심 기술 검증 → 검증 게이트 및 상세 설계 결정 → Phase 2 공통 기반 구현 → Phase 3 런타임별 통합 → Phase 4 UI/오케스트레이션 → Phase 5 E2E/수동 테스트 및 실사용 준비. 독립 검증은 병렬 진행하고, 검증을 통과한 모듈은 다른 미검증 작업이 진행 중이어도 구현할 수 있다. 단, 관련 기술 가정이 확인되기 전에는 프로덕션 연동을 확정하지 않는다.

**개발 시 가장 경계할 실패는 '작업 실패'보다 '사용자 의도와 다른 방식으로 성공적으로 만들어 버리는 일'이다.** 사용자 승인 없이 제품 목표를 바꾸거나 미지원 기능을 그럴듯한 유사 UI로 대체하지 않는다.

---

## 1. 배경 · 현재 구조 (사용자 제공 사실)

### 1.1 기존 세 구성요소

1. **Gateway**: 네트워크 계층. 패스키 인증 후 연결된 앱에 접근하도록 한다. Naru는 대표적인 Gateway 연결 앱이다.
2. **Naru**: Codex CLI 및 Claude Code TUI 화면 제공. Hook으로 상태 변경을 감지하고 사용자에게 알림. 프로젝트·워크플로 단위 TUI 목록과 화면 구성을 관리. **현재 Naru에 Builder/Helper UI는 없다.**
3. **DurableSession**: 하나의 터미널 세션을 다중 Observer가 관찰하고 단일 Controller가 조작하는 도구. 현재 Naru의 모든 터미널과 Codex/Claude TUI는 DurableSession 위에서 돌아간다. 에이전트가 이를 직접 명령 실행 도구로 사용하는 연결은 아직 마련되지 않은 것으로 사용자 설명에 따른다.

**주의: Hello Vibe(구 Buildwhy)는 Naru와 별도 프로젝트다.** 옛 Builder/Helper는 Hello Vibe의 초기 UX였으며 Naru에 재도입하지 않는다.

### 1.2 전환 목적

기존 Naru는 *사용자가 에이전트를 직접 사용하는 인터페이스*였다. 목표 Naru는 **사용자가 없을 때도 메인 오케스트레이터와 프로젝트별 오케스트레이터가 여러 프로젝트를 진행하고, 사용자는 언제든 모든 에이전트의 활동을 관찰·지시·개입할 수 있는 Agent Platform**이다.

- 프로젝트 하나를 가볍게 자동화하는 MVP보다, **설계 핵심을 빨리 확정하여 집중적으로 구현하고 실제 프로젝트에 투입**하는 것을 지향한다.
- 제품 매니지먼트 판단(계획·작업 배분·검수 필요성·재계획)은 **LLM**이 한다.
- Naru는 LLM이 사용할 상태·도구·이벤트·실행·권한·UI **기반 시설**을 제공한다.
- 관리되지 않는 자동 생성 UI, 비공식 API 우회, 과잉 리팩터링은 금지한다.

## 2. 비협상 원칙 / 설계 불변 조건

**INV-01 — 의도 정합성:** 모든 위임에는 유효한 **원본 사용자 지시**(변경 불가 원문 및 ID), 이후 사용자가 수정한 지시, **위임한 에이전트 ID**, 위임 내용, 유효한 Intent Contract를 연결한다. 에이전트의 재해석은 원본을 대체할 수 없다.

**INV-02 — LLM 중심 판단:** Naru에 특정 업무의 제품 판단·역할 흐름을 고정하지 않는다. 영속화, 라우팅, 알림, 재시도 한도, 권한, 동시성, 감사 로그 등 **안전·인프라 정책**만 코드로 강제한다.

**INV-03 — 전면 관찰:** Naru가 관리하는 모든 상위 에이전트·작업자에 DurableSession 연결 식별자 또는 명시적인 관찰용 Bridge를 부여하여 사용자가 해당 실행에 접근할 수 있어야 한다. **Native Subagent가 실제 독립 PTY를 지원하지 않는 경우 실제 PTY Attach라고 주장하지 않고 이벤트/Transcript 기반 관찰임을 표시**한다. 관찰이 충분하지 않으면 Naru Managed Subagent로 위임한다.

**INV-04 — Native 도구 자유:** 에이전트의 일반 Bash/파일 도구 실행은 기본적으로 유지한다. 비밀번호 입력, 상호작용형 CLI, 사용자 확인용 `npm run dev` 같은 공유·지속 프로세스는 DurableSession에서 실행하도록 권장/도구 제공/가이드한다. **모든 셸 명령을 PTY로 강제하지 않는다.**

**INV-05 — 세션당 단일 Writer:** GUI와 TUI의 **동시 관찰**은 허용할 수 있어도 동일 에이전트 대화에 대한 무분별한 동시 Write는 금지한다. 모드 전환은 안전한 소유권 이전·Resume·확인·롤백을 갖춘다.

**INV-06 — Human Handoff는 전체 정지가 아님:** 중요한 승인·Manual Test·터미널 입력이 필요한 작업/의존 작업만 보류하고, 독립적인 다른 작업을 계속한다. 사용자에게 질문을 던지기 전에 추천·근거·대안·테스트 환경·남은 할 일까지 준비한다.

**INV-07 — 실행 복구:** Naru·Gateway·DurableSession 또는 개별 에이전트가 재시작돼도 중복 위임·중복 명령·유실된 사용자 결정을 발생시키지 않도록 이벤트/상태/실행 ID를 지속 기록하고 reconcile한다.

**INV-08 — 직접 개입:** 사용자는 글로벌·프로젝트·작업자 에이전트 어디에든 지시·조회할 수 있다. 적용 범위를 기록하고, 최신의 **유효한 사용자 지시**가 해당 범위의 에이전트 지시보다 우선한다.

**INV-09 — 안전한 통합:** 에이전트 간 공유 파일·브랜치·Worktree 충돌을 예방한다. 검수와 승인 게이트 없이 메인 브랜치 반영·외부 배포 등 비가역적 변경을 하지 않는다.

**INV-10 — 기존 동작 보존:** 기존 Gateway 패스키 접근, 기존 Naru 프로젝트/워크플로 화면, 알림 Hook, DurableSession TUI 관찰/제어가 회귀 테스트를 통과해야 한다.

---

## 3. 목표 논리 아키텍처

```text
사용자 (웹/모바일)
       │
  Gateway: 패스키 인증 / 앱 접근 제어 / 역방향 라우팅
       │
  Naru Web UI
    ├── Home: 전 프로젝트 관제 + Main Orchestrator Chat
    ├── Project: 작업 그래프 + Project Orchestrator Chat
    ├── Agent Panel: Structured Chat / TUI / Activity Timeline
    ├── Inbox: Decision / Manual Test / Terminal Control
    └── Sessions & Shared Processes: 기존 TUI + 관찰/제어
       │
  Naru Core API ────────────────────────── Agent-facing MCP / CLI / Skills
    ├── Project / Plan / Task / Intent / Instruction Store
    ├── Event Store / Wakeup / Reconciler / Notification
    ├── Agent Runtime Bridge (Codex/Claude/OpenCode)
    ├── Handoff & Policy / Audit / Security
    ├── Managed Agent Delegation / Artifact / Worktree
    └── Orchestrator Invocation (LLM 실행 트리거; 판단 로직 아님)
       │
  Orchestrator Agents (LLM 세션)
    Main Orchestrator ── Project Orchestrator (각 프로젝트별)
                                      ├── Native subagents (우선)
                                      ├── Managed workers (대안)
                                      ├── Reviewers / Specialists
                                      └── 외부 OmO 등 복합 작업 런타임
       │
  DurableSession: 실행/PTY/관찰/단일 제어권/Control Lease
       ├── CLI 에이전트 TUI
       ├── SDK 실행 프로세스 및 관찰용 이벤트 콘솔
       └── Interactive/Shared Processes (예: dev server, ansible)
```

**책임 경계:**

- **Gateway**: 네트워크/인증/앱 라우팅 및 검증된 접근 주체. 오케스트레이션 판단 금지.
- **Naru Core**: 프로젝트·작업·실행 상태, 세션 매핑, LLM 호출 트리거, 권한, 이벤트 및 감사 기록. 업무 판단 금지.
- **Orchestrator LLM**: 실행 계획, 우선순위, 위임, 검수 판단, 재계획, 계속할 작업 선택, 사용자 질문 생성.
- **Agent Runtime Bridge**: 런타임별 세션 생성/재개/턴/이벤트/승인/자식 추적/중단/입력 제공 등 차이 흡수.
- **DurableSession**: PTY·프로세스 생명주기, 관찰자/제어권/스트림, 공유 대화형 프로세스. 프로젝트 의미 지식 보유하지 않음.

### 3.1 두 층의 오케스트레이터

**Main Orchestrator** (전역 1개 논리 역할): 프로젝트 현황 종합, 목표·우선순위·리소스 상충 해결, 프로젝트별 목표 전달, 전체 Inbox 요약. 개별 작업 코드의 모든 세부 사항을 장기 컨텍스트로 끌어오지 않는다.

**Project Orchestrator** (프로젝트별 논리 역할): 프로젝트 목표/Intent Contract를 유지하고, 계획 작성·작업 의존성·작업자 위임·아키텍처 정합성 검토·수동 검증 요청·후속 작업 진행을 관리한다.

**Worker / Reviewer / Specialist**: 독립 Task 또는 명시적 자문 수행, 산출물과 근거 제출. 리뷰 모델은 작업자가 쓴 요약만이 아닌 원본 사용자 지시·승인된 아키텍처·diff도 받는다.

메인과 프로젝트 오케스트레이터 간 메시지는 Naru의 관리 가능한 Task/Instruction 기록으로 추적한다. 사용자 직접 지시는 해당 범위 상태를 변경하며 다른 영향을 받는 계층에 이벤트를 발생시킨다. **메인 오케스트레이터가 모든 프로젝트의 단일 병목이 되어서는 안 된다.**

### 3.2 모델 정책 (초기 가설, 하드코딩 금지)

| 역할                            | 초기 후보        | 정책                                       |
| ------------------------------- | ---------------- | ------------------------------------------ |
| Main Orchestrator               | Sol              | 이벤트 위주 호출, 상태 요약 기반           |
| Project Orchestrator            | Sol              | 일관성/비용 측정 후 Opus와 비교            |
| 초기 계획·세부 설계             | Opus             | 필요 시 Astra/Fable 별도 의견              |
| 일반 구현·실무                  | Opus             | 주력 Worker                                |
| 독립 코드·의도 정합성 검토      | Sol              | 별도 실행 문맥 / 근거 요구                 |
| 복잡한 기술 판단·난제 원인 분석 | Astra            | 단순 재시도보다 진단 목적                  |
| 중요 결정 시 별도 대안 평가     | Fable 또는 Astra | 옵션. 실제 이용 가능 모델명/호출 방식 확인 |

이름은 **역할 별 설정값**이며 실제 설치·구독·CLI/SDK에서의 모델 ID, 비용, 제한 및 호환성은 Phase 1에 검증한다. 실패할 때 무조건 비싼 모델로 승격하는 규칙을 만들지 않는다. 품질·사용량·응답 안정성 측정으로 조정한다.

---

## 4. Project State · 원본 지시 추적 · Intent Contract

### 4.1 최소 도메인 데이터

- `Project`: ID, 이름, repo/workspaces, 활성 목표, 상태, 우선순위, 상위 설정.
- `Instruction`: 변경 불가능한 원문, 발화자(`human` 또는 agent ID), origin_user_instruction_id, 범위, 시각, supersedes/overrides 관계.
- `IntentContract`: 승인된 핵심 원칙, 허용되는 기술 선택, 금지/승인 필요 경로, 버전, 승인 근거.
- `Plan`: 버전, 담당 오케스트레이터, 작업 DAG, 검토 상태, 승인 근거.
- `Task`: 목적, 완료 조건, 종속성, 주체, 유효 Instruction/Intent/Plan 버전, 우선순위/상태.
- `Run`: Task 실행 시도, 런타임/모델, 상태, 산출물, 오류 분류, 비용/소요 정보, 재시도 기록.
- `AgentSession`: 런타임 고유 ID, 부모/자식 관계, GUI/TUI writer, 모드·연결 상태, 제어 소유권.
- `TerminalSession`: DurableSession ID, PTY 여부, 현재 Controller/Observer, 마스킹 상태.
- `Handoff`: 종류, 필요 사용자 행동, 추천안/대안, blocking scope, 해결/재개 이벤트.
- `Artifact`: 변경 파일, diff/커밋, 문서, 테스트 증빙, 실행 화면, 리포트.
- `Event`: 이벤트 ID, 발생 주체, 대상, 상관관계 ID, 시각, 전달/처리 상태, idempotency key.
- `SharedProcess`: 프로젝트/Task/Agent 매핑, 명령, DurableSession ID, 종료 정책, health/status/URL.

**중요 분리:** `Task != Run != AgentSession != TerminalSession`. 한 Task는 다수 Run/세션을 가질 수 있고, 한 AgentSession에서 하위 에이전트/터미널이 생성될 수 있다.

### 4.2 위임 메시지 (개념적 Envelope)

```yaml
instruction_envelope:
  task_id: task-123
  project_id: hello-vibe
  origin_user_instruction:
    id: instr-user-17
    verbatim: "Kiro의 기존 에이전트 시스템에 Hook/MCP로 가이드를 연결해 줘."
  latest_applicable_user_overrides: []
  delegation:
    from_agent_id: project-orchestrator-hello-vibe
    to_agent_id: worker-opus-3
    verbatim: "Kiro의 공식 확장 지점을 검증하고 통합 계획을 제안하라."
  intent_contract_id: intent-hv-2
  plan_version: 3
  success_criteria:
    - "기존 Kiro 에이전트 시스템 유지"
    - "공식 확장 지점 우선"
  require_approval_if:
    - "대체 에이전트 UI 자체 구현"
    - "비공식/역공학 API 도입"
```

**원칙:** 하위 에이전트마다 전체 무관한 사용자의 개인정보와 모든 과거 대화를 복사하지 않는다. 해당 작업에 **실제로 적용되는 원본 지시·후속 수정·계약**을 최소 권한 범위로 전달하고, 전체 감사 기록은 Naru가 참조한다. 최신 유효한 사용자의 수정 지시가 기존 지시보다 우선하며, 동일 사용자의 충돌 지시는 추측으로 해결하지 말고 필요한 경우 질문한다.

### 4.3 설계 이탈(Design Deviation) 방지

**핵심 실사례:** Hello Vibe/Buildwhy의 Kiro 통합에서 사용자는 Kiro **기존 에이전트**에 Hook/MCP로 가이드를 붙이는 방식을 원했다. 구현 에이전트가 명세의 “확장 프로그램으로 구현”을 **확장 프로그램 내 별도 에이전트 UI 재구현**으로 해석하고 비공식 API 의존을 만들어 버그와 원치 않는 UX를 초래했다.

따라서 검수는 **기능 정상 동작(Correctness)**뿐 아니라 **의도 정합성(Intent Alignment)**을 독립적으로 평가한다.

- 작업 전: 중요 아키텍처 선택은 승인된 Contract와 대조. Reviewer가 원본 사용자 요구와 접근 방법을 직접 확인.
- 작업 중: 기존 설계의 우회, 별도 시스템 재구현, 비공식 API, 유지보수 비용 급증, 요구 축소를 발견하면 `propose_design_change`로 보고. 관련 변경은 보류하고 다른 독립 작업은 진행.
- 작업 후: 코드·diff·테스트·UX를 Contract와 대조. 사용자 Manual Test가 필요한 마일스톤은 사용자에게 실제 테스트 방법과 준비된 서버/화면을 제시.
- **단순 복잡성 증가만으로 중단하지 않음**. 승인된 설계 안에서 복잡한 문제는 에이전트가 해결; 사용자의 본질적 의도를 바꾸는 쉬운 편법은 사전 승인 필요.

---

## 5. Event-driven 상시 운영

Naru 데몬/서버가 계속 실행되고 LLM은 **이벤트가 있을 때 Turn 단위로 호출**한다. 하나의 LLM 프로세스를 24시간 바쁘게 유지하지 않는다.

**입력 이벤트 예:** Hook status 변화, Task/Run 완료, Reviewer 결과, Human 응답, Manual Test 결과, SharedProcess 비정상 종료, 사용자 신규 지시, 재시작 복구, 선택적 Heartbeat.

**실행 흐름:** 수신 → DB 기록/중복 제거 → 프로젝트 대상 확인 → 현재 처리 중인 오케스트레이터 Turn과 큐 합치기 → 최신 상태 조회 → LLM의 Naru Tool 호출 → 상태 커밋 및 대기.

**구현 요구:**

- Event Store + 최소한의 outbox/inbox·idempotency. Hook 중복/역순/누락 대응, 실행 종료 이벤트 유실 시 reconcile.
- 동일 논리 오케스트레이터에 동시 모순 판단 방지(lease/mutex와 revision check). 전역이 모든 프로젝트를 직렬화하지는 않음.
- 승인/대기 중인 Task와 독립 Task 분리. 모든 Task가 막히면 Inbox/상태 요약, 반복 질문 금지.
- watchdog / heartbeat는 LLM 호출 없는 상태 점검 우선. 프로세스 생존, 장기 작업 health, 정지된 이벤트 처리 확인.
- 한도: 동시 실행 수, 호출 횟수, 반복 재계획, 통지 빈도, 예산·rate limit. 무한 루프/에이전트끼리 무한 메시지 차단.
- Run 중단/재개 후 중복 실행, 사용자 답변의 중복 소비를 테스트.

---

## 6. DurableSession 활용·확장

### 6.1 원래 목적 유지

- **모든 관리 대상 에이전트**에 실제 DurableSession PTY 또는 **DurableSession에 연결되는 관찰용 Bridge**를 연결한다. 실제 독립 PTY가 없는 Native Subagent는 `OBSERVED_TRANSCRIPT`처럼 명확히 구분.
- 기존 단일 Controller / 다중 Observer 구조 유지.
- 일반 Native Bash는 허용. 별도 상호작용·공유 관찰·지속성이 필요한 명령만 `durable.exec/start_shared_process` 사용 유도.
- SDK/App Server의 JSON-RPC/이벤트 제어 채널을 PTY로 무조건 리다이렉트하지 않는다. Protocol channel과 사용자 관찰용 console을 구분한다.

### 6.2 기존 구현 먼저 감사할 항목

`attach`, Observer 연결, Control 요청·회수·반납, 제어권 이후 Stream 입력, 실행 출력 읽기, PTY resize, session persistence/reconnect, 복수 클라이언트, process detach, controller lease/timeout, secret input/log policy. **실제 API 명세를 보지 않고 이미 있다고 가정하지 말 것.**

### 6.3 실제 작업 흐름

1. 에이전트가 Ansible을 **공유 PTY**에서 실행.
2. SSH 비밀번호 같은 상호작용 입력이 필요해지면 에이전트가 `Terminal Control` Handoff 요청/제어권 반환.
3. 사용자가 Naru에서 Observer → Controller가 되어 입력.
4. 사용자가 제어권을 반납하면 에이전트가 다시 획득, 결과를 확인하고 작업 이어감.

또한 `npm run dev` 같은 개발 서버는 Run/Turn이 끝나도 필요 시 계속 살아 있는 **SharedProcess**로 둔다. Naru는 실행한 에이전트, 프로젝트, 로그, 상태/URL/포트, 종료/재시작 정책을 자동 연결한다. Gateway 경유 미리보기는 기존 인증·권한을 거친 경우에만 노출한다.

### 6.4 비밀정보 보호 TODO

SSH가 TTY echo를 끄더라도 **stdin 바이트 로그, 프록시 스트림, Hook 이벤트, Observer 재전송, 녹화 기록**까지 안전하다는 뜻은 아니다. 실제 레코딩·전달 경로를 감사하고 필요하면 secure input/redaction을 추가한다. 비밀번호를 LLM 대화로 넘기지 않는다. 가능하면 SSH Agent 등 비대화식 인증을 우선한다.

### 6.5 제어권 Lease

Controller identity + monotonic fencing token + lease/heartbeat + request/release/timeout/reclaim. 이전 Controller의 늦은 입력 차단, 권한 없는 Observer write 차단, 연결 끊김 시 안전한 회수, 사용자 강제 회수 감사 로그.

---

## 7. Agent Runtime Bridge · GUI/TUI

### 7.1 런타임

- Codex CLI/TUI / Codex App Server(또는 현재 공식 SDK)
- Claude Code CLI/TUI / Claude Agent SDK
- OpenCode Server/SDK/TUI, 선택적 Oh My OpenCode(OmO)

모든 런타임이 동일한 기능을 제공한다고 가정하지 않는다. **Capability Matrix**를 실제 설치 버전으로 생성한다.

### 7.2 GUI/Chat 및 TUI 화면

에이전트 패널의 탭: `Chat(구조화된 SDK 이벤트·메시지·도구) | TUI(실제 DurableSession 터미널, 가능할 때) | Activity(작업·자식·diff·리뷰·의도 결정)`.

- **표시 모드 전환**과 **실행 주체/Writer 전환**을 반드시 구분한다.
- 공유 백엔드에서 두 UI를 동시에 연결하고 단일 writer를 강제할 수 있는지 실험.
- 불가능하면 안전한 **Stop/Release → Resume/Acquire** 방식.
- 기존 TUI에 해당 세션의 실제 live attach가 안 되면 지원 불가로 표시; 로그로 모조 TUI를 만들어 동일한 기능인 척하지 않음.

**상태 머신 예시:** `GUI_ACTIVE → SWITCH_REQUESTED → QUIESCING → WRITER_RELEASED → TUI_RESUMING → TUI_ACTIVE`, 역방향 포함; 모든 실패 경로에 `ROLLBACK / RECOVERY_REQUIRED` 상태.

**불변 조건:** 동시에 두 writer 실행 금지, 응답 중 무단 강제 kill 금지, 안전한 Turn 완료 또는 명시적 interrupt, 원본 세션 식별자·이력 보존, Resume 확인 후 신규 메시지 허용, 실패 시 기록 보존·명시적 복구 경로.

**Codex 관련 사용자 사전 검증 기록:** 예전에는 GUI와 TUI의 서로 다른 App Server 사이에 동일 세션의 동시 writer가 불가능하다고 확인. 이번에는 (A) Shared App Server+단일 writer와 (B) Stop & Resume를 **모두 실제로 검증**할 것. 과거 조사만으로 현재 지원 상태를 확정하지 말 것.

**개발 담당 선호:** Codex 구현·검증은 **Sol**, Claude 구현·검증은 **Opus**. 각자의 native 인터페이스를 잘 다루게 하되, 공통 타입/수용 테스트 계약은 통일.

### 7.3 어댑터 인터페이스 (개념, 설계 확정 전 변경 가능)

```typescript
interface AgentRuntimeAdapter {
  capabilities(): Promise<RuntimeCapabilities>;
  start(spec: AgentLaunchSpec): Promise<AgentSessionRef>;
  observe(sessionId: string): AsyncIterable<AgentEvent>;
  send(sessionId: string, instruction: InstructionEnvelope): Promise<SendResult>;
  requestApproval(sessionId: string, decision: ApprovalResponse): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  resume(sessionId: string, mode: "gui" | "tui"): Promise<ResumeResult>;
  listChildren(sessionId: string): Promise<ChildAgentRef[]>;
}
interface RuntimeCapabilities {
  structuredChat: boolean;
  realTui: boolean;
  liveTuiAttach: boolean;
  safeGuiTuiTransition: boolean;
  nativeSubagentTrace: "none" | "lifecycle" | "transcript" | "interactive" | "pty";
  nativeCrossSessionMessaging: boolean;
  externalApprovalControl: boolean;
  canBridgeToDurableSession: boolean;
}
```

필드명과 타입은 코드베이스를 본 후 결정. 실제 지원 범위는 `false/none`으로 보수적으로 시작하고 검증 후 활성화한다.

---

## 8. Native Subagent / Agent Teams / 세션 간 Handoff

### 8.1 기본 정책: Native 우선

- 에이전트는 평상시 **native subagent**를 사용한다.
- Phase 1에서 생성/중단/상태/실시간 Transcript/도구 호출/하위 ID/부모 관계/중간 직접 개입/실제 PTY Attach 지원을 **개별 테스트**한다.
- 관찰 수준 구분: `L1 lifecycle` / `L2 transcript` / `L3 interactive message` / `L4 PTY controller`.
- L4가 불가능하더라도 L2~L3로 제품 목표를 충족하는지 명시 평가. 사용자에게 실시간 내용 관찰이 안 되는 경우 Naru Managed로 우회.
- Native가 핵심 요구를 충족하지 못하면, Naru `delegate_task`/`spawn_managed_agent`를 통한 **Naru Managed Subagent**를 권고하도록 Skills/프롬프트에 반영. 가능한 환경에서는 정책에 따라 native 사용을 제한하는 방법도 검증.

### 8.2 Claude 고유 기능

Claude Native Subagent, Agent Teams, 세션 간 메시징(`ListAgents`/`SendMessage`)을 **서로 별도의 기능**으로 검증한다. 현재 문서에는 Native Subagent 이벤트의 `parent_tool_use_id` 등과, Cross-session Messaging의 설정/차단 방법이 설명되어 있지만 **Naru에서 전체 메시지를 실시간 감청·정책 통제할 수 있다는 보장은 없다.**

- Claude→Claude는 Native 메시징을 우선 탐색하되, **발신자·수신자·원본 지시 ID·실제 지시·결과·Task**를 Naru에서 검증 가능하게 기록해야 한다.
- Native 메시지가 Naru를 우회하여 중요한 작업을 생성할 수 있다면 통합 가시성/통제 기준 미달. Hook으로 신뢰성 있는 audit/hold가 가능한지 테스트.
- 불가능하다면 Naru MCP/CLI를 통한 관리형 통신을 기본값으로 하고 Native cross-session은 제한. 단, **`SendMessage` 전면 차단은 서브에이전트/팀 내부 메시징까지 차단할 수 있음**에 주의하여 범위별 차단 가능한지 확인.
- Agent Teams는 실험적·실행 모드별 제약 검증 후 **하위 작업 선택 기능**으로만 사용. Naru Main/Project Orchestrator의 기반 기술로 의존하지 않음.

### 8.3 Codex 및 크로스 런타임

Codex→Codex Native Handoff/서브에이전트 추적은 Sol 검증 후 결정. Codex↔Claude와 서로 다른 런타임 간 통신은 **Naru-managed Instruction/Task 경로**를 기본으로 한다. 모든 위임에는 사용자 원본 지시와 발신 에이전트 정보가 전달되어야 한다.

### 8.4 OmO

**선택적 복합 작업 백엔드**로서 OpenCode/OmO를 조사한다. 메인·프로젝트 오케스트레이터의 판단을 OmO 내부에 종속시키지 않는다. OpenCode 서버/SDK/TUI 연결은 공식 문서로 출발점을 삼되, **OmO 내부 Subagent/Hook/이벤트 가시성은 별도 재현 테스트** 대상. `opencode-web`만 사용한 기존 체험은 전체 기능 검증으로 간주하지 않는다.

---

## 9. Human Handoff · Manual Validation · 의도 이탈

### 9.1 분류

| 종류                   | 발생 사례                                         | 기본 처분                                           |
| ---------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `DESIGN_DEVIATION`     | 의도하지 않은 대체 UI, 비공식 API, 원래 설계 교체 | 해당 구현/통합 보류, 대안·추천·근거 제시, 승인 대기 |
| `PRODUCT_DECISION`     | 실제 사용자 선호·우선순위 필요                    | 선택지/트레이드오프/추천안 제시                     |
| `MANUAL_TEST`          | 기능은 되지만 UX·실사용 흐름 검증 필요            | dev server/테스트 계정/절차 준비해 사용자 호출      |
| `TERMINAL_CONTROL`     | SSH 비밀번호, 대화형 프로그램 입력                | DurableSession 제어권 이양 및 안전한 재개           |
| `SECURITY_OR_EXTERNAL` | 파괴적 변경·배포·비용·권한 확장                   | 명시적 승인 없이는 실행 금지                        |

### 9.2 질문의 품질

Handoff Payload에는 `reason`, `blocking_task_ids`, `independent_work_to_continue`, `options`, `recommendation`, `risks`, `prepared_environment`, `resume_condition` 필수. 단순 “어떻게 할까요?” 금지. 알림 과다 방지: 연관된 질문은 가능한 범위에서 묶되 긴급/보안 경고는 우선.

### 9.3 승인 경계

설계 이탈이 탐지되면 변경 제안 기록 + 해당 작업/관련 merge gate 차단, 독립 작업은 계속. 도구 호출이 의미적으로 문제인지 100% 자동 판별 가능하다고 가정하지 않는다. **Reviewer의 의도 검사 + 고위험 API/배포/민감 데이터 정책 + 사용자 Manual Test + Worktree/Merge Gate**를 병행한다.

---

## 10. 웹 UI 및 사용자 경험

### 화면 IA

1. **Home**: 전체 프로젝트 상태, Main Orchestrator 대화, 실행 중인 작업, 최근 성과, 결정 대기 건수, 리소스 사용.
2. **Project**: Project Orchestrator 직접 대화, 원본 목표·Intent Contract·계획 버전, Task 의존성 DAG, 에이전트/실행/산출물, 사용자 개입.
3. **Agent Panel**: `Chat / TUI / Activity`, 실제 모드 지원 여부/현재 writer 표기, Native Subagent 트리, child transcript/PTY, 실행 취소/중단/재개.
4. **Inbox**: `Decision / Manual Test / Terminal Control`, 추천안과 남은 할 일, 보류 범위, 재개 상태.
5. **Sessions / Processes**: 기존 프로젝트/워크플로별 TUI 목록 유지, 공유 개발 서버/상호작용 프로세스, controller/observer 표시, logs/health.

**핵심 UX:** 각 Task 노드에 Worker/Reviewer, Run 및 Live Status, Dependency, parent-child relation, Tool Events, diff, 테스트 결과, 현재 Human Handoff와 선택 가능한 조치를 표기. 사용자는 어느 계층이든 원하는 Agent를 클릭해 지시할 수 있다.

**처음 구현의 미관보다** 원본 지시·이벤트·DAG·세션/부모 관계 등 **정확한 데이터 기반**을 우선한다. 다만 “대시보드처럼 보이는 스크린샷”만으로 완료 처리 금지: 모든 조작은 실제 Naru Core와 연결되어야 한다.

---

## 11. Agent-facing MCP / CLI / Skills / Plugins

동일한 **Naru Core API**를 Web UI, MCP, CLI가 사용하게 한다. 정책 우회용 별도 DB write 통로를 만들지 않는다. Skills는 행위 지침/도구 사용 가이드이며 승인이나 접근 통제의 강제 장치는 서버에 둔다.

**후보 툴** (실제 네이밍은 코드 분석 후 확정):

```text
naru.get_global_state
naru.get_project_state
naru.get_applicable_user_instructions
naru.create_or_update_plan
naru.delegate_task
naru.spawn_managed_agent
naru.inspect_run
naru.request_review
naru.propose_design_change
naru.request_human_handoff
naru.record_human_resolution
naru.get_handoff_status
naru.register_shared_process
naru.get_session_observation
naru.request_terminal_control
naru.publish_artifact
naru.report_progress
```

- **행위자/권한 증명:** 에이전트가 발신자 ID를 임의 문자열로 주장하는 방식을 신뢰하지 않는다. 인증 토큰/서버가 부여한 세션 신원과 발신자 정보를 바인딩한다.
- 명령 실행/위임/승인마다 `project_id`, `actor_id`, `origin_instruction_id`, `task_id`, `trace_id`, `idempotency_key`를 기록.
- 토큰 최소 권한, 프로젝트 범위 분리, 사용자 원문 중 불필요한 민감 데이터 노출 제한.
- Skills에 _Native 우선 → 관찰/통제 부족 시 Managed_, 사용자 지시 우선, 설계 이탈 사전 승인, Shared Process 사용 시점, 동작 중 질문 품질을 명시.
- 외부 Plugins 및 OmO는 선택적 연결점으로 두고 코어 종속성을 추가하지 않는다.

---

## 12. 안전성 · 안정성 · 작업 격리

- **기존 Gateway 패스키 권한 유지:** Browser/UI 권한을 에이전트 토큰 권한과 분리하고, 외부에서 Core API/MCP/서버 포트를 임의로 접근하지 못하게 함.
- **Worktree per Worker**를 기본 권장. Project Orchestrator가 파일 충돌/동시 변경/merge 정책 관리. 공유 브랜치에 두 Worker가 동시에 무제한 쓰기 금지.
- 명령·위임·승인에 timeout/retry 제한, 비용·동시성 한도, 취소/중단/회복 경로.
- native messaging은 관찰 및 권한 정책을 우회하지 못해야 함. 관찰 못 하는 경우 Capability를 낮춰 표시.
- App Server/SDK 이벤트를 외부 사용자에게 표시할 때 토큰, 환경변수, 비밀 입력, 자격증명을 마스킹하고 감사.
- 코드 검수는 성공 테스트뿐 아니라 아키텍처·비공식 API·의존성·권한 변경을 점검.
- 서버 재시작/네트워크 중단 후 reconcile에서 Run이 `unknown`이면 성공/실패를 지어내지 말고 실제 런타임을 조회.

---

## 13. Phase 0 — 현행 저장소 실사 (구현 전에 필수)

먼저 실제 코드와 배포 환경을 조사하여 `docs/naru-vnext/00-repo-audit.md` 작성.

**점검 사항:**

- Gateway/Naru/DurableSession 세 repo(모노레포인지 등) 위치·브랜치·버전·테스트·빌드·배포 방식
- 이미 구현된 gateway 인증·앱 라우팅, 터미널 attach/control/stream 및 Hook/알림의 실제 코드 경로
- 기존 프로젝트/워크플로 데이터, 세션 식별자·마이그레이션 전략, 비밀정보 로깅 경로
- Mac mini 등 실제 호스트 OS·설치된 Codex/Claude/OpenCode/OmO 버전, 활성 인증·모델/요금 정책(비밀값 노출 금지)
- DurableSession의 PTY·프로세스 생명주기·observer/controller·reconnect 구현
- Naru UI 컴포넌트·라우팅·현재 TUI 화면 및 사용자 환경 보존 조건
- 가능하면 기존 예전 GUI/TUI 전환 시도/실험 자료 검색 및 반례 재현

**산출물:** 기능/코드 경로/현재 여부를 `implemented / partial / absent / unclear`로 나눈 표와, 실사에서 드러난 설계 변경 후보 및 위험. 이 단계에서 대규모 리팩터링 금지.

---

## 14. Phase 1 — 필수 기술 검증(Spike) 및 게이트

**검증은 격리된 테스트 프로젝트/브랜치에서 실행하고 로그·재현 명령·설치 버전·실제 결과를 남긴다.** 각 항목은 `PASS / PARTIAL / FAIL / NOT TESTED`, 근거 링크/파일, 정확한 미지원 범위, 안전한 fallback, 사용자 결정 필요 여부를 기록한다. 문서에 적혔다는 것만으로 PASS 아님.

### 14.1 검증 책임 매트릭스

| ID  | 검증 과제                                                   | 권장 담당                    | 필수 증거 / 수용 조건                                           |
| --- | ----------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------- |
| V01 | Codex GUI↔TUI 동일 App Server 공유 및 writer arbitration    | **Sol**                      | 같은 세션 이어받기, 동시 write 차단, 실제 전환 영상/로그        |
| V02 | Codex Stop/Release→TUI Resume→GUI 복귀                      | **Sol**                      | 식별자·대화 보존, 진행 중 Turn 처리, 실패 rollback              |
| V03 | Claude Agent SDK GUI↔CLI/TUI session resume                 | **Opus**                     | 동일 이력 이어받기, 불가능한 live attach 명시, 중복 Turn 방지   |
| V04 | Codex native subagent lifecycle/transcript/interaction/PTY  | **Sol**                      | L1~L4 각각 지원 여부, 부모/자식 ID, 실시간성                    |
| V05 | Claude native subagent lifecycle/transcript/interaction/PTY | **Opus**                     | L1~L4 각각 지원 여부, SDK/Hooks/원문 diff                       |
| V06 | Claude cross-session messaging audit/intercept/block        | **Opus**                     | sender/recipient/content/task trace; 동작·차단 영향 실증        |
| V07 | Claude Agent Teams (interactive vs SDK)                     | **Opus**                     | 실제 실행 가능 모드 및 UI/서브에이전트 제약                     |
| V08 | Codex↔Codex, Codex↔Claude 통신                              | Sol+Opus                     | Native 지원 여부, Naru-managed 경유 시 왕복과 provenance        |
| V09 | DurableSession API/stream/control/attach/lease              | **Opus(코어), Sol 교차검토** | 기존 API 목록 + 자동 제어권 반환/재획득 E2E                     |
| V10 | DurableSession protected input                              | **Opus**                     | 사용자 비밀 입력이 observer/녹화/로그/LLM context에 남는지 실험 |
| V11 | SDK App Server process와 DurableSession 연결                | Sol+Opus                     | protocol intact + 이벤트 콘솔 및 관찰 가능 여부                 |
| V12 | OpenCode/OmO 실제 TUI attach/SDK/child trace                | 담당 지정                    | `opencode-web`만이 아닌 직접 실습, capability 실측              |
| V13 | Gateway 기존 인증 + Naru MCP/agent auth                     | 담당 지정                    | 사용자 vs agent 권한, 내부 서비스 노출/통제                     |
| V14 | Naru 기존 Hook·세션·워크플로 migration                      | 담당 지정                    | 데이터 호환·이중 이벤트 처리 여부                               |

**GUI/TUI의 P0 판정:**

- Shared Backend가 실제로 안전하면 A 방식 채택 가능. 아니라면 Stop & Resume B 방식 채택.
- 두 방식 모두 신뢰성 기준 미달이면 **기존 TUI 보존 + 새 Chat 모드 독립 지원**으로 분리해 제공하고, 진정한 세션 전환은 미지원으로 명시. 모조 전환 구현 금지.

**Native Subagent의 P0 판정:**

- L1~L2 이상에 실제 기록·연관관계 확보되면 Native 유지 후보.
- L3~L4가 요구되는 작업은 가능하면 Naru Managed 사용.
- 자식 작업의 진행 내용 자체를 수집 못 하면 현재 요구 충족 실패. 관리형 위임 및 native 동작 억제 방법 검증.

**Claude Native 메시징 판정:**

- 메시지·지시 원본·책임 주체를 신뢰성 있게 추적하고 위험한 우회를 막을 수 있을 때에만 managed 프로젝트 작업 간 Native를 활성화.
- 막을 때 하위 Subagent/Team 기능의 부작용 파악. 통제 불가 시 Naru-managed 경로 기본.

**Phase 1 gate:** `docs/naru-vnext/01-validation-matrix.md`와 실험 코드/로그 작성. 주요 아키텍처 선택과 fallback을 `02-architecture-decisions.md`에 ADR로 기록. **요구 자체를 축소하거나 비공식 우회가 필요한 경우에만 사용자에게 Design Decision 요청.** 그 외에는 검증 후 자동 구현 진행.

---

## 15. Phase 2~5 — 구현 및 통합

### Phase 2 — 안전한 기반

- 데이터 마이그레이션과 최소 Schema, Event Store·reconciler, Policy/Approval, Core API, Agent Identity, 관측/감사 로깅.
- DurableSession 검증 결과에 따라 부족한 Agent Bridge / SharedProcess / Control Lease 구현.
- 기존 Gateway/Naru/TUI 기능과 통합, 기본 회귀 테스트 자동화.

### Phase 3 — 런타임과 에이전트 계층

- Codex/Sol 담당 부분: App Server/CLI 어댑터, GUI/TUI 안전한 전환, Native child 추적.
- Claude/Opus 담당 부분: Agent SDK/CLI 어댑터, GUI/TUI 전환, Native child/Teams/messaging 정책 및 기록.
- OpenCode/OmO 선택 어댑터: Phase 1 증거에 따라 구현 여부 확정.
- Naru Tools MCP/CLI + Skills, 통일된 InstructionEnvelope/TaskEnvelope, Run/Session 상태 mapping.

### Phase 4 — 두 단계 오케스트레이션과 UX

- Main 및 프로젝트별 오케스트레이터 LLM 호출·대화, 이벤트 기반 wakeup, 비차단 Human Handoff, 리뷰 및 계획 동작.
- 대시보드/Project Graph/Agent Chat·TUI·Activity/Inbox/Shared Processes 화면 실동작 연결.
- Native child 관찰과 Managed fallback, 동일 세션 사용자 직접 지시·writer locking.

### Phase 5 — 통합 검증·실사용 준비

- 시나리오별 자동 E2E + 사용자 수동 테스트 요청(특히 GUI↔TUI, 세션 제어권, 실제 UX).
- 비밀정보·권한·세션 유실·중복 실행·돌발상황에서의 의도 이탈 검수.
- 기존 프로젝트 **하나를 실제로 Naru에 투입**해 계획→병렬 작업→리뷰→사용자 승인→진행 재개를 확인. 실제 서비스 외부 배포/파괴적 변경은 사용자 승인 필요.
- 운영·장애 복구 매뉴얼 및 미지원 기능 목록.

**동시 진행 원칙:** 검증이 통과한 독립 작업은 계속 구현할 수 있다. 사용자의 확인이 필요한 경우 그 작업만 막고 다른 작업을 이어 간다. 특정 마감 시간을 성공 보장으로 약속하지 않는다.

---

## 16. 필수 인수 테스트 (Acceptance Scenarios)

- **A01:** Gateway 패스키 인증 후 기존 Naru 프로젝트/워크플로/TUI 접근과 Hook 알림이 이전과 동일하게 동작한다.
- **A02:** Main Orchestrator에게 두 프로젝트의 목표를 지시하면 각 Project Orchestrator가 별도 계획/작업을 만들고 전역 현황에 반영한다.
- **A03:** 사용자가 프로젝트 오케스트레이터에게 직접 새 지시를 내리면 해당 프로젝트에 적용되고 관련 작업자에게 최신 원본 지시 provenance가 전달된다.
- **A04:** Opus Worker가 Native Subagent를 호출하면 가능한 수준의 별도 실시간 실행/Transcript/부모 관계를 Naru에 표시한다. 지원하지 않는 수준은 숨기지 않고 표시한다.
- **A05:** Native 관찰이 불가능한 조건에서 Naru Managed Subagent가 별도 DurableSession으로 실행되고 사용자가 관찰할 수 있다.
- **A06:** Codex GUI→TUI→GUI 전환에서 writer 충돌 없이 같은 이력과 세션을 이어받거나, 미지원인 경우 안전하게 제한하는 정책이 실제로 작동한다.
- **A07:** Claude Chat GUI↔TUI 전환에서 이력·활성 Turn을 보호하고 실패 시 원상복구한다.
- **A08:** Opus가 `npm run dev`를 SharedProcess로 실행하면 사용자에게 서버와 로그가 보이고 Worker Turn 종료 후에도 정책상 유지할 수 있다.
- **A09:** Ansible/SSH 입력 상황에서 Controller를 사용자에게 넘겼다가 안전하게 에이전트로 반납할 수 있고 비밀정보가 다른 Observer/LLM/로그에 유출되지 않는다.
- **A10:** 중요한 설계 일탈(예: Hook/MCP 대신 비공식 API 기반 대체 UI)을 제안하면 해당 작업이 승인 대기하고, 독립 작업은 계속 진행된다.
- **A11:** Worker 결과가 테스트 통과해도 Reviewer가 원본 의도 위반을 지적하면 merge/승인 게이트를 통과하지 않는다.
- **A12:** Claude→Claude Native 메시지의 추적 가능성을 검증하며, 부족하면 Naru-managed 전송이 사용되고 책임·원본 지시가 기록된다.
- **A13:** Naru Core 또는 에이전트 실행 프로세스가 종료·재시작된 뒤 Task/Run 상태를 복구하고 중복 작업·중복 결정을 만들지 않는다.
- **A14:** 승인 Inbox에서 Manual Test 요청을 열면 실제 접근할 수 있는 테스트 환경, 확인 절차, 예상 결과가 포함되고 승인/거절 후 필요한 Task만 재개한다.
- **A15:** 동시에 다른 Worktree에서 작업한 결과를 사용자 의도와 검수 정책에 따라 충돌 없이 통합한다.
- **A16:** 지원하지 않는 모델·API·Native 기능을 '지원'으로 보고하거나 외부 비공식 API를 조용히 도입하지 않는다.

테스트마다 **단계, 예상 상태, 실제 상태, 링크/로그, 실패 원인, 남은 작업**을 보고한다. Naru 기능 실제 E2E가 없는 UI 목업만으로 완료하지 않는다.

---

## 17. 산출물 · 보고 형식

다음 문서/산출물을 Naru 저장소에 사용자 기존 문서 관례에 맞춰 생성한다(디렉터리는 기존 관례가 있으면 조정):

```text
docs/naru-vnext/
  00-repo-audit.md                # 코드·환경·기존 기능의 실사
  01-validation-matrix.md         # V01~V14 PASS/PARTIAL/FAIL + 증거
  02-architecture-decisions.md    # ADR; 제약·대안·선정 근거
  03-implementation-plan.md       # 실제 코드 위치·의존성·단계·담당
  04-test-plan-and-results.md     # A01~A16 결과 + 증거
  05-operations.md                # 기동·복구·중단·안전한 업그레이드
  06-known-limitations.md         # 지원 안되는 기능·작동 전제
```

필요한 코드, 자동화 테스트, 타입/스키마, API 문서, 런타임 capabilities도 함께 남긴다.

**보고 포맷:**

1. 지금 검증/구현한 것 및 증거
2. 통과한 요구와 미통과 요구
3. 기존 사용자 의도에서 달라지는 제안 (있다면 사전 승인)
4. 사용자 Manual Test가 필요한 지점과 즉시 실행 가능한 절차
5. 관련 없는 나머지 작업의 계속 진행 현황

`검증 미완료`, `지원 범위 축소`, `부분 관찰`, `가정`, `선택한 fallback`은 명시해야 한다. 성공을 꾸며 내지 않는다.

---

## 18. 우선순위 · 의사결정 구분

**설계상 확정:** 기존 Gateway/Naru/DurableSession 보존; Naru Core + LLM 오케스트레이터 경계; 메인·프로젝트 계층; 원본 지시 보존; Native 우선/Managed fallback; 일반 Bash 허용/공유 PTY 권장; Event-driven wakeup; Human Handoff; 사용자 직접 지시; 단일 writer; UI 신규 화면; 비공식 설계 우회 사전 승인.

**검증 후 채택:** Codex/Claude GUI↔TUI의 구체 전환 프로토콜; Native subagent의 L3/L4 가능 여부; Claude messaging intercept/차단 범위; OmO 내부 child telemetry; DurableSession 기존 구현 API 및 secret input; 실제 모델/SDK 호출 가능성; OpenCode 어댑터의 세부 투자 우선순위.

**사용자 승인 필요:** 본질적 UX 변경, 아키텍처 핵심 대체, 비공식 API 필수화, 원본 지시 해석 충돌, 프로덕션 배포/민감 인증 위험. **일반 구현 디테일·파일 분리·테스트 구성 등은 사용자 질문 없이 자율적으로 진행.**

---

## 19. 신뢰할 수 있는 공식 출발 문서 (2026-10-15 확인; 설치 버전 재검증 필수)

아래는 기술 검증의 출발점이지, Naru와의 통합이 이미 확인됐다는 뜻은 아니다.

- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- Claude Agent SDK 개요: https://code.claude.com/docs/en/agent-sdk/overview
- Claude SDK Subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- Claude Hooks: https://code.claude.com/docs/en/hooks
- Claude Cross-session Messaging: https://code.claude.com/docs/en/cross-session-messaging
- Claude Agent Teams: https://code.claude.com/docs/en/agent-teams
- OpenCode Server: https://opencode.ai/docs/server/
- OpenCode SDK: https://opencode.ai/docs/sdk/
- OpenCode CLI Attach: https://opencode.ai/docs/cli/

---

## 20. 구현 담당 Claude의 최종 작업 지침

이 문서로 **검증부터 실제 구현까지** 진행하라. 사용자에게 진행 과정 전체를 매번 다시 묻지 말고, 확정된 부분은 실행한다. **다른 런타임의 전문 작업은 위임**한다: Codex GUI/TUI 및 Codex native 관련은 Sol, Claude SDK/CLI 및 Claude native 관련은 Opus를 우선 활용한다. 공통 API/보안/데이터 설계는 전체 기준으로 통합한다.

**완성 기준**은 '문서가 작성됐다'가 아니라 실제 Naru UI에서 메인·프로젝트 오케스트레이터와 작업자를 실행하고, 원본 지시/태스크/자식 관찰/인간 개입을 확인하고, 장기 프로세스와 기존 TUI가 보존된 것을 검증하는 것이다.

실제 코드와 공식 인터페이스가 여기의 가정과 다르면 가정은 바로잡되 **사용자 제품 의도**는 지켜라. 제품 의도를 변경해야 한다면 변경 이유·영향·대안·추천안을 제시해 승인받고, 그동안 다른 독립 작업을 계속 진행하라.
