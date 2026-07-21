export type ProbeApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "auto";

export interface ProbeInput {
  providerId?: string;
  baseUrl: string;
  api: ProbeApi;
  apiKey?: string;
  authHeader?: boolean | string;
  headers?: Record<string, string>;
  inferenceHeaders?: Record<string, string>;
  credentialsUnavailable?: boolean;
  discoveryType?: string;
  model?: string;
  runInference?: boolean;
}

const COMMAND_CREDENTIAL_DETAIL =
  "Command-resolved credentials are not executed by this manager";

export interface ProbeCheck {
  id: "endpoint" | "authentication" | "discovery" | "inference";
  label: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  latencyMs?: number;
}

export interface DiscoveredModel extends Record<string, unknown> {
  id: string;
  name?: string;
}

export interface ProbeResult {
  checks: ProbeCheck[];
  models: DiscoveredModel[];
  detectedApi?: Exclude<ProbeApi, "auto">;
  durationMs: number;
}

export interface ProbeOptions {
  fetch?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_DETAIL_LENGTH = 300;

const LABELS: Record<ProbeCheck["id"], string> = {
  endpoint: "Endpoint",
  authentication: "Authentication",
  discovery: "Model discovery",
  inference: "Inference",
};

class ResponseTooLargeError extends Error {
  constructor() {
    super("Response body exceeded the 1 MiB limit");
    this.name = "ResponseTooLargeError";
  }
}

class RequestTimeoutError extends Error {
  constructor() {
    super("Request timed out after 8 seconds");
    this.name = "RequestTimeoutError";
  }
}

interface RequestResult {
  response: Response;
  text: string;
  latencyMs: number;
}

interface InferenceAttempt {
  api: Exclude<ProbeApi, "auto">;
  result?: RequestResult;
  error?: unknown;
}

type DiscoveryFormat = "openai" | "ollama" | "litellm";

interface DiscoveryTarget {
  url: string;
  format: DiscoveryFormat;
}

export async function probeProvider(
  input: ProbeInput,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const startedAt = performance.now();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const apiKey = usableApiKey(input.apiKey);
  const detailSecrets = [
    input.apiKey,
    ...Object.values(input.headers ?? {}),
    ...Object.values(input.inferenceHeaders ?? {}),
  ].filter((value): value is string => Boolean(value));
  const checks: ProbeCheck[] = [];
  let models: DiscoveredModel[] = [];
  let discoveryResult: RequestResult | undefined;
  let discoveryTarget: DiscoveryTarget | undefined;

  try {
    for (const target of discoveryTargets(baseUrl, input.discoveryType)) {
      const result = await request(fetchImpl, target.url, {
        method: "GET",
        headers: requestHeaders(
          input.api === "auto" ? "openai-completions" : input.api,
          apiKey,
          input.authHeader,
          input.headers,
        ),
      });
      discoveryResult = result;
      discoveryTarget = target;
      if (
        result.response.ok ||
        isAuthenticationFailure(result.response.status)
      ) {
        break;
      }
    }
    if (!discoveryResult || !discoveryTarget) {
      throw new Error("No model discovery endpoint was available");
    }
  } catch (error) {
    checks.push(
      check("endpoint", "fail", safeErrorDetail(error, detailSecrets)),
      check("authentication", "skip", "Endpoint could not be reached"),
      check("discovery", "skip", "Endpoint could not be reached"),
      check("inference", "skip", inferenceSkipReason(input, "Endpoint could not be reached")),
    );
    return finish(checks, models, startedAt);
  }

  checks.push(
    check(
      "endpoint",
      "pass",
      `Endpoint responded with HTTP ${discoveryResult.response.status}`,
      discoveryResult.latencyMs,
    ),
  );

  if (isAuthenticationFailure(discoveryResult.response.status)) {
    const credentialsUnavailable = input.credentialsUnavailable === true;
    const authenticationDetail = credentialsUnavailable
      ? COMMAND_CREDENTIAL_DETAIL
      : `Credentials were rejected with HTTP ${discoveryResult.response.status}`;
    const skipReason = credentialsUnavailable
      ? "Command-resolved credentials were unavailable"
      : "Authentication failed";
    checks.push(
      check(
        "authentication",
        credentialsUnavailable ? "skip" : "fail",
        authenticationDetail,
        discoveryResult.latencyMs,
      ),
      check("discovery", "skip", skipReason),
      check("inference", "skip", inferenceSkipReason(input, skipReason)),
    );
    return finish(checks, models, startedAt);
  }

  if (!discoveryResult.response.ok) {
    checks.push(
      check(
        "authentication",
        "skip",
        `Authentication could not be determined from HTTP ${discoveryResult.response.status}`,
        discoveryResult.latencyMs,
      ),
      check(
        "discovery",
        "fail",
        responseFailureDetail(discoveryResult, detailSecrets),
        discoveryResult.latencyMs,
      ),
    );
  } else {
    checks.push(
      check(
        "authentication",
        "pass",
        apiKey ? "Credentials were not rejected" : "Endpoint did not require credentials",
        discoveryResult.latencyMs,
      ),
    );
    try {
      models = parseModels(discoveryResult.text, discoveryTarget.format);
      checks.push(
        check(
          "discovery",
          "pass",
          `Discovered ${models.length} model${models.length === 1 ? "" : "s"}`,
          discoveryResult.latencyMs,
        ),
      );
    } catch (error) {
      checks.push(
        check(
          "discovery",
          "fail",
          safeErrorDetail(error, detailSecrets),
          discoveryResult.latencyMs,
        ),
      );
    }
  }

  if (!input.runInference) {
    checks.push(check("inference", "skip", "Inference probe is disabled"));
    return finish(checks, models, startedAt);
  }

  const model = input.model?.trim();
  if (!model) {
    checks.push(check("inference", "skip", "No model was selected"));
    return finish(checks, models, startedAt);
  }

  const apis: Exclude<ProbeApi, "auto">[] =
    input.api === "auto"
      ? ["openai-completions", "openai-responses", "anthropic-messages"]
      : [input.api];
  const attempts: InferenceAttempt[] = [];

  for (const api of apis) {
    try {
      const result = await request(fetchImpl, inferenceUrl(baseUrl, api), {
        method: "POST",
        headers: requestHeaders(
          api,
          apiKey,
          input.authHeader,
          input.inferenceHeaders ?? input.headers,
        ),
        body: JSON.stringify(inferenceBody(api, model)),
      });
      attempts.push({ api, result });
      if (result.response.ok) {
        checks.push(
          check(
            "inference",
            "pass",
            `Minimal ${api} request succeeded`,
            result.latencyMs,
          ),
        );
        return finish(checks, models, startedAt, input.api === "auto" ? api : undefined);
      }
    } catch (error) {
      attempts.push({ api, error });
    }
  }

  const authenticationAttempt = attempts.find(
    (attempt) =>
      attempt.result && isAuthenticationFailure(attempt.result.response.status),
  );
  if (authenticationAttempt?.result) {
    const authenticationIndex = checks.findIndex(
      (candidate) => candidate.id === "authentication",
    );
    checks[authenticationIndex] = check(
      "authentication",
      input.credentialsUnavailable ? "skip" : "fail",
      input.credentialsUnavailable
        ? COMMAND_CREDENTIAL_DETAIL
        : `Credentials were rejected with HTTP ${authenticationAttempt.result.response.status}`,
      authenticationAttempt.result.latencyMs,
    );
  }

  checks.push(
    check(
      "inference",
      "fail",
      inferenceFailureDetail(attempts, detailSecrets),
      attempts.at(-1)?.result?.latencyMs,
    ),
  );
  return finish(checks, models, startedAt);
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("baseUrl must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("baseUrl must use HTTP or HTTPS");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function usableApiKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  if (!key || key.startsWith("!")) return undefined;
  return key;
}

function requestHeaders(
  api: Exclude<ProbeApi, "auto">,
  apiKey: string | undefined,
  authHeader: boolean | string | undefined,
  configuredHeaders: Record<string, string> | undefined,
): Headers {
  const headers = new Headers({ Accept: "application/json" });
  if (apiKey) {
    const customHeader = typeof authHeader === "string" ? authHeader.trim() : "";
    const headerName =
      customHeader ||
      (authHeader === true
        ? "Authorization"
        : api === "anthropic-messages"
          ? "x-api-key"
          : "Authorization");
    headers.set(
      headerName,
      headerName.toLowerCase() === "authorization"
        ? `Bearer ${apiKey}`
        : apiKey,
    );
  }
  if (api === "anthropic-messages") {
    headers.set("anthropic-version", "2023-06-01");
  }
  headers.set("Content-Type", "application/json");
  for (const [name, value] of Object.entries(configuredHeaders ?? {})) {
    if (!value.trimStart().startsWith("!")) headers.set(name, value);
  }
  return headers;
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<RequestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await readLimitedText(response);
    return { response, text, latencyMs: elapsed(startedAt) };
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new RequestTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ResponseTooLargeError();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ResponseTooLargeError();
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

function discoveryTargets(
  baseUrl: string,
  discoveryType: string | undefined,
): DiscoveryTarget[] {
  const type = discoveryType?.trim().toLowerCase();
  if (type === "ollama") {
    const root = baseUrl.replace(/\/v1$/i, "");
    return [{ url: `${root}/api/tags`, format: "ollama" }];
  }
  if (type === "litellm") {
    const root = baseUrl.replace(/\/v1$/i, "");
    return [
      { url: `${root}/model_group/info`, format: "litellm" },
      { url: `${root}/v2/model/info`, format: "litellm" },
      { url: `${root}/model/info`, format: "litellm" },
      { url: `${root}/v1/model/info`, format: "litellm" },
    ];
  }
  return [{ url: `${baseUrl}/models`, format: "openai" }];
}

function parseModels(
  text: string,
  format: DiscoveryFormat,
): DiscoveredModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Model discovery returned invalid JSON");
  }

  let entries: unknown[] | undefined;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (isRecord(parsed)) {
    if (format === "ollama" && Array.isArray(parsed.models)) {
      entries = parsed.models;
    } else if (Array.isArray(parsed.data)) {
      entries = parsed.data;
    } else if (format === "litellm" && Array.isArray(parsed.models)) {
      entries = parsed.models;
    } else if (format === "litellm" && Array.isArray(parsed.model_groups)) {
      entries = parsed.model_groups;
    }
  }
  if (!entries) {
    throw new Error("Model discovery response did not contain a model array");
  }

  const models: DiscoveredModel[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.trim()) {
      models.push({ id: entry, name: entry });
      continue;
    }
    if (!isRecord(entry)) continue;

    let id: string | undefined;
    if (format === "ollama") {
      id =
        stringField(entry.name) ??
        stringField(entry.model) ??
        stringField(entry.id);
    } else if (format === "litellm") {
      id =
        stringField(entry.model_name) ??
        stringField(entry.model_group) ??
        stringField(entry.id) ??
        stringField(entry.name) ??
        stringField(entry.model);
    } else {
      id = stringField(entry.id) ?? stringField(entry.name);
    }
    if (!id) continue;
    models.push({ ...entry, id });
  }
  return models;
}

