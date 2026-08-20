import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packDirectory } from "./pack.ts";

/**
 * PaaS 접속 주소. 로컬과 서버를 이 환경변수 하나로 전환한다.
 * 주소를 코드에 넣지 않는다.
 */
function apiBase(): string {
  return process.env["PAAS_API_URL"]?.trim() || "http://127.0.0.1:8730";
}

/**
 * 인증 토큰.
 *
 * 제어 API 는 소스를 받아 컨테이너로 실행하므로 토큰 없이는 아무것도 하지 않는다.
 * 설정이 없을 때 조용히 실패하지 않고 무엇을 해야 하는지 그대로 알려준다.
 */
function token(): string | null {
  return process.env["PAAS_TOKEN"]?.trim() || null;
}

const TOKEN_MISSING =
  "PAAS_TOKEN 이 설정되어 있지 않다.\n" +
  "플랫폼 운영자에게 토큰을 받은 뒤 플러그인이 실행되는 환경의 PAAS_TOKEN 으로 설정한다.\n" +
  "설정한 뒤 Claude Code 또는 Codex 를 다시 시작한다. 토큰 원문은 대화나 소스에 기록하지 않는다.";

/** 배포 이름 후보를 만든다. 그대로 subdomain 이 되므로 DNS label 규칙에 맞게 정리한다. */
export function toDeploymentName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return normalized.length < 2 ? `app-${normalized}` : normalized;
}

/**
 * git 주소로 볼 수 있는 입력인지 본다.
 *
 * 사용자가 로컬 경로와 git 주소를 같은 인자에 넣기 때문에 필요하다.
 * 서버 쪽 판별과 같은 규칙이며, 플러그인은 폴더 밖을 참조할 수 없어 복제해 둔다.
 * 한쪽을 고치면 `src/source/provider.ts` 도 고친다.
 */
export function looksLikeGitUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (/^(https?|git|ssh):\/\//.test(trimmed)) return true;
  if (/^[\w.-]+@[\w.-]+:.+/.test(trimmed)) return true;
  return false;
}

/** git 주소에서 배포 이름 후보를 뽑는다. 마지막 경로 조각에서 .git 을 뗀다. */
export function gitRepoNameOf(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const trimmed = withoutQuery.replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "app";
  return last.replace(/\.git$/, "") || "app";
}

type JsonRecord = Record<string, unknown>;

type ApiResult = {
  ok: boolean;
  status: number;
  body: JsonRecord | string;
};

