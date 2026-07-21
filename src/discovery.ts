import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { defaultModelsPath } from "./config-store";

export interface DiscoveryInput {
  providerId?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  authHeader?: boolean | string;
  discoveryType?: string;
  headers?: Record<string, string>;
  configuredModels?: unknown[];
}

export interface SelectableModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinking?: Record<string, unknown>;
  input?: Array<"text" | "image">;
  supportsTools?: boolean;
  omitMaxOutputTokens?: boolean;
  premiumMultiplier?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  compat?: Record<string, unknown>;
  contextPromotionTarget?: string;
  compactionModel?: string;
  remoteCompaction?: Record<string, unknown>;
}

export interface DiscoveryAttempt {
  url: string;
  status?: number;
  detail: string;
}

export interface DiscoveryResult {
  models: SelectableModel[];
  source: "remote" | "omp-registry" | "configured";
  attempts: DiscoveryAttempt[];
  warning?: string;
}

export type DiscoveryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DiscoveryOptions {
  fetch?: DiscoveryFetch;
  loadOmpModels?: (providerId: string) => Promise<unknown[]>;
}

type DiscoveryFormat = "openai" | "ollama" | "litellm";

interface DiscoveryTarget {
  url: string;
  format: DiscoveryFormat;
}

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const OMP_TIMEOUT_MS = 10_000;
const THINKING_FIELDS = new Set([
  "mode",
  "efforts",
  "defaultLevel",
  "effortMap",
  "supportsDisplay",
  "minLevel",
  "maxLevel",
  "levels",
]);
const COMPAT_FIELDS = new Set([
  "supportsStore",
  "supportsDeveloperRole",
  "supportsMultipleSystemMessages",
  "supportsReasoningEffort",
  "reasoningEffortMap",
  "maxTokensField",
  "supportsUsageInStreaming",
  "requiresToolResultName",
  "requiresMistralToolIds",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "reasoningContentField",
  "requiresReasoningContentForToolCalls",
  "allowsSyntheticReasoningContentForToolCalls",
  "requiresAssistantContentForToolCalls",
  "supportsToolChoice",
  "supportsForcedToolChoice",
  "disableReasoningOnForcedToolChoice",
  "disableReasoningOnToolChoice",
  "thinkingFormat",
  "openRouterRouting",
  "vercelGatewayRouting",
  "extraBody",
  "cacheControlFormat",
  "supportsStrictMode",
  "toolStrictMode",
  "streamIdleTimeoutMs",
  "supportsLongPromptCacheRetention",
  "supportsReasoningParams",
  "alwaysSendMaxTokens",
  "strictResponsesPairing",
  "supportsImageDetailOriginal",
  "supportsEagerToolInputStreaming",
  "allowAnthropicHeaderOverrides",
  "requiresToolResultId",
  "replayUnsignedThinking",
  "whenThinking",
]);
const REMOTE_COMPACTION_FIELDS = new Set([
  "enabled",
  "api",
  "endpoint",
  "model",
  "v2StreamingEnabled",
  "v2Endpoint",
  "streamingEndpoint",
]);

export async function discoverModels(
  input: DiscoveryInput,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const attempts: DiscoveryAttempt[] = [];
  const fetchImpl = options.fetch ?? fetch;
  const targets = discoveryTargets(input.baseUrl, input.discoveryType);
  const headerVariants = discoveryHeaderVariants(input);

  for (const target of targets) {
    for (const headers of headerVariants) {
      try {
        const response = await fetchWithTimeout(fetchImpl, target.url, headers);
        if (!response.response.ok) {
          attempts.push({
            url: target.url,
            status: response.response.status,
            detail: `HTTP ${response.response.status}`,
          });
          continue;
        }

        try {
          let models = parseSelectableModels(response.text, target.format);
          if (models.length === 0) {
            attempts.push({
              url: target.url,
              status: response.response.status,
              detail: "响应中的模型列表为空",
            });
            continue;
          }
          if (input.providerId) {
            try {
              const registryModels = projectModels(
                await (options.loadOmpModels ?? loadOmpModels)(input.providerId),
              );
              const registryById = new Map(registryModels.map((model) => [model.id, model]));
              models = models.map((model) => {
                const registryModel = registryById.get(model.id);
                return registryModel ? { ...model, ...registryModel, id: model.id } : model;
              });
            } catch {
              // Remote discovery remains useful without registry enrichment.
            }
          }
          attempts.push({
            url: target.url,
            status: response.response.status,
            detail: `发现 ${models.length} 个模型`,
          });
          return { models, source: "remote", attempts };
        } catch {
          attempts.push({
            url: target.url,
            status: response.response.status,
            detail: "响应不是兼容的模型列表",
          });
        }
      } catch (error) {
        attempts.push({
          url: target.url,
          detail: safeErrorMessage(error),
        });
      }
    }
  }

  if (input.providerId) {
    try {
      const rawModels = await (options.loadOmpModels ?? loadOmpModels)(input.providerId);
      const models = projectModels(rawModels);
      if (models.length > 0) {
        return {
          models,
          source: "omp-registry",
          attempts,
          warning: `远程模型发现失败（已尝试 ${attempts.length} 次）；当前列表来自 OMP Registry。`,
        };
      }
    } catch {
      // Continue to the static models.yml fallback.
    }
  }

  const configured = projectModels(input.configuredModels ?? []);
  if (configured.length > 0) {
    return {
      models: configured,
      source: "configured",
      attempts,
      warning: `远程模型发现失败（已尝试 ${attempts.length} 次）；当前列表来自 models.yml。`,
    };
  }

  return {
    models: [],
    source: "configured",
    attempts,
    warning: `未找到可用模型；已尝试 ${attempts.length} 个兼容端点，OMP Registry 和 models.yml 也没有可回退的模型。`,
  };
}

