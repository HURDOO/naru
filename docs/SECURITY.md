# Naru 보안 모델

## 위협 경계

Naru는 설치한 OS 사용자 권한으로 shell과 Codex CLI를 실행한다. 인증된 controller가 그 사용자 권한으로
명령을 실행할 수 있다는 점은 제품의 핵심 위험이다. Private network 접근만으로 사용자를 인증하지 않으며
Gateway authentication, Naru authorization과 Host capability를 모두 통과해야 한다.

## 주요 불변조건

- Browser listener는 wildcard/public bind, CIDR source policy와 forwarded client identity를 기본으로
  허용하지 않는다.
- HTTP mutation과 WebSocket은 exact Origin, session, CSRF, message schema와 size limit을 검사한다.
- Gateway는 cookie, authorization, forwarding·reserved header를 upstream에 전달하지 않는다.
- Signed app assertion은 issuer, audience, Origin, time, signature와 replay를 검증한다.
- Host attachment token은 app, caller, Session, runtime과 generation에 묶고 memory에만 둔다.
- Project와 credential path는 `realpath`, owner, mode, file type과 approved root를 재검사한다.
- Terminal escape sequence와 filename은 신뢰하지 않고 raw HTML이나 arbitrary URL을 실행하지 않는다.
- Secret, cookie, capability, terminal/Codex 원문과 request body를 구조화 로그에 기록하지 않는다.

## 운영 변경

Install, upgrade, reconfigure와 rollback은 read-only plan과 fresh digest approval을 분리한다. Package는
자기가 소유한 release, config와 service만 변경하며 DNS, VPN, firewall, router와 certificate issuance를
자동으로 수행하지 않는다. Production과 실제 device 검증은 isolated automatic test와 별도의 승인
경계다.

## 공개 source hygiene

`pnpm public:scan`은 worktree가 아니라 Git index blob, 도달 가능한 commit/tag/blob과 역사적 filename을
검사한다. 기본 검사는 credential pattern, private key, webhook, private user path, 금지 artifact와 깨진
local 문서 링크를 다룬다. 저장소 밖 absolute `NARU_PUBLIC_SCAN_DENYLIST_FILE`을 주면 운영자가 알고 있는
instance 식별자도 literal 일치로 검사하며 값 자체는 결과에 출력하지 않는다. Generic fixture는 reserved
domain과 명시적인 example path만 사용한다.

Scanner는 알지 못하는 hostname, IP, account 또는 의미상 민감한 운영 서술을 자동 판별할 수 없다. 통과
결과가 사람의 privacy review나 secret 관리를 대신하지 않으며 새 dependency와 release마다 dependency
audit을 함께 수행한다.

## 취약점 보고

공개 remote가 준비되면 repository의 private security advisory를 사용한다. 공개 issue에 exploit detail,
secret, terminal output 또는 실제 instance topology를 게시하지 않는다.
