# 에이블캠퍼스 PaaS 배포 플러그인

에이블캠퍼스 PaaS 에 프로젝트를 배포하는 Claude Code 플러그인이다. AI agent 가 프로젝트 디렉토리에서 배포 요청을 하면 빌드하고 격리 실행해 접속 URL 을 발급한다.

이 저장소는 **플러그인 배포 전용**이다. 서버 구현은 별도 비공개 저장소에 있다.

## 설치

Claude Code 에서 marketplace 를 추가하고 플러그인을 설치한다.

```
/plugin marketplace add letsur-dev/aiblecampus-paas
/plugin install aiblecampus-paas@aiblecampus
```

## 설정

플랫폼 접속 정보를 환경변수로 넣는다. 셸 프로필에 넣고 Claude Code 를 새로 띄운다.

```bash
export PAAS_API_URL=http://<플랫폼 주소>
export PAAS_TOKEN=<운영자에게 받은 토큰>
```

`PAAS_TOKEN` 은 플랫폼 운영자가 발급한다. 토큰이 없으면 배포 도구가 안내 메시지를 반환한다.

## 제공하는 도구

| 도구 | 하는 일 |
| --- | --- |
| `deploy_project` | 프로젝트를 빌드하고 배포해 접속 URL 을 발급한다 |
| `deployment_status` | 배포의 현재 상태와 URL, revision 을 조회한다 |
| `deployment_logs` | build 또는 runtime 로그를 조회한다 |
| `list_deployments` | 내 배포 목록을 조회한다 |
| `paas_whoami` | 플랫폼 연결과 소유자 정보를 확인한다 |

## 사용

설치 후 아무 프로젝트 디렉토리에서 자연어로 배포를 요청한다.

```
이 프로젝트 배포해줘
```

연결만 먼저 확인하려면 `paas_whoami` 를 부르면 된다.