function inferenceUrl(
  baseUrl: string,
  api: Exclude<ProbeApi, "auto">,
): string {
  if (api === "openai-completions") return `${baseUrl}/chat/completions`;
  if (api === "openai-responses") return `${baseUrl}/responses`;
  return `${baseUrl}/messages`;
}

function inferenceBody(
  api: Exclude<ProbeApi, "auto">,
  model: string,
): Record<string, unknown> {
  if (api === "openai-responses") {
    return { model, input: "Reply with OK.", max_output_tokens: 1, stream: false };
  }
  if (api === "anthropic-messages") {
    return {
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "Reply with OK." }],
      stream: false,
    };
  }
  return {
    model,
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 1,
    stream: false,
  };
}

function responseFailureDetail(
  result: RequestResult,
  secrets: readonly string[],
): string {
  const message = responseMessage(result.text);
  return sanitizeDetail(
    `Model discovery returned HTTP ${result.response.status}${message ? `: ${message}` : ""}`,
    secrets,
  );
}

function responseMessage(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.message === "string") return parsed.message;
    if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    return undefined;
  }
  return undefined;
}

function inferenceFailureDetail(
  attempts: InferenceAttempt[],
  secrets: readonly string[],
): string {
  const summaries = attempts.map((attempt) => {
    if (attempt.result) {
      return `${attempt.api}: HTTP ${attempt.result.response.status}`;
    }
    return `${attempt.api}: ${safeErrorDetail(attempt.error, secrets)}`;
  });
  return sanitizeDetail(summaries.join("; "), secrets);
}