async function callApi(
  urlPath: string,
  init: RequestInit = {},
): Promise<ApiResult> {
  const authorization = token();
  if (authorization === null) {
    return { ok: false, status: 0, body: TOKEN_MISSING };
  }

  let response: Response;
  try {
    response = await fetch(`${apiBase()}${urlPath}`, {
      ...init,
      headers: {
        authorization: `Bearer ${authorization}`,
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    // 네트워크 실패와 인증 실패를 구분해야 사용자가 고칠 곳을 안다.
    return {
      ok: false,
      status: 0,
      body:
        `PaaS 에 연결하지 못했다: ${apiBase()}\n` +
        `${error instanceof Error ? error.message : String(error)}\n\n` +
        "PAAS_API_URL 이 올바른지, 플랫폼이 기동 중인지 확인한다.",
    };
  }

  const text = await response.text();
  let body: JsonRecord | string = text;
  try {
    body = JSON.parse(text) as JsonRecord;
  } catch {
    // 본문이 JSON 이 아니면 그대로 둔다
  }
  return { ok: response.ok, status: response.status, body };
}

function textResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(message: string): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 실패 응답을 사람과 agent 가 함께 읽을 수 있는 형태로 만든다. */
function failure(prefix: string, result: ApiResult): ReturnType<typeof errorResult> {
  if (result.status === 0) return errorResult(String(result.body));
  if (result.status === 401) {
    return errorResult(
      `${prefix}: 인증에 실패했다 (401).\nPAAS_TOKEN 이 올바른지 확인한다. 토큰이 폐기됐을 수 있다.`,
    );
  }
  return errorResult(
    `${prefix} (HTTP ${result.status})\n${
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body, null, 2)
    }`,
  );
}

const server = new McpServer({
  name: "aiblecampus-paas",
  version: "0.6.0",
});

server.registerTool(
  "validate_project",
  {
    title: "프로젝트 배포 전 검증",
    description:
      "프로젝트를 빌드하거나 실행하지 않고 배포 가능 여부를 판정한다. runtime, 프레임워크, 실행 명령, PORT와 bind, 환경변수, Dockerfile 위험을 구조화해 반환한다.",
    inputSchema: {
      path: z
        .string()
        .describe(
          "검증할 프로젝트의 로컬 디렉토리 절대 경로이거나 public git 저장소의 https 주소다",
        ),
      ref: z
        .string()
        .optional()
        .describe("git 주소일 때만 쓰는 branch 나 tag 이름"),
      subdir: z
        .string()
        .optional()
        .describe("git 저장소 안에서 검증할 하위 디렉토리"),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("배포할 때 주입할 일반 환경변수. 필요한 키 누락 판정에 사용한다"),
      secretKeys: z
        .array(z.string())
        .optional()
        .describe("비밀값으로 주입할 환경변수 키 이름. 값은 검증 도구에 넘기지 않는다"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ path: projectPath, ref, subdir, env, secretKeys }) => {
    if (looksLikeGitUrl(projectPath)) {
      const result = await callApi("/v1/preflight/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: projectPath,
          ...(ref === undefined ? {} : { ref }),
          ...(subdir === undefined ? {} : { subdir }),
          env: env ?? {},
          secretKeys: secretKeys ?? [],
        }),
      });
      if (!result.ok) return failure("배포 전 검증에 실패했다", result);
      return textResult({
        검증됨: true,
        소스: "git",
        ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
      });
    }

    if (!existsSync(projectPath)) {
      return errorResult(`경로가 없다: ${projectPath}`);
    }

    let tarball: Buffer;
    try {
      tarball = await packDirectory(projectPath);
    } catch (error) {
      return errorResult(
        `소스를 묶지 못했다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const form = new FormData();
    form.set(
      "source",
      new Blob([new Uint8Array(tarball)], { type: "application/gzip" }),
      "source.tar.gz",
    );
    if (env !== undefined) form.set("env", JSON.stringify(env));
    if (secretKeys !== undefined) {
      form.set("secretKeys", JSON.stringify(secretKeys));
    }

    const result = await callApi("/v1/preflight", {
      method: "POST",
      body: form,
    });
    if (!result.ok) return failure("배포 전 검증에 실패했다", result);
    return textResult({
      검증됨: true,
      소스: "tarball",
      ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
    });
  },
);

server.registerTool(
  "deploy_project",
  {
    title: "프로젝트 배포",
    description:
      "프로젝트를 에이블캠퍼스 PaaS 에 배포한다. 로컬 디렉토리 경로를 주면 tar.gz 로 묶어 올리고, git 주소를 주면 서버가 직접 clone 한다. 빌드와 실행, 접속 URL 발급까지 수행한다.",
    inputSchema: {
      path: z
        .string()
        .describe(
          "배포할 프로젝트의 위치. 로컬 디렉토리의 절대 경로(보통 현재 작업 디렉토리)이거나 public git 저장소의 https 주소다",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "배포 이름. 접속 URL 의 하위 도메인이 된다. 생략하면 디렉토리 이름에서 만든다",
        ),
      ref: z
        .string()
        .optional()
        .describe("git 주소일 때만 쓴다. branch 나 tag 이름. 생략하면 기본 branch"),
      subdir: z
        .string()
        .optional()
        .describe(
          "git 주소일 때만 쓴다. 저장소 안에서 배포할 하위 디렉토리. monorepo 에서 쓴다",
        ),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("배포 컨테이너에 주입할 일반 환경변수"),
      secrets: z
        .record(z.string(), z.string().min(1))
        .optional()
        .describe(
          "배포 컨테이너에 안전하게 주입할 비밀값. 응답과 로그에는 값이 표시되지 않는다",
        ),
      resources: z
        .object({
          cpus: z.number().positive(),
          memoryMb: z.number().int().min(64),
        })
        .optional()
        .describe(
          "프로젝트에 적용할 CPU 수와 메모리 MB. 생략하면 플랫폼 기본값을 사용하며 운영 상한을 넘으면 배포가 거부된다",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ path: projectPath, name, ref, subdir, env, secrets, resources }) => {
    // git 주소면 서버가 직접 clone 한다. 업로드가 없어 큰 저장소에서 훨씬 빠르다.
    if (looksLikeGitUrl(projectPath)) {
      const deploymentName = toDeploymentName(
        name ?? gitRepoNameOf(projectPath),
      );
      const result = await callApi("/v1/deployments/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: deploymentName,
          url: projectPath,
          ...(ref === undefined ? {} : { ref }),
          ...(subdir === undefined ? {} : { subdir }),
          env: env ?? {},
          ...(secrets === undefined ? {} : { secrets }),
          ...(resources === undefined ? {} : { resources }),
        }),
      });
      if (!result.ok) return failure("배포에 실패했다", result);
      return textResult({
        배포됨: true,
        이름: deploymentName,
        소스: "git",
        ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
      });
    }

    if (!existsSync(projectPath)) {
      return errorResult(`경로가 없다: ${projectPath}`);
    }

    const deploymentName = toDeploymentName(name ?? path.basename(projectPath));

    let tarball: Buffer;
    try {
      tarball = await packDirectory(projectPath);
    } catch (error) {
      return errorResult(
        `소스를 묶지 못했다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const form = new FormData();
    form.set("name", deploymentName);
    form.set(
      "source",
      new Blob([new Uint8Array(tarball)], { type: "application/gzip" }),
      "source.tar.gz",
    );
    if (env !== undefined) form.set("env", JSON.stringify(env));
    if (secrets !== undefined) form.set("secrets", JSON.stringify(secrets));
    if (resources !== undefined) {
      form.set("resources", JSON.stringify(resources));
    }

    const result = await callApi("/v1/deployments", {
      method: "POST",
      body: form,
    });

    // 실패 단계와 원인을 그대로 전달해야 agent 가 다음 행동을 판단할 수 있다.
    if (!result.ok) return failure("배포에 실패했다", result);

    return textResult({
      배포됨: true,
      이름: deploymentName,
      ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
    });
  },
);

server.registerTool(
  "deployment_status",
  {
    title: "배포 상태 조회",
    description:
      "배포의 현재 상태, 접속 URL, 현재 revision 을 조회한다. 이름이나 배포 id 로 찾는다.",
    inputSchema: {
      deployment: z.string().describe("배포 이름 또는 배포 id"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ deployment }) => {
    const result = await callApi(
      `/v1/deployments/${encodeURIComponent(deployment)}`,
    );
    if (!result.ok) return failure("상태를 조회하지 못했다", result);
    return textResult(result.body);
  },
);

server.registerTool(
  "deployment_config",
  {
    title: "배포 설정 조회",
    description:
      "배포에 저장된 일반 환경변수 값과 비밀값 키 이름을 조회한다. 비밀값 원문은 반환하지 않는다.",
    inputSchema: {
      deployment: z.string().describe("배포 이름 또는 배포 id"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ deployment }) => {
    const result = await callApi(
      `/v1/deployments/${encodeURIComponent(deployment)}/config`,
    );
    if (!result.ok) return failure("설정을 조회하지 못했다", result);
    return textResult(result.body);
  },
);

server.registerTool(
  "set_deployment_config",
  {
    title: "배포 설정 변경",
    description:
      "일반 환경변수와 비밀값을 추가, 교체, 삭제한다. null 값은 해당 키를 삭제한다. 변경 내용은 다음 배포부터 적용되며 비밀값 원문은 응답하지 않는다.",
    inputSchema: {
      deployment: z.string().describe("배포 이름 또는 배포 id"),
      env: z
        .record(z.string(), z.union([z.string(), z.null()]))
        .optional()
        .describe("일반 환경변수 변경. 문자열은 저장, null 은 삭제"),
      secrets: z
        .record(z.string(), z.union([z.string().min(1), z.null()]))
        .optional()
        .describe(
          "비밀값 변경. 문자열은 암호화 저장, null 은 삭제. 조회 결과에는 키 이름만 나온다",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ deployment, env, secrets }) => {
    if (env === undefined && secrets === undefined) {
      return errorResult("env 또는 secrets 중 하나가 필요하다");
    }
    const result = await callApi(
      `/v1/deployments/${encodeURIComponent(deployment)}/config`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(env === undefined ? {} : { env }),
          ...(secrets === undefined ? {} : { secrets }),
        }),
      },
    );
    if (!result.ok) return failure("설정을 변경하지 못했다", result);
    return textResult({
      변경됨: true,
      적용시점: "다음 배포",
      ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
    });
  },
);

server.registerTool(
  "deployment_logs",
  {
    title: "배포 로그 조회",
    description:
      "배포의 빌드 로그나 실행 로그를 조회한다. 배포가 실패했을 때 원인을 확인하는 수단이다.",
    inputSchema: {
      deployment: z.string().describe("배포 이름 또는 배포 id"),
      type: z
        .enum(["build", "runtime"])
        .default("build")
        .describe("build 는 이미지 빌드 로그, runtime 은 실행 중인 앱의 로그"),
      revisionId: z
        .string()
        .optional()
        .describe("특정 revision 의 로그를 볼 때 지정한다. 생략하면 최신 revision"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ deployment, type, revisionId }) => {
    let targetRevision = revisionId;

    if (targetRevision === undefined) {
      const revisions = await callApi(
        `/v1/deployments/${encodeURIComponent(deployment)}/revisions`,
      );
      if (!revisions.ok) return failure("revision 목록을 조회하지 못했다", revisions);
      if (typeof revisions.body === "string") {
        return errorResult("revision 목록 응답을 해석하지 못했다");
      }
      const list = revisions.body["revisions"];
      if (!Array.isArray(list) || list.length === 0) {
        return errorResult("revision 이 없다");
      }
      targetRevision = (list[0] as { id: string }).id;
    }

    const result = await callApi(
      `/v1/revisions/${encodeURIComponent(targetRevision)}/logs?type=${type}`,
    );
    if (!result.ok) return failure("로그를 조회하지 못했다", result);
    return textResult(result.body);
  },
);

server.registerTool(
  "list_deployments",
  {
    title: "배포 목록",
    description: "내가 이 PaaS 에 올린 배포 목록과 각각의 상태를 조회한다.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const result = await callApi("/v1/deployments");
    if (!result.ok) return failure("목록을 조회하지 못했다", result);
    return textResult(result.body);
  },
);

server.registerTool(
  "paas_whoami",
  {
    title: "PaaS 연결 확인",
    description:
      "PaaS 주소와 토큰 설정이 올바른지 확인한다. 배포가 인증 문제로 실패할 때 먼저 부른다.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const result = await callApi("/v1/me");
    if (!result.ok) return failure("연결을 확인하지 못했다", result);
    return textResult({ 주소: apiBase(), ...(result.body as JsonRecord) });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
