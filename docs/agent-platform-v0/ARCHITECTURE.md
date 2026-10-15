# Agent Platform v0 기술 아키텍처 (초안)

> 상태: Phase 2 공통 기반(§1~§5)을 먼저 확정한다. 런타임 어댑터, GUI와 TUI 전환, native 관찰 수준(§6)은
> Gate 1(AP-T08)의 검증 결과로 채운다. 결정의 근거는 [DECISIONS.md](DECISIONS.md)에 있다.

## 1. 구성

```text
browser ── Gateway(passkey) ── Naru server ── HTTP·WS ─┐
                                                       ├─ AgentPlatformCore ─ SQLite(v20+)
agent runtime ── stdio ── naru-mcp bin ── owner UDS ───┘          │
                                                                  └─ DS Host(UDS, 기존 capability)
```

- **AgentPlatformCore**(`apps/server/src/agent-platform/`)는 Web UI, MCP, CLI가 함께 쓰는 단일
  command와 query 진입점이다. 정책을 우회하는 별도 DB 쓰기 통로를 두지 않는다(SOURCE_SPEC §11).
- browser 경로는 기존 Gateway assertion, CSRF, Origin 검사와 사람 기기 lease를 그대로 사용한다.
- agent 경로는 Naru가 띄운 agent session에만 주입한 MCP bin을 통해 들어온다. 이 bin은 owner-only
  UDS로 연결하고, 세션별 capability로 행위자를 결정한다(AP-D004, V13).
- 계약은 `@naru/contracts/naru-agent/v1`에 둔다. 기존 `naru-app/v1`과 `durable-session/v0`의 wire는
  바꾸지 않는다.

## 2. 데이터 모델

`Task`, `Run`, `AgentSession`, terminal Session은 서로 다른 개념이다. 한 Task는 여러 Run을 가질 수
있고, 한 AgentSession은 자식 AgentSession과 terminal Session을 만들 수 있다.

| 테이블                                   | 내용                                                                 | 핵심 불변 조건                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_instructions`                     | 사람의 지시와 에이전트의 위임 메시지 원문(AP-D002)                   | 원문은 불변이고 수정은 `supersedes_id`로 남긴다. 에이전트가 쓴 행은 `origin_user_instruction_id`가 필수다. forget은 원문을 지우고 tombstone을 남긴다 |
| `agent_intent_contracts`                 | 승인된 원칙, 허용 기술, 승인 필요 항목                               | project별 version이 단조 증가한다. 활성 상태는 project별로 최대 하나다                                                                               |
| `agent_plans`                            | 계획 version, 담당 orchestrator, 요약                                | project별 version이 단조 증가한다                                                                                                                    |
| `agent_tasks`, `agent_task_dependencies` | 목적, 완료 조건, 상태, 우선순위, 담당자, 의존성 DAG                  | `origin_instruction_id`가 필수다(INV-01). `revision`으로 낙관적 동시성을 관리한다. 의존성에 cycle을 허용하지 않는다                                  |
| `agent_runs`                             | Task 실행 시도, 런타임, 모델, 상태, 오류 분류                        | 재시작 뒤 결과를 모르면 `unknown`으로 둔다. 성공이나 실패를 추정해 기록하지 않는다                                                                   |
| `agent_sessions`                         | 런타임 세션 참조, 역할, 부모 관계, 관찰 수준, 대화 writer, 사람 hold | 관찰 수준은 검증된 값만 쓴다(`pty`, `transcript`, `lifecycle`, `none`)                                                                               |
| `agent_handoffs`                         | 사람 개입 요청과 해소 결과                                           | payload 필수 필드(SOURCE_SPEC §9.2)를 schema로 검사한다. 해소는 한 번만 가능하다                                                                     |
| `agent_reviews`                          | correctness와 intent 판정                                            | 의도 위반 판정이 남아 있으면 merge gate를 통과시키지 않는다(A11)                                                                                     |
| `agent_artifacts`                        | commit, branch, 경로, 테스트 결과 참조                               | 파일 내용과 전체 출력은 저장하지 않는다                                                                                                              |
| `agent_events`, `agent_event_cursors`    | 메타데이터 이벤트와 consumer별 cursor                                | 전역 `seq`로 순서를 매긴다. payload는 참조와 열거값만 담는다                                                                                         |
| `agent_commands`                         | 변경 command의 idempotency 기록                                      | 같은 actor와 key로 다른 payload가 오면 거부한다                                                                                                      |

terminal Session 바인딩, SharedProcess, 사람 hold, 에이전트의 PTY 입력 기록은 AP-T12에서 같은 원칙으로
추가한다.

## 3. command, 이벤트, 복구

1. 모든 변경 command는 서버가 정한 `actor`, `idempotencyKey`, 필요할 때 `expectedRevision`을 받는다.
2. 하나의 SQLite transaction 안에서 domain 쓰기, event append, command 기록을 함께 commit한다.
3. commit 뒤에만 구독자(WS 화면, orchestrator wakeup)에게 알린다. 알림이 유실돼도 cursor로 다시
   읽을 수 있다.
4. 같은 key의 재요청은 처음 결과를 그대로 돌려준다. 그래서 재시작이나 재전송으로 위임이나 결정이
   두 번 처리되지 않는다(INV-07).
5. orchestrator wakeup은 자기 cursor 이후의 이벤트를 범위(global 또는 project)로 걸러 한 묶음으로
   전달한다. 사람이 hold 중인 대상은 AP-D005를 따른다.

## 4. 행위자와 권한

- 행위자 종류는 `human`, `agent`, `system` 세 가지다. agent의 ID와 역할은 capability가 결정하며,
  도구 인자는 신뢰하지 않는다.
- 역할별 command 허용 범위(초기값)는 contract의 데이터로 둔다.

  | 역할                   | 허용 범위                                                                         |
  | ---------------------- | --------------------------------------------------------------------------------- |
  | `main-orchestrator`    | 전역 조회, project orchestrator에게 위임                                          |
  | `project-orchestrator` | 자기 project의 plan과 task, 위임, review 요청, Handoff, managed agent 생성        |
  | `worker`               | 자기 task 범위의 진행 보고, artifact, Handoff, 설계 변경 제안, 세션 생성(AP-D006) |
  | `reviewer`             | review 제출과 조회                                                                |

- 사람의 browser 변경은 기존처럼 사람 기기 lease를 요구한다. 에이전트 command는 이 lease를 거치지 않는다.

## 5. 저장과 노출 경계

- AP-D002에 따라 원문은 `agent_instructions`(사람 지시와 위임 메시지)와 Handoff 해소 결과에만 둔다.
  이벤트, 구조화 로그, Push에는 넣지 않는다.
- 에이전트가 보내는 자유 텍스트(진행 요약, 설계 변경 제안, review 의견)는 크기 상한을 둔다. 알려진
  token 패턴은 best-effort로 마스킹한다. 1차 방어선은 에이전트에게 비밀값을 주지 않는 것이다.

## 6. Gate 1 이후 채울 항목

- 런타임별 어댑터와 Capability Matrix(V01~V05, V07, V11, V12)
- GUI와 TUI 대화 writer 전환 protocol(AP-D005의 세 번째 계층)
- native subagent 관찰과 managed fallback 정책(V04, V05)
- cross-session messaging 정책(V06, V08)
