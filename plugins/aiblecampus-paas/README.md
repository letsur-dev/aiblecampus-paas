# 에이블캠퍼스 PaaS 플러그인

Claude Code와 Codex에서 웹앱을 완성하고 검증한 뒤 에이블캠퍼스 PaaS에 배포한다. 같은 배포 스킬과 MCP 도구를 두 클라이언트가 함께 사용한다.

## 지원 기능

- 요청한 웹앱 구현과 배포 가능 여부 검증
- 로컬 프로젝트와 public Git 저장소 배포
- 기존 앱의 같은 주소 유지 재배포
- 배포 상태, 빌드 로그와 실행 로그 조회
- 일반 환경변수와 암호화된 비밀값 관리
- Claude Code와 Codex 공통 작업 흐름

## 설치

이 저장소를 내려받은 폴더를 marketplace로 등록한 뒤 `aiblecampus-paas` 플러그인을 설치한다.

Claude Code에서는 저장소의 `.claude-plugin/marketplace.json`을 사용한다. Codex에서는 저장소의 `.agents/plugins/marketplace.json`을 사용한다.

플랫폼 연결에는 다음 환경변수가 필요하다.

- `PAAS_API_URL`: 플랫폼 제어 API 주소
- `PAAS_TOKEN`: 사용자 Credential

Credential 원문은 프로젝트 파일, 커밋이나 대화에 기록하지 않는다. 값을 설정한 뒤 사용하는 클라이언트를 다시 시작한다.

## 현재 범위

PostgreSQL과 파일 Storage 자동 연결, 브라우저 로그인과 Team Workspace 선택은 플랫폼 기능이 준비되는 순서에 맞춰 추가한다. 스킬은 앱에서 이 기능이 필요하다는 사실을 감지하고, 아직 제공되지 않는 기능을 임시 저장 방식으로 속이지 않도록 안내한다.
