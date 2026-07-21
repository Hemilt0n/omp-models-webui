import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverModels,
  loadCachedOmpModels,
  type DiscoveryFetch,
} from "../src/discovery";

describe("model discovery", () => {
  test("tries normalized same-origin paths and compatible authentication formats", async () => {
    const calls: Array<{ url: string; authorization: string | null; apiKey: string | null }> = [];
    const fetchStub: DiscoveryFetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
      });

      if (url === "https://gateway.example/v1/messages/models") {
        return Response.json({ status: "ok" });
      }
      if (url === "https://gateway.example/v1/models" && headers.has("authorization")) {
        return Response.json({ error: "wrong authentication format" }, { status: 401 });
      }
      if (url === "https://gateway.example/v1/models" && headers.get("x-api-key") === "secret") {
        return Response.json({
          data: [
            {
              id: "model-a",
              name: "Model A",
              context_length: 128_000,
              unsupported: "must not reach models.yml",
            },
          ],
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    };

    const result = await discoverModels({
      baseUrl: "https://gateway.example/v1/messages?token=must-not-leak",
      api: "anthropic-messages",
      apiKey: "secret",
      authHeader: true,
    }, { fetch: fetchStub, loadOmpModels: async () => [] });

    expect(result.source).toBe("remote");
    expect(result.models).toEqual([{ id: "model-a", name: "Model A", contextWindow: 128_000 }]);
    expect(calls.map(({ url }) => url)).toContain("https://gateway.example/v1/messages/models");
    expect(calls.map(({ url }) => url)).toContain("https://gateway.example/v1/models");
    expect(calls.some(({ apiKey }) => apiKey === "secret")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  test("falls back to the OMP registry and labels the source", async () => {
    const result = await discoverModels({
      providerId: "workbuddy",
      baseUrl: "https://gateway.example/anthropic",
      api: "anthropic-messages",
    }, {
      fetch: async () => Response.json({ error: "missing" }, { status: 404 }),
      loadOmpModels: async (providerId) => [
        { id: `${providerId}-model`, reasoning: true, privateField: "discard" },
      ],
    });

    expect(result.source).toBe("omp-registry");
    expect(result.models).toEqual([{ id: "workbuddy-model", reasoning: true }]);
    expect(result.warning).toContain("OMP Registry");
    expect(result.attempts.length).toBeGreaterThan(0);
  });

  test("falls back to configured models when remote and registry discovery fail", async () => {
    const result = await discoverModels({
      providerId: "custom",
      baseUrl: "https://gateway.example/coding",
      api: "anthropic-messages",
      configuredModels: [
        {
          id: "configured-model",
          maxTokens: 8192,
          headers: { Authorization: "must-not-copy" },
          compat: { supportsDeveloperRole: false },
        },
      ],
    }, {
      fetch: async () => Response.json({ unexpected: [] }),
      loadOmpModels: async () => [],
    });

    expect(result.source).toBe("configured");
    expect(result.models).toEqual([{
      id: "configured-model",
      maxTokens: 8192,
      compat: { supportsDeveloperRole: false },
    }]);
    expect(result.warning).toContain("models.yml");
    expect(JSON.stringify(result)).not.toContain("must-not-copy");
  });

  test("uses complete OMP cache metadata including per-model API overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-model-cache-"));
    const databasePath = join(directory, "models.db");
    const database = new Database(databasePath, { create: true });
    database.exec(`
      CREATE TABLE model_cache (
        provider_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        models TEXT NOT NULL
      )
    `);
    database.query(
      "INSERT INTO model_cache (provider_id, updated_at, models) VALUES (?, ?, ?)",
    ).run("mixed:models-v1:hash", 2, JSON.stringify([
      {
        id: "anthropic-model",
        name: "Anthropic Model",
        provider: "must-not-copy",
        api: "anthropic-messages",
        baseUrl: "https://gateway.example/anthropic",
        contextWindow: 200000,
        maxTokens: 8192,
        reasoning: true,
        thinking: {
          mode: "anthropic-adaptive",
          efforts: ["low", "medium", "high"],
          effortMap: { low: "adaptive", medium: "adaptive", high: "adaptive" },
          requiresEffort: true,
        },
        compat: { supportsToolChoice: false },
      },
    ]));
    database.close();

    try {
      const result = await discoverModels({
        providerId: "mixed",
        baseUrl: "https://gateway.example/v1",
        api: "openai-completions",
      }, {
        fetch: async () => Response.json({ error: "missing" }, { status: 404 }),
        loadOmpModels: async (providerId) => loadCachedOmpModels(providerId, databasePath),
      });

      expect(result.source).toBe("omp-registry");
      expect(result.models).toEqual([{
        id: "anthropic-model",
        name: "Anthropic Model",
        api: "anthropic-messages",
        baseUrl: "https://gateway.example/anthropic",
        contextWindow: 200000,
        maxTokens: 8192,
        reasoning: true,
        thinking: {
          mode: "anthropic-adaptive",
          efforts: ["low", "medium", "high"],
          effortMap: { low: "adaptive", medium: "adaptive", high: "adaptive" },
        },
        compat: { supportsToolChoice: false },
      }]);
      expect(JSON.stringify(result)).not.toContain("must-not-copy");
      expect(JSON.stringify(result)).not.toContain("requiresEffort");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