function inferenceSkipReason(input: ProbeInput, fallback: string): string {
  if (!input.runInference) return "Inference probe is disabled";
  if (!input.model?.trim()) return "No model was selected";
  return fallback;
}

function check(
  id: ProbeCheck["id"],
  status: ProbeCheck["status"],
  detail: string,
  latencyMs?: number,
): ProbeCheck {
  return {
    id,
    label: LABELS[id],
    status,
    detail,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
}

function finish(
  checks: ProbeCheck[],
  models: DiscoveredModel[],
  startedAt: number,
  detectedApi?: Exclude<ProbeApi, "auto">,
): ProbeResult {
  return {
    checks,
    models,
    ...(detectedApi ? { detectedApi } : {}),
    durationMs: elapsed(startedAt),
  };
}

function safeErrorDetail(error: unknown, secrets: readonly string[]): string {
  if (error instanceof RequestTimeoutError || isAbortError(error)) {
    return "Request timed out after 8 seconds";
  }
  if (error instanceof ResponseTooLargeError) return error.message;
  const message = error instanceof Error ? error.message : "Network request failed";
  return sanitizeDetail(message || "Network request failed", secrets);
}

function sanitizeDetail(detail: string, secrets: readonly string[]): string {
  let safe = detail.replace(/[\r\n\t]+/g, " ");
  for (const secret of secrets) {
    safe = safe.split(secret).join("[redacted]");
  }
  return safe.length > MAX_DETAIL_LENGTH
    ? `${safe.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : safe;
}

function isAuthenticationFailure(status: number): boolean {
  return status === 401 || status === 403;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError" || error.name === "TimeoutError"
    : error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
