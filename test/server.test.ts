import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, SECRET_SENTINEL, apiKeyEnvironmentName } from "../src/config-store";
import { createRequestHandler } from "../src/server";
import type { ProbeInput, ProbeResult } from "../src/probe";
import type { DiscoveryInput, DiscoveryResult } from "../src/discovery";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(source = "providers: {}\n") {
  const directory = await mkdtemp(join(tmpdir(), "omp-models-api-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "models.yml");
  await Bun.write(path, source);
  return {
    directory,
    path,
    handler: createRequestHandler({ store: new ConfigStore(path) }),
  };
}

async function body(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

function request(path: string, method = "GET", payload?: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

describe("provider API", () => {
  test("supports GET, PUT, conflict detection, and DELETE without returning keys", async () => {
    const { directory, handler } = await setup("# retained\nproviders: {}\n");
    const initialResponse = await handler(request("/api/providers"));
    const initial = await body(initialResponse);
    expect(initialResponse.status).toBe(200);
    expect(initial.providers).toEqual([]);

    const putResponse = await handler(request("/api/providers/llama.cpp", "PUT", {
      revision: initial.revision,
      definition: {
        baseUrl: "https://models.example/v1",
        api: "openai-completions",
      },
      apiKey: "browser-must-not-see-this",
    }));
    const putResult = await body(putResponse);
    expect(putResponse.status).toBe(200);
    expect(putResult.provider.credential).toEqual({
      configured: true,
      source: "env",
      ref: apiKeyEnvironmentName("llama.cpp"),
    });
    expect(JSON.stringify(putResult)).not.toContain("browser-must-not-see-this");

    const getResult = await body(await handler(request("/api/providers")));
    expect(JSON.stringify(getResult)).not.toContain("browser-must-not-see-this");
    expect(getResult.providers[0].definition.apiKey).toBeUndefined();
    expect(await readFile(join(directory, ".env"), "utf8")).toContain("browser-must-not-see-this");

    const conflictResponse = await handler(request("/api/providers/loser", "PUT", {
      revision: initial.revision,
      definition: { baseUrl: "https://loser.example" },
    }));
    expect(conflictResponse.status).toBe(409);
    expect(await body(conflictResponse)).toEqual({ error: "models.yml changed; reload before saving" });

    const deleteResponse = await handler(request("/api/providers/llama.cpp", "DELETE", {
      revision: putResult.revision,
    }));
    expect(deleteResponse.status).toBe(200);
    expect((await body(deleteResponse)).providers).toEqual([]);
  });

  test("rejects invalid IDs, non-object bodies, embedded credentials, and unknown fields", async () => {
    const { handler } = await setup();
    const revision = (await body(await handler(request("/api/providers")))).revision;

    const cases = [
      request("/api/providers/Bad.Id", "PUT", { revision, definition: {} }),
      request("/api/providers/good", "PUT", []),
      request("/api/providers/good", "PUT", { revision, definition: { apiKey: "leak" } }),
      request("/api/providers/good", "PUT", { revision, definition: {}, unexpected: true }),
      new Request("http://127.0.0.1/api/providers/good", { method: "PUT", body: "not-json" }),
    ];

    for (const invalid of cases) {
      const response = await handler(invalid);
      expect(response.status).toBe(400);
      expect(typeof (await body(response)).error).toBe("string");
    }
  });

  test("validates probe input and delegates the exact accepted request", async () => {
    let received: ProbeInput | undefined;
    const result: ProbeResult = {
      checks: [{ id: "endpoint", label: "Endpoint", status: "pass", detail: "reachable", latencyMs: 4 }],
      models: [{ id: "model-a" }],
      detectedApi: "openai-responses",
      durationMs: 5,
    };
    const { path } = await setup();
    const handler = createRequestHandler({
      store: new ConfigStore(path),
      probe: async (input) => {
        received = input;
        return result;
      },
    });
    const payload: ProbeInput = {
      baseUrl: "https://models.example/v1",
      apiKey: "temporary-key",
      api: "auto",
      authHeader: true,
      discoveryType: "openai-models-list",
      model: "model-a",
      runInference: false,
    };

    const response = await handler(request("/api/probe", "POST", payload));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(result);
    expect(received!).toEqual(payload);

    const invalidDiscovery = await handler(request("/api/probe", "POST", {
      baseUrl: "https://models.example/v1",
      api: "auto",
      discoveryType: "openai",
    }));
    expect(invalidDiscovery.status).toBe(400);
    expect(await body(invalidDiscovery)).toEqual({ error: "discoveryType is invalid" });

    const invalid = await handler(request("/api/probe", "POST", {
      baseUrl: "not a URL",
      api: "unsupported",
      extra: true,
    }));
    expect(invalid.status).toBe(400);
    expect(await body(invalid)).toEqual({ error: "Unknown field: extra" });
  });

  test("validates model, discovery, cost, and credential schema invariants", async () => {
    const { directory, path, handler } = await setup();
    const marker = join(directory, "command-must-not-run");
    await Bun.write(path, `providers:
  configured:
    baseUrl: https://configured.example/v1
    api: openai-completions
    apiKey: !command touch ${marker}
`);
    let revision = (await body(await handler(request("/api/providers")))).revision;
    const modelProvider = {
      baseUrl: "https://models.example/v1",
      api: "openai-completions",
      auth: "none",
    };
    const completeCost = { input: 0, output: 1, cacheRead: 0.1, cacheWrite: 0.2 };
    const invalidDefinitions = [
      { api: "auto" },
      { api: "openai-completions" },
      { api: "openai-completions", models: [] },
      { api: "openai-completions", disableStrictTools: false },
      { api: "openai-completions", modelOverrides: {} },
      { api: "openai-completions", remoteCompaction: false },
      { api: "openai-completions", remoteCompaction: "yes" },
      { discovery: { type: "llama-cpp" } },
      { discovery: { type: "ollama" } },
      { auth: "bearer" },
      { baseUrl: 42 },
      { headers: { Authorization: 42 } },
      { authHeader: "Authorization" },
      { models: {} },
      { api: "openai-completions", auth: "none", models: [{ id: "missing-base-url" }] },
      { baseUrl: modelProvider.baseUrl, api: modelProvider.api, models: [{ id: "unauthenticated" }] },
      { ...modelProvider, models: [{ id: "" }] },
      { ...modelProvider, models: [{ id: "model-a" }, { id: "model-a" }] },
      { ...modelProvider, models: [{ id: "model-a", input: "text" }] },
      { ...modelProvider, models: [{ id: "model-a", input: ["audio"] }] },
      { ...modelProvider, models: [{ id: "model-a", cost: [] }] },
      { ...modelProvider, models: [{ id: "model-a", cost: {} }] },
      { ...modelProvider, models: [{ id: "model-a", cost: { input: 0 } }] },
      { ...modelProvider, models: [{ id: "model-a", cost: { ...completeCost, request: 1 } }] },
      { ...modelProvider, models: [{ id: "model-a", cost: { ...completeCost, input: -1 } }] },
      { ...modelProvider, models: [{ id: "model-a", contextWindow: 0 }] },
      { ...modelProvider, models: [{ id: "model-a", maxTokens: Number.NaN }] },
    ];

    for (const definition of invalidDefinitions) {
      const response = await handler(request("/api/providers/invalid", "PUT", { revision, definition }));
      expect(response.status).toBe(400);
    }

    const valid = await handler(request("/api/providers/local", "PUT", {
      revision,
      definition: {
        baseUrl: "http://127.0.0.1:8080/v1",
        api: "openai-completions",
        auth: "none",
        discovery: { type: "llama.cpp" },
        headers: { "X-Tenant": "local" },
        disableStrictTools: false,
        models: [{
          id: "local-model",
          input: ["text", "image"],
          cost: { input: 0, output: 1, cacheRead: 0.1, cacheWrite: 0.2 },
          contextWindow: 4096,
          maxTokens: 512,
        }],
      },
    }));
    expect(valid.status).toBe(200);
    revision = (await body(valid)).revision;

    const bodyKey = await handler(request("/api/providers/with-key", "PUT", {
      revision,
      apiKey: "new-browser-key",
      definition: {
        baseUrl: "https://with-key.example/v1",
        api: "openai-completions",
        models: [{ id: "secured-model" }],
      },
    }));
    expect(bodyKey.status).toBe(200);
    revision = (await body(bodyKey)).revision;

    const metadataKey = await handler(request("/api/providers/configured", "PUT", {
      revision,
      definition: {
        baseUrl: "https://configured.example/v1",
        api: "openai-completions",
        models: [{ id: "configured-model" }],
      },
    }));
    expect(metadataKey.status).toBe(200);
    revision = (await body(metadataKey)).revision;
    expect(await Bun.file(marker).exists()).toBe(false);

    const remoteCompaction = await handler(request("/api/providers/remote", "PUT", {
      revision,
      definition: {
        api: "openai-completions",
        remoteCompaction: { enabled: true },
      },
    }));
    expect(remoteCompaction.status).toBe(200);
  });

  test("redacts all stored headers and merges only submitted probe header keys", async () => {
    const environmentRef = `OMP_API_${crypto.randomUUID().replaceAll("-", "_")}`;
    const secret = "resolved-file-secret";
    const headerSecret = "Bearer stored-header-secret";
    const modelHeaderSecret = "Bearer stored-model-secret";
    const { directory, path } = await setup(`providers:
  llama.cpp:
    baseUrl: https://models.example/v1
    apiKey: ${environmentRef}
    headers:
      Authorization: ${headerSecret}
      X-Tenant: local
      X-Removed: stored-but-deleted-in-form
      X-Command: "!security find-generic-password -w"
    models:
      - id: model-a
        headers:
          Authorization: ${modelHeaderSecret}
          X-Team: stored-model-team
`);
    await Bun.write(join(directory, ".env"), `${environmentRef}="${secret}"\n`);
    const received: ProbeInput[] = [];
    const result: ProbeResult = {
      checks: [{ id: "authentication", label: "Authentication", status: "pass", detail: "accepted" }],
      models: [],
      durationMs: 2,
    };
    const handler = createRequestHandler({
      store: new ConfigStore(path),
      probe: async (input) => {
        received.push(structuredClone(input));
        return result;
      },
    });

    const listed = await body(await handler(request("/api/providers")));
    expect(listed.providers[0].definition.headers).toEqual({
      Authorization: SECRET_SENTINEL,
      "X-Tenant": SECRET_SENTINEL,
      "X-Removed": SECRET_SENTINEL,
      "X-Command": SECRET_SENTINEL,
    });
    expect(listed.providers[0].definition.models[0].headers).toEqual({
      Authorization: SECRET_SENTINEL,
      "X-Team": SECRET_SENTINEL,
    });
    expect(JSON.stringify(listed)).not.toContain("stored-header-secret");
    expect(JSON.stringify(listed)).not.toContain("stored-model-team");
    expect(JSON.stringify(listed)).not.toContain("stored-model-secret");
    expect(JSON.stringify(listed)).not.toContain("find-generic-password");

    const customResponse = await handler(request("/api/probe", "POST", {
      providerId: "llama.cpp",
      baseUrl: "https://models.example/v1",
      api: "auto",
      authHeader: false,
      runInference: true,
      model: "model-a",
      headers: {
        Authorization: SECRET_SENTINEL,
        "X-Tenant": "unsaved-tenant",
        "X-New": "unsaved-header",
        "X-Unknown": SECRET_SENTINEL,
      },
    }));

    expect(customResponse.status).toBe(200);
    expect(received[0]?.apiKey).toBe(secret);
    expect(received[0]?.headers).toEqual({
      Authorization: headerSecret,
      "X-Tenant": "unsaved-tenant",
      "X-New": "unsaved-header",
    });
    expect(received[0]?.inferenceHeaders).toEqual({
      Authorization: modelHeaderSecret,
      "X-Tenant": "unsaved-tenant",
      "X-New": "unsaved-header",
      "X-Team": "stored-model-team",
    });
    expect(received[0]?.headers).not.toHaveProperty("X-Removed");
    expect(received[0]?.headers).not.toHaveProperty("X-Unknown");
    expect(received[0]?.authHeader).toBe(false);
    expect(received[0]?.credentialsUnavailable).toBe(true);

    const storedResponse = await handler(request("/api/probe", "POST", {
      providerId: "llama.cpp",
      baseUrl: "https://models.example/v1",
      api: "auto",
      runInference: false,
    }));
    expect(storedResponse.status).toBe(200);
    expect(received[1]?.headers).toEqual({
      Authorization: headerSecret,
      "X-Tenant": "local",
      "X-Removed": "stored-but-deleted-in-form",
    });
    expect(received[1]?.inferenceHeaders).toBeUndefined();
    expect(received[1]?.credentialsUnavailable).toBe(true);

    for (const response of [customResponse, storedResponse]) {
      const responseBody = await body(response);
      expect(JSON.stringify(responseBody)).not.toContain(secret);
      expect(JSON.stringify(responseBody)).not.toContain(headerSecret);
      expect(JSON.stringify(responseBody)).not.toContain(modelHeaderSecret);
    }
  });

  test("marks quoted command api keys unavailable without executing them", async () => {
    const { directory, path } = await setup();
    const marker = join(directory, "api-key-command-must-not-run");
    await Bun.write(path, `providers:
  command-key:
    baseUrl: https://models.example/v1
    apiKey: "!command touch ${marker}"
`);
    let received: ProbeInput | undefined;
    const handler = createRequestHandler({
      store: new ConfigStore(path),
      probe: async (input) => {
        received = structuredClone(input);
        return { checks: [], models: [], durationMs: 1 };
      },
    });

    const response = await handler(request("/api/probe", "POST", {
      providerId: "command-key",
      baseUrl: "https://models.example/v1",
      api: "auto",
      runInference: false,
    }));

    expect(response.status).toBe(200);
    expect(received?.apiKey).toBeUndefined();
    expect(received?.credentialsUnavailable).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("resolves stored discovery credentials without returning them", async () => {
    const secret = "stored-api-key-secret";
    const headerSecret = "stored-header-secret";
    const { directory, path } = await setup(`providers:
  gateway:
    baseUrl: https://gateway.example/v1/messages
    api: anthropic-messages
    apiKey: OMP_CUSTOM_GATEWAY_API_KEY
    headers:
      X-Tenant: local
      Authorization: ${headerSecret}
    models:
      - id: configured-model
        compat:
          supportsDeveloperRole: false
`);
    await Bun.write(join(directory, ".env"), `OMP_CUSTOM_GATEWAY_API_KEY=${secret}\n`);
    let received: DiscoveryInput | undefined;
    const handler = createRequestHandler({
      store: new ConfigStore(path),
      discover: async (input): Promise<DiscoveryResult> => {
        received = structuredClone(input);
        return {
          models: [{ id: "remote-model" }],
          source: "remote",
          attempts: [{ url: "https://gateway.example/v1/models", status: 200, detail: "ok" }],
        };
      },
    });

    const response = await handler(request("/api/discover", "POST", {
      providerId: "gateway",
      baseUrl: "https://gateway.example/v1/messages",
      api: "anthropic-messages",
      headers: {
        Authorization: SECRET_SENTINEL,
        "X-Request": "current",
      },
    }));
    const result = await body(response);

    expect(response.status).toBe(200);
    expect(received?.apiKey).toBe(secret);
    expect(received?.headers).toEqual({
      Authorization: headerSecret,
      "X-Request": "current",
    });
    expect(received?.configuredModels).toEqual([
      { id: "configured-model", compat: { supportsDeveloperRole: false } },
    ]);
    expect(result.source).toBe("remote");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(headerSecret);

    const invalid = await handler(request("/api/discover", "POST", {
      baseUrl: "file:///etc/passwd",
      api: "anthropic-messages",
    }));
    expect(invalid.status).toBe(400);
  });

  test("returns JSON errors for unknown APIs and methods", async () => {
    const { handler } = await setup();
    const missing = await handler(request("/api/missing"));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
    expect(await body(missing)).toEqual({ error: "API route not found" });

    const method = await handler(request("/api/providers", "POST", {}));
    expect(method.status).toBe(405);
    expect(await body(method)).toEqual({ error: "Method not allowed" });
  });
});