function discoveryTargets(baseUrl: string, discoveryType?: string): DiscoveryTarget[] {
  const normalized = new URL(baseUrl);
  if (normalized.protocol !== "http:" && normalized.protocol !== "https:") {
    throw new Error("Base URL must use HTTP or HTTPS");
  }
  normalized.search = "";
  normalized.hash = "";
  normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";
  const type = discoveryType?.trim().toLowerCase();

  if (type === "ollama") {
    const root = new URL(normalized);
    root.pathname = root.pathname.replace(/\/v1$/i, "") || "/";
    return [{ url: withPath(root, `${root.pathname}/api/tags`), format: "ollama" }];
  }

  if (type === "litellm") {
    const root = new URL(normalized);
    root.pathname = root.pathname.replace(/\/v1$/i, "") || "/";
    return uniqueTargets([
      { url: withPath(root, `${root.pathname}/model_group/info`), format: "litellm" },
      { url: withPath(root, `${root.pathname}/v2/model/info`), format: "litellm" },
      { url: withPath(root, `${root.pathname}/model/info`), format: "litellm" },
      { url: withPath(root, `${root.pathname}/v1/model/info`), format: "litellm" },
    ]);
  }

  const targets: DiscoveryTarget[] = [];
  const add = (pathname: string) => {
    targets.push({ url: withPath(normalized, pathname), format: "openai" });
  };
  const path = normalized.pathname.replace(/\/+$/, "");
  add(`${path}/models`);

  const withoutEndpoint = path.replace(/\/(?:messages|responses|chat\/completions)$/i, "");
  if (withoutEndpoint !== path) add(`${withoutEndpoint}/models`);

  const withoutSurface = withoutEndpoint.replace(/\/(?:anthropic|coding)$/i, "");
  if (withoutSurface !== withoutEndpoint) add(`${withoutSurface}/models`);

  add("/v1/models");
  add("/models");
  return uniqueTargets(targets);
}

function uniqueTargets(targets: DiscoveryTarget[]): DiscoveryTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.url)) return false;
    seen.add(target.url);
    return true;
  });
}

function withPath(base: URL, pathname: string): string {
  const url = new URL(base.origin);
  url.pathname = pathname.replace(/\/+/g, "/");
  return url.toString().replace(/\/$/, "");
}

function discoveryHeaderVariants(input: DiscoveryInput): Headers[] {
  const configured = new Headers({ Accept: "application/json" });
  const key = usableKey(input.apiKey);
  if (key) {
    const explicitName = typeof input.authHeader === "string" ? input.authHeader.trim() : "";
    const headerName = explicitName || (input.authHeader === true || input.api !== "anthropic-messages"
      ? "Authorization"
      : "x-api-key");
    configured.set(headerName, headerName.toLowerCase() === "authorization" ? `Bearer ${key}` : key);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!value.trimStart().startsWith("!")) configured.set(name, value);
  }

  const variants = [configured];
  if (!key || hasExplicitCredentialHeader(input.headers)) return variants;

  const alternate = new Headers(configured);
  if (configured.has("authorization")) {
    alternate.delete("authorization");
    alternate.set("x-api-key", key);
  } else {
    alternate.delete("x-api-key");
    alternate.set("authorization", `Bearer ${key}`);
  }
  variants.push(alternate);
  return variants;
}

function hasExplicitCredentialHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => {
    const normalized = name.toLowerCase();
    return normalized === "authorization" || normalized === "x-api-key" || normalized === "api-key";
  });
}

function usableKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  return key && !key.startsWith("!") ? key : undefined;
}

async function fetchWithTimeout(
  fetchImpl: DiscoveryFetch,
  url: string,
  headers: Headers,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    return { response, text: await readLimitedStream(response.body, response.headers.get("content-length")) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedStream(
  stream: ReadableStream<Uint8Array> | null,
  contentLength: string | null = null,
): Promise<string> {
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await stream?.cancel();
    throw new Error("响应超过 1 MiB 限制");
  }
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("响应超过 1 MiB 限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseSelectableModels(text: string, format: DiscoveryFormat): SelectableModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid JSON");
  }

  let entries: unknown[] | undefined;
  if (Array.isArray(parsed)) entries = parsed;
  else if (isRecord(parsed)) {
    if (Array.isArray(parsed.data)) entries = parsed.data;
    else if (Array.isArray(parsed.models)) entries = parsed.models;
    else if (format === "litellm" && Array.isArray(parsed.model_groups)) entries = parsed.model_groups;
    else if (isRecord(parsed.data) && Array.isArray(parsed.data.models)) entries = parsed.data.models;
  }
  if (!entries) throw new Error("missing model array");
  return projectModels(entries, format);
}

