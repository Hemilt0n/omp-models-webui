import { describe, expect, test } from "bun:test";
import {
  probeProvider,
  type ProbeCheck,
  type ProbeInput,
} from "../src/probe";

const baseInput: ProbeInput = {
  baseUrl: "https://models.example.test/v1/",
  api: "openai-completions",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchStub(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

function byId(checks: ProbeCheck[], id: ProbeCheck["id"]): ProbeCheck {
  const result = checks.find((check) => check.id === id);
  if (!result) throw new Error(`Missing ${id} check`);
  return result;
}

describe("probeProvider", () => {
  test("discovers OpenAI model data, preserves metadata, and normalizes baseUrl", async () => {
    const calls: string[] = [];
    const result = await probeProvider(
      { ...baseInput, apiKey: "top-secret" },
      {
        fetch: fetchStub((input, init) => {
          calls.push(String(input));
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer top-secret",
          );
          return jsonResponse({
            data: [
              { id: "model-a", name: "Model A", owned_by: "vendor" },
              { name: "model-b", context_window: 32_000 },
            ],
          });
        }),
      },
    );

    expect(calls).toEqual(["https://models.example.test/v1/models"]);
    expect(result.models).toEqual([
      { id: "model-a", name: "Model A", owned_by: "vendor" },
      { id: "model-b", name: "model-b", context_window: 32_000 },
    ]);
    expect(byId(result.checks, "endpoint").status).toBe("pass");
    expect(byId(result.checks, "authentication").status).toBe("pass");
    expect(byId(result.checks, "discovery").status).toBe("pass");
    expect(byId(result.checks, "inference")).toMatchObject({
      status: "skip",
      detail: "Inference probe is disabled",
    });
  });

  test("merges configured headers into discovery and inference with explicit values taking precedence", async () => {
    const seenHeaders: Headers[] = [];
    const result = await probeProvider(
      {
        ...baseInput,
        apiKey: "generated-key",
        headers: {
          Authorization: "Custom configured-secret",
          "X-Tenant": "tenant-a",
          "X-Command": "!security find-generic-password -w",
        },
        model: "model-a",
        runInference: true,
      },
      {
        fetch: fetchStub((input, init) => {
          seenHeaders.push(new Headers(init?.headers));
          return String(input).endsWith("/models")
            ? jsonResponse({ data: [{ id: "model-a" }] })
            : jsonResponse({ id: "completion-a" });
        }),
      },
    );

    expect(seenHeaders).toHaveLength(2);
    for (const headers of seenHeaders) {
      expect(headers.get("authorization")).toBe("Custom configured-secret");
      expect(headers.get("x-tenant")).toBe("tenant-a");
      expect(headers.get("x-command")).toBeNull();
    }
    expect(byId(result.checks, "inference").status).toBe("pass");
    expect(JSON.stringify(result)).not.toContain("configured-secret");
  });

  test.each([404, 500])(
    "treats HTTP %i as indeterminate authentication and failed discovery",
    async (status) => {
      const headerSecret = "header-secret-never-print";
      const result = await probeProvider(
        {
          ...baseInput,
          headers: { "X-Private-Token": headerSecret },
        },
        {
          fetch: fetchStub(() =>
            jsonResponse({ error: { message: `upstream echoed ${headerSecret}` } }, status),
          ),
        },
      );

      expect(byId(result.checks, "endpoint").status).toBe("pass");
      expect(byId(result.checks, "authentication")).toMatchObject({
        status: "skip",
        detail: `Authentication could not be determined from HTTP ${status}`,
      });
      expect(byId(result.checks, "discovery").status).toBe("fail");
      expect(JSON.stringify(result)).not.toContain(headerSecret);
    },
  );

  test("accepts a direct model array", async () => {
    const result = await probeProvider(baseInput, {
      fetch: fetchStub(() => jsonResponse(["model-a", { id: "model-b", tier: "free" }])),
    });

    expect(result.models).toEqual([
      { id: "model-a", name: "model-a" },
      { id: "model-b", tier: "free" },
    ]);
  });

  test("uses Ollama tags discovery and removes a trailing v1 path", async () => {
    const calls: string[] = [];
    const result = await probeProvider(
      {
        ...baseInput,
        discoveryType: "ollama",
      },
      {
        fetch: fetchStub((input) => {
          calls.push(String(input));
          return jsonResponse({
            models: [
              {
                name: "llama3.2:latest",
                modified_at: "2026-01-02T03:04:05Z",
                size: 2_000,
              },
              { model: "qwen3:8b", digest: "sha256:abc" },
            ],
          });
        }),
      },
    );

    expect(calls).toEqual(["https://models.example.test/api/tags"]);
    expect(result.models).toEqual([
      {
        id: "llama3.2:latest",
        name: "llama3.2:latest",
        modified_at: "2026-01-02T03:04:05Z",
        size: 2_000,
      },
      { id: "qwen3:8b", model: "qwen3:8b", digest: "sha256:abc" },
    ]);
    expect(byId(result.checks, "discovery").status).toBe("pass");
  });

  test("tries LiteLLM discovery endpoints in order until one succeeds", async () => {
    const calls: string[] = [];
    const result = await probeProvider(
      {
        ...baseInput,
        discoveryType: "litellm",
      },
      {
        fetch: fetchStub((input) => {
          const url = String(input);
          calls.push(url);
          if (url.endsWith("/model_group/info")) {
            return jsonResponse({ error: "missing" }, 404);
          }
          if (url.endsWith("/v2/model/info")) {
            return jsonResponse({ error: "unavailable" }, 503);
          }
          return jsonResponse({
            data: [
              { model_name: "deployment-a", provider: "openai" },
              { model_group: "group-b", max_tokens: 4_096 },
              { id: "model-c", mode: "chat" },
            ],
          });
        }),
      },
    );

    expect(calls).toEqual([
      "https://models.example.test/model_group/info",
      "https://models.example.test/v2/model/info",
      "https://models.example.test/model/info",
    ]);
    expect(result.models).toEqual([
      { id: "deployment-a", model_name: "deployment-a", provider: "openai" },
      { id: "group-b", model_group: "group-b", max_tokens: 4_096 },
      { id: "model-c", mode: "chat" },
    ]);
    expect(byId(result.checks, "discovery").status).toBe("pass");
  });

  test("classifies 401 as authentication failure without leaking the key", async () => {
    const secret = "sk-never-print-this";
    const result = await probeProvider(
      { ...baseInput, apiKey: secret, runInference: true, model: "model-a" },
      {
        fetch: fetchStub(() =>
          jsonResponse(
            { error: { message: `invalid credential ${secret}`, huge: "x".repeat(4_000) } },
            401,
          ),
        ),
      },
    );

    expect(byId(result.checks, "endpoint").status).toBe("pass");
    expect(byId(result.checks, "authentication")).toMatchObject({
      status: "fail",
      detail: "Credentials were rejected with HTTP 401",
    });
    expect(byId(result.checks, "discovery").status).toBe("skip");
    expect(byId(result.checks, "inference").status).toBe("skip");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
  });

  test("marks command-resolved discovery credentials indeterminate on 403", async () => {
    const result = await probeProvider(
      {
        ...baseInput,
        credentialsUnavailable: true,
        runInference: true,
        model: "model-a",
      },
      { fetch: fetchStub(() => jsonResponse({ error: "forbidden" }, 403)) },
    );

    expect(byId(result.checks, "authentication")).toMatchObject({
      status: "skip",
      detail: "Command-resolved credentials are not executed by this manager",
    });
    expect(byId(result.checks, "discovery").status).toBe("skip");
    expect(byId(result.checks, "inference").status).toBe("skip");
  });

  test("reports timeout and network errors at the endpoint layer", async () => {
    const timeout = await probeProvider(baseInput, {
      fetch: fetchStub(() => {
        throw new DOMException("aborted", "AbortError");
      }),
    });
    expect(byId(timeout.checks, "endpoint")).toMatchObject({
      status: "fail",
      detail: "Request timed out after 8 seconds",
    });
    expect(byId(timeout.checks, "authentication").status).toBe("skip");
    expect(byId(timeout.checks, "discovery").status).toBe("skip");

    const secret = "network-secret";
    const network = await probeProvider(
      { ...baseInput, apiKey: secret },
      {
        fetch: fetchStub(() => {
          throw new TypeError(`socket failed while using ${secret}`);
        }),
      },
    );
    expect(byId(network.checks, "endpoint").detail).toBe(
      "socket failed while using [redacted]",
    );
    expect(JSON.stringify(network)).not.toContain(secret);
  });

  test("marks command-resolved inference headers indeterminate on 401", async () => {
    const result = await probeProvider(
      {
        ...baseInput,
        credentialsUnavailable: true,
        inferenceHeaders: { "X-Model-Auth": "unavailable-command-header" },
        runInference: true,
        model: "model-a",
      },
      {
        fetch: fetchStub((input) =>
          String(input).endsWith("/models")
            ? jsonResponse({ data: [{ id: "model-a" }] })
            : jsonResponse({ error: "unauthorized" }, 401),
        ),
      },
    );

    expect(byId(result.checks, "authentication")).toMatchObject({
      status: "skip",
      detail: "Command-resolved credentials are not executed by this manager",
    });
    expect(byId(result.checks, "inference").status).toBe("fail");
  });

  test("redacts inference-only header secrets from thrown errors", async () => {
    const secret = "model-header-secret-never-print";
    const result = await probeProvider(
      {
        ...baseInput,
        model: "model-a",
        runInference: true,
        inferenceHeaders: { "X-Model-Auth": secret },
      },
      {
        fetch: fetchStub((input) => {
          if (String(input).endsWith("/models")) {
            return jsonResponse({ data: [{ id: "model-a" }] });
          }
          throw new TypeError(`inference failed while using ${secret}`);
        }),
      },
    );

    expect(byId(result.checks, "inference").status).toBe("fail");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("auto probes protocols in order and reports the detected API", async () => {
    const calls: Array<{ url: string; headers: Headers; body?: unknown }> = [];
    const result = await probeProvider(
      {
        ...baseInput,
        api: "auto",
        apiKey: "probe-key",
        headers: { "X-Route": "provider-route" },
        inferenceHeaders: { "X-Route": "model-route", "X-Model": "model-secret" },
        model: "model-a",
        runInference: true,
      },
      {
        fetch: fetchStub(async (input, init) => {
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          calls.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body,
          });
          if (String(input).endsWith("/models")) {
            return jsonResponse({ data: [{ id: "model-a" }] });
          }
          if (String(input).endsWith("/chat/completions")) {
            return jsonResponse({ error: { message: "not supported" } }, 404);
          }
          if (String(input).endsWith("/responses")) {
            return jsonResponse({ id: "response-1" });
          }
          throw new Error("Anthropic should not be attempted after detection");
        }),
      },
    );

    expect(calls.map(({ url }) => url)).toEqual([
      "https://models.example.test/v1/models",
      "https://models.example.test/v1/chat/completions",
      "https://models.example.test/v1/responses",
    ]);
    expect(calls[0]?.headers.get("x-route")).toBe("provider-route");
    expect(calls[0]?.headers.has("x-model")).toBe(false);
    expect(calls[1]?.headers.get("x-route")).toBe("model-route");
    expect(calls[1]?.headers.get("x-model")).toBe("model-secret");
    expect(calls[2]?.headers.get("x-route")).toBe("model-route");
    expect(calls[1]?.body).toMatchObject({
      model: "model-a",
      max_tokens: 1,
      stream: false,
    });
    expect(calls[2]?.body).toMatchObject({
      model: "model-a",
      max_output_tokens: 1,
      stream: false,
    });
    expect(result.detectedApi).toBe("openai-responses");
    expect(byId(result.checks, "inference").status).toBe("pass");
  });

  test("uses Anthropic headers and never sends command-style keys", async () => {
    const seenHeaders: Headers[] = [];
    await probeProvider(
      {
        ...baseInput,
        api: "anthropic-messages",
        apiKey: "!security find-generic-password -w",
      },
      {
        fetch: fetchStub((_input, init) => {
          seenHeaders.push(new Headers(init?.headers));
          return jsonResponse({ data: [] });
        }),
      },
    );

    expect(seenHeaders[0]?.get("x-api-key")).toBeNull();
    expect(seenHeaders[0]?.get("authorization")).toBeNull();
    expect(seenHeaders[0]?.get("anthropic-version")).toBe("2023-06-01");
  });

  test("authHeader true forces Bearer authorization for Anthropic", async () => {
    let headers = new Headers();
    await probeProvider(
      {
        ...baseInput,
        api: "anthropic-messages",
        apiKey: "anthropic-secret",
        authHeader: true,
      },
      {
        fetch: fetchStub((_input, init) => {
          headers = new Headers(init?.headers);
          return jsonResponse({ data: [] });
        }),
      },
    );

    expect(headers.get("authorization")).toBe("Bearer anthropic-secret");
    expect(headers.get("x-api-key")).toBeNull();
  });

  test("rejects response bodies larger than 1 MiB", async () => {
    const result = await probeProvider(baseInput, {
      fetch: fetchStub(() =>
        new Response("not read", {
          headers: { "content-length": String(1024 * 1024 + 1) },
        }),
      ),
    });

    expect(byId(result.checks, "endpoint")).toMatchObject({
      status: "fail",
      detail: "Response body exceeded the 1 MiB limit",
    });
    expect(byId(result.checks, "discovery").status).toBe("skip");
  });

  test("rejects non-HTTP base URLs before fetch", async () => {
    let called = false;
    await expect(
      probeProvider(
        { ...baseInput, baseUrl: "file:///tmp/models", api: "auto" },
        {
          fetch: fetchStub(() => {
            called = true;
            return jsonResponse({ data: [] });
          }),
        },
      ),
    ).rejects.toThrow("baseUrl must use HTTP or HTTPS");
    expect(called).toBe(false);
  });
});
