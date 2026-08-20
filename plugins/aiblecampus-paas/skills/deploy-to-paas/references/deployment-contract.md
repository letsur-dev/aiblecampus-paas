# 배포 계약과 복구

## 애플리케이션 실행 계약

Node 서버는 플랫폼이 주입하는 `PORT`를 읽고 `0.0.0.0`에서 listen한다.

```js
const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0");
```

- `PORT`를 일반 설정이나 비밀값으로 직접 지정하지 않는다.
- `127.0.0.1`에만 bind하면 컨테이너 밖에서 접근할 수 없다.
- 실행 명령은 foreground에서 서버 프로세스를 유지해야 한다.
- 배포에 필요한 의존성은 package manifest와 lockfile에 기록한다.
- 자체 Dockerfile은 non-root 실행, 명확한 실행 명령과 healthcheck 대상 포트를 갖춰야 한다.

## 로컬 경로와 Git 주소

| 상황 | 사용할 소스 |
| --- | --- |
| 현재 작업 중인 정확한 파일을 배포 | 로컬 프로젝트 절대 경로 |
| 커밋하지 않은 변경 포함 | 로컬 프로젝트 절대 경로 |
| public 원격 저장소의 특정 branch 또는 tag | HTTPS Git 주소와 `ref` |
| monorepo의 일부 앱 | Git 주소와 `subdir` 또는 해당 로컬 하위 경로 |

Git 주소를 검증한 뒤 원격 branch가 바뀌면 검증한 소스와 배포 소스가 달라질 수 있다. 가능하면 고정된 commit 또는 tag를 사용한다.

## 실패 단계

| stage | 뜻 | 처리 |
| --- | --- | --- |
| `fetch` | 소스를 가져오지 못함 | 주소, `ref`, `subdir`과 public 접근 가능 여부를 확인한다 |
| `analyze` | 프로젝트 구조를 판정하지 못함 | package manifest와 실제 앱 경로를 확인한다 |
| `validate` | 실행 계약이나 안전 기준을 충족하지 못함 | 구조화된 `fix`를 적용하고 다시 검증한다 |
| `queue` | 실행 슬롯과 대기열이 가득 참 | 한 번만 다시 시도하고 계속 실패하면 나중에 시도하도록 알린다 |
| `build` | 이미지 빌드 실패 | build 로그를 읽고 의존성, lockfile과 build 명령을 수정한다 |
| `run` | 앱 프로세스 기동 실패 | runtime 로그와 실행 명령, 필수 설정을 확인한다 |
| `health` | 앱이 제시간에 응답하지 않음 | `PORT`, bind 주소, 시작 시간과 healthcheck 경로를 확인한다 |

## 복구 원칙

- build, run, health 실패에서는 먼저 해당 revision 로그를 읽는다.
- 실제 원인을 고친 뒤 `validate_project`를 다시 호출한다.
- 같은 입력을 근거 없이 반복 배포하지 않는다.
- 새 revision이 실패하면 이전 실행 버전과 URL을 보존한다.
- 자동 수정이 사용자의 기능 요구를 바꾸거나 데이터를 지울 수 있으면 진행 전에 확인한다.
- quota, 권한과 인증 오류는 다른 이름이나 Credential로 우회하지 않는다.

## 배포 이름

- 소문자, 숫자와 하이픈만 사용한다.
- 이름은 Workspace 안에서 유일하다.
- 응답의 `url`이 정본이며 slug를 직접 계산하지 않는다.
- 기존 배포를 수정할 때는 이름을 유지한다.