function projectModels(values: unknown[], format: DiscoveryFormat = "openai"): SelectableModel[] {
  const models: SelectableModel[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const model = projectModel(value, format);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function projectModel(value: unknown, format: DiscoveryFormat): SelectableModel | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, name: id } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const id = firstString(
    value.id,
    format === "ollama" ? value.model : undefined,
    format === "litellm" ? value.model_name : undefined,
    format === "litellm" ? value.model_group : undefined,
    value.name,
    value.model,
  );
  if (!id) return undefined;

  const model: SelectableModel = { id };
  const name = firstString(value.name, value.display_name, value.model_name, value.model_group);
  if (name) model.name = name;
  const contextWindow = firstPositiveNumber(
    value.contextWindow,
    value.context_length,
    value.max_model_len,
    value.max_context_length,
  );
  if (contextWindow) model.contextWindow = contextWindow;
  const maxTokens = firstPositiveNumber(value.maxTokens, value.max_tokens, value.max_output_tokens);
  if (maxTokens) model.maxTokens = maxTokens;
  if (typeof value.reasoning === "boolean") model.reasoning = value.reasoning;
  const api = firstString(value.api);
  if (api) model.api = api;
  const baseUrl = firstString(value.baseUrl);
  if (baseUrl) model.baseUrl = baseUrl;
  if (Array.isArray(value.input)) {
    const input = value.input.filter((item): item is "text" | "image" => item === "text" || item === "image");
    if (input.length > 0) model.input = [...new Set(input)];
  }
  if (isCompleteCost(value.cost)) model.cost = structuredClone(value.cost);
  if (typeof value.supportsTools === "boolean") model.supportsTools = value.supportsTools;
  if (typeof value.omitMaxOutputTokens === "boolean") {
    model.omitMaxOutputTokens = value.omitMaxOutputTokens;
  }
  if (
    typeof value.premiumMultiplier === "number" &&
    Number.isFinite(value.premiumMultiplier) &&
    value.premiumMultiplier >= 0
  ) {
    model.premiumMultiplier = value.premiumMultiplier;
  }
  const thinking = projectKnownRecord(value.thinking, THINKING_FIELDS);
  if (thinking) model.thinking = thinking;
  const compat = projectKnownRecord(value.compat, COMPAT_FIELDS);
  if (compat) model.compat = compat;
  const remoteCompaction = projectKnownRecord(value.remoteCompaction, REMOTE_COMPACTION_FIELDS);
  if (remoteCompaction) model.remoteCompaction = remoteCompaction;
  for (const field of ["contextPromotionTarget", "compactionModel"] as const) {
    const text = firstString(value[field]);
    if (text) model[field] = text;
  }
  return model;
}

function isCompleteCost(value: unknown): value is SelectableModel["cost"] {
  if (!isRecord(value)) return false;
  return ["input", "output", "cacheRead", "cacheWrite"].every((field) => {
    const amount = value[field];
    return typeof amount === "number" && Number.isFinite(amount) && amount >= 0;
  });
}
function projectKnownRecord(
  value: unknown,
  allowedFields: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const projected = Object.fromEntries(
    Object.entries(value)
      .filter(([field]) => allowedFields.has(field))
      .map(([field, fieldValue]) => [field, structuredClone(fieldValue)]),
  );
  return Object.keys(projected).length > 0 ? projected : undefined;
}


export function loadCachedOmpModels(
  providerId: string,
  databasePath = join(dirname(defaultModelsPath()), "models.db"),
): unknown[] {
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true });
    const row = database.query(`
      SELECT models
      FROM model_cache
      WHERE provider_id = ?1 OR provider_id LIKE ?2
      ORDER BY CASE WHEN provider_id = ?1 THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).get(providerId, `${providerId}:%`) as { models?: unknown } | null;
    if (!row || typeof row.models !== "string") return [];
    const parsed: unknown = JSON.parse(row.models);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

async function loadOmpModels(providerId: string): Promise<unknown[]> {
  const cached = loadCachedOmpModels(providerId);
  if (cached.length > 0) return cached;
  const process = Bun.spawn(["omp", "models", providerId, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => process.kill(), OMP_TIMEOUT_MS);
  try {
    const output = await readLimitedStream(process.stdout as ReadableStream<Uint8Array>);
    const exitCode = await process.exited;
    if (exitCode !== 0) return [];
    const parsed: unknown = JSON.parse(output);
    return isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
  } finally {
    clearTimeout(timeout);
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "请求超时";
    if (/timeout|超时/i.test(error.message)) return "请求超时";
  }
  return "请求失败";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
