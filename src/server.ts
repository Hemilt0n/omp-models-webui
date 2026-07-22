import { join } from "node:path";
import {
  ConfigStore,
  ConfigStoreError,
  RevisionConflictError,
  SECRET_SENTINEL,
  isValidProviderId,
  type PutProviderInput,
} from "./config-store";
import {
  probeProvider,
  type ProbeInput,
  type ProbeResult,
} from "./probe";
import {
  discoverModels,
  type DiscoveryInput,
  type DiscoveryResult,
} from "./discovery";

const PROVIDER_API_VALUES = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
]);
const PROBE_API_VALUES = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "auto",
]);
const DISCOVERY_VALUES = new Set([
  "ollama",
  "llama.cpp",
  "lm-studio",
  "openai-models-list",
  "proxy",
  "litellm",
]);
const AUTH_VALUES = new Set(["apiKey", "none", "oauth"]);
const MODEL_INPUT_VALUES: Record<string, true> = { text: true, image: true };
const MODEL_COST_FIELDS: Record<string, true> = {
  input: true,
  output: true,
  cacheRead: true,
  cacheWrite: true,
};
const PUBLIC_DIRECTORY = join(import.meta.dir, "..", "public");

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function containsApiKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsApiKey);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, item]) => key === "apiKey" || containsApiKey(item));
}

function validateHeaders(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new HttpError(400, `${path} must be an object`);
  for (const [name, headerValue] of Object.entries(value)) {
    if (!name || typeof headerValue !== "string") {
      throw new HttpError(400, `${path} values must be strings`);
    }
  }
}

function validateProviderDefinition(
  definition: Record<string, unknown>,
  apiKeyConfigured: boolean,
): void {
  if (definition.baseUrl !== undefined) {
    if (typeof definition.baseUrl !== "string" || !definition.baseUrl.trim()) {
      throw new HttpError(400, "definition.baseUrl must be a non-empty string");
    }
  }
  if (definition.api !== undefined) {
    if (typeof definition.api !== "string" || !PROVIDER_API_VALUES.has(definition.api)) {
      throw new HttpError(400, "definition.api is invalid");
    }
  }
  if (definition.auth !== undefined) {
    if (typeof definition.auth !== "string" || !AUTH_VALUES.has(definition.auth)) {
      throw new HttpError(400, "definition.auth is invalid");
    }
  }
  for (const field of ["authHeader", "disableStrictTools"] as const) {
    if (definition[field] !== undefined && typeof definition[field] !== "boolean") {
      throw new HttpError(400, `definition.${field} must be a boolean`);
    }
  }
  if (definition.headers !== undefined) validateHeaders(definition.headers, "definition.headers");
  for (const field of ["compat", "modelOverrides", "remoteCompaction"] as const) {
    if (definition[field] !== undefined && !isPlainObject(definition[field])) {
      throw new HttpError(400, `definition.${field} must be an object`);
    }
  }

  if (definition.discovery !== undefined) {
    if (!isPlainObject(definition.discovery)) {
      throw new HttpError(400, "definition.discovery must be an object");
    }
    if (
      typeof definition.discovery.type !== "string" ||
      !DISCOVERY_VALUES.has(definition.discovery.type)
    ) {
      throw new HttpError(400, "definition.discovery.type is invalid");
    }
    if (definition.discovery.type !== "proxy" && definition.api === undefined) {
      throw new HttpError(400, "definition.api is required for this discovery type");
    }
  }

  if (definition.models !== undefined) {
    if (!Array.isArray(definition.models)) {
      throw new HttpError(400, "definition.models must be an array");
    }
    const modelIds = new Set<string>();
    for (const [index, model] of definition.models.entries()) {
      const path = `definition.models[${index}]`;
      if (!isPlainObject(model)) throw new HttpError(400, `${path} must be an object`);
      if (typeof model.id !== "string" || !model.id.trim()) {
        throw new HttpError(400, `${path}.id must be a non-empty string`);
      }
      if (modelIds.has(model.id)) {
        throw new HttpError(400, `definition.models contains duplicate id: ${model.id}`);
      }
      modelIds.add(model.id);
      if (model.api !== undefined) {
        if (typeof model.api !== "string" || !PROVIDER_API_VALUES.has(model.api)) {
          throw new HttpError(400, `${path}.api is invalid`);
        }
      } else if (definition.api === undefined) {
        throw new HttpError(400, `${path}.api is required when definition.api is omitted`);
      }
      if (model.baseUrl !== undefined && (typeof model.baseUrl !== "string" || !model.baseUrl.trim())) {
        throw new HttpError(400, `${path}.baseUrl must be a non-empty string`);
      }
      if (model.headers !== undefined) validateHeaders(model.headers, `${path}.headers`);
      if (model.input !== undefined) {
        if (
          !Array.isArray(model.input) ||
          model.input.some((value) => typeof value !== "string" || MODEL_INPUT_VALUES[value] !== true)
        ) {
          throw new HttpError(400, `${path}.input must contain only text or image`);
        }
      }
      if (model.cost !== undefined) {
        if (!isPlainObject(model.cost)) {
          throw new HttpError(400, `${path}.cost must be an object`);
        }
        for (const [field, value] of Object.entries(model.cost)) {
          if (
            MODEL_COST_FIELDS[field] !== true ||
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0
          ) {
            throw new HttpError(400, `${path}.cost is invalid`);
          }
        }
        for (const field of Object.keys(MODEL_COST_FIELDS)) {
          const value = model.cost[field];
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new HttpError(400, `${path}.cost.${field} must be a non-negative number`);
          }
        }
      }
      for (const field of ["reasoning", "supportsTools", "omitMaxOutputTokens"] as const) {
        if (model[field] !== undefined && typeof model[field] !== "boolean") {
          throw new HttpError(400, `${path}.${field} must be a boolean`);
        }
      }
      for (const field of ["contextWindow", "maxTokens"] as const) {
        const tokenValue = model[field];
        if (
          tokenValue !== undefined &&
          (typeof tokenValue !== "number" || !Number.isFinite(tokenValue) || tokenValue <= 0)
        ) {
          throw new HttpError(400, `${path}.${field} must be a positive number`);
        }
      }
    }
  }
  const hasModels = Array.isArray(definition.models) && definition.models.length > 0;
  if (hasModels && definition.baseUrl === undefined) {
    throw new HttpError(400, "definition.baseUrl is required when models are configured");
  }
  if (hasModels && definition.auth !== "none" && !apiKeyConfigured) {
    throw new HttpError(400, "models require auth:none or a configured apiKey");
  }
  if (
    !hasModels &&
    definition.baseUrl === undefined &&
    !apiKeyConfigured &&
    definition.auth !== "none" &&
    definition.headers === undefined &&
    definition.compat === undefined &&
    definition.disableStrictTools !== true &&
    (
      !isPlainObject(definition.modelOverrides) ||
      Object.keys(definition.modelOverrides).length === 0
    ) &&
    definition.discovery === undefined &&
    definition.remoteCompaction === undefined
  ) {
    throw new HttpError(400, "override-only providers require at least one override");
  }
}


function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedFields.has(key));
  if (unknown) throw new HttpError(400, `Unknown field: ${unknown}`);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!isPlainObject(value)) throw new HttpError(400, "Request body must be an object");
  return value;
}

function parseProviderApiKeyId(pathname: string): string | undefined {
  const prefix = "/api/providers/";
  const suffix = "/api-key";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(pathname.slice(prefix.length, -suffix.length));
  } catch {
    throw new HttpError(400, "Invalid provider ID encoding");
  }
  if (!isValidProviderId(id)) throw new HttpError(400, "Invalid provider ID");
  return id;
}

function parseProviderId(pathname: string): string | undefined {
  const prefix = "/api/providers/";
  if (!pathname.startsWith(prefix)) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    throw new HttpError(400, "Invalid provider ID encoding");
  }
  if (!isValidProviderId(id)) throw new HttpError(400, "Invalid provider ID");
  return id;
}

function validatePutBody(
  value: Record<string, unknown>,
  existingCredentialConfigured: boolean,
): PutProviderInput {
  rejectUnknownFields(value, ["revision", "definition", "apiKey"]);
  if (typeof value.revision !== "string" || !value.revision) {
    throw new HttpError(400, "revision must be a non-empty string");
  }
  if (!isPlainObject(value.definition)) {
    throw new HttpError(400, "definition must be an object");
  }
  if (containsApiKey(value.definition)) {
    throw new HttpError(400, "definition must not contain apiKey");
  }
  if (value.apiKey !== undefined && typeof value.apiKey !== "string") {
    throw new HttpError(400, "apiKey must be a string");
  }
  validateProviderDefinition(
    value.definition,
    existingCredentialConfigured ||
      (typeof value.apiKey === "string" && value.apiKey.trim().length > 0),
  );
  return {
    revision: value.revision,
    definition: value.definition,
    ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey }),
  };
}

function validateDeleteBody(value: Record<string, unknown>): string {
  rejectUnknownFields(value, ["revision"]);
  if (typeof value.revision !== "string" || !value.revision) {
    throw new HttpError(400, "revision must be a non-empty string");
  }
  return value.revision;
}

function validateProbeBody(value: Record<string, unknown>): ProbeInput {
  rejectUnknownFields(value, [
    "providerId",
    "baseUrl",
    "apiKey",
    "api",
    "authHeader",
    "discoveryType",
    "model",
    "runInference",
    "headers",
  ]);
  if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) {
    throw new HttpError(400, "baseUrl must be a non-empty string");
  }
  try {
    new URL(value.baseUrl);
  } catch {
    throw new HttpError(400, "baseUrl must be a valid URL");
  }
  if (typeof value.api !== "string" || !PROBE_API_VALUES.has(value.api)) {
    throw new HttpError(400, "api is invalid");
  }
  for (const field of ["apiKey", "discoveryType", "model"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new HttpError(400, `${field} must be a string`);
    }
  }
  if (
    value.discoveryType !== undefined &&
    !DISCOVERY_VALUES.has(value.discoveryType as string)
  ) {
    throw new HttpError(400, "discoveryType is invalid");
  }
  if (
    value.authHeader !== undefined &&
    typeof value.authHeader !== "boolean" &&
    typeof value.authHeader !== "string"
  ) {
    throw new HttpError(400, "authHeader must be a boolean or string");
  }
  if (value.headers !== undefined) validateHeaders(value.headers, "headers");
  if (value.providerId !== undefined) {
    if (typeof value.providerId !== "string" || !isValidProviderId(value.providerId)) {
      throw new HttpError(400, "providerId is invalid");
    }
  }
  if (value.runInference !== undefined && typeof value.runInference !== "boolean") {
    throw new HttpError(400, "runInference must be a boolean");
  }
  return value as unknown as ProbeInput;
}

function validateDiscoveryBody(value: Record<string, unknown>): DiscoveryInput {
  rejectUnknownFields(value, [
    "providerId",
    "baseUrl",
    "apiKey",
    "api",
    "authHeader",
    "discoveryType",
    "headers",
  ]);
  if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) {
    throw new HttpError(400, "baseUrl must be a non-empty string");
  }
  try {
    const url = new URL(value.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new HttpError(400, "baseUrl must be an HTTP or HTTPS URL");
  }
  if (typeof value.api !== "string" || !PROVIDER_API_VALUES.has(value.api)) {
    throw new HttpError(400, "api is invalid");
  }
  for (const field of ["apiKey", "discoveryType"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new HttpError(400, `${field} must be a string`);
    }
  }
  if (
    value.discoveryType !== undefined &&
    value.discoveryType !== "" &&
    !DISCOVERY_VALUES.has(value.discoveryType as string)
  ) {
    throw new HttpError(400, "discoveryType is invalid");
  }
  if (
    value.authHeader !== undefined &&
    typeof value.authHeader !== "boolean" &&
    typeof value.authHeader !== "string"
  ) {
    throw new HttpError(400, "authHeader must be a boolean or string");
  }
  if (value.headers !== undefined) validateHeaders(value.headers, "headers");
  if (value.providerId !== undefined) {
    if (typeof value.providerId !== "string" || !isValidProviderId(value.providerId)) {
      throw new HttpError(400, "providerId is invalid");
    }
  }
  return value as unknown as DiscoveryInput;
}

async function staticResponse(pathname: string): Promise<Response | undefined> {
  const resources: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  };
  const resource = resources[pathname];
  if (!resource) return undefined;
  const file = Bun.file(join(PUBLIC_DIRECTORY, resource.file));
  if (!(await file.exists())) return json({ error: "Static resource not found" }, 404);
  return new Response(file, {
    headers: {
      "content-type": resource.type,
      "cache-control": "no-store",
    },
  });
}

export interface RequestHandlerOptions {
  store?: ConfigStore;
  probe?: (input: ProbeInput) => Promise<ProbeResult>;
  discover?: (input: DiscoveryInput) => Promise<DiscoveryResult>;
}

export function createRequestHandler(options: RequestHandlerOptions = {}): (request: Request) => Promise<Response> {
  const store = options.store ?? new ConfigStore();
  const probe = options.probe ?? probeProvider;
  const discover = options.discover ?? discoverModels;

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/providers") {
        if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
        return json(await store.list());
      }

      const apiKeyProviderId = parseProviderApiKeyId(url.pathname);
      if (apiKeyProviderId !== undefined) {
        if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
        const apiKey = await store.resolveApiKey(apiKeyProviderId);
        if (apiKey === undefined) {
          throw new HttpError(422, "API Key cannot be revealed because its value is unavailable");
        }
        return json({ apiKey });
      }

      const providerId = parseProviderId(url.pathname);
      if (providerId !== undefined) {
        if (request.method === "PUT") {
          const value = await readJsonObject(request);
          const existingCredentialConfigured = (await store.list()).providers
            .find((provider) => provider.id === providerId)?.credential.configured ?? false;
          const input = validatePutBody(value, existingCredentialConfigured);
          return json(await store.put(providerId, input));
        }
        if (request.method === "DELETE") {
          const revision = validateDeleteBody(await readJsonObject(request));
          return json(await store.delete(providerId, revision));
        }
        throw new HttpError(405, "Method not allowed");
      }

      if (url.pathname === "/api/probe") {
        if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
        const input = validateProbeBody(await readJsonObject(request));
        if (input.providerId) {
          if (input.apiKey === undefined) input.apiKey = await store.resolveApiKey(input.providerId);
          if (
            await store.hasUnavailableCommandCredentials(input.providerId, input.model)
          ) {
            input.credentialsUnavailable = true;
          }
          const storedHeaders = await store.resolveHeaders(input.providerId);
          if (input.headers === undefined) {
            input.headers = storedHeaders;
          } else {
            input.headers = Object.fromEntries(
              Object.entries(input.headers).flatMap(([name, value]) => {
                if (value !== SECRET_SENTINEL) return [[name, value]];
                return storedHeaders[name] === undefined ? [] : [[name, storedHeaders[name]]];
              }),
            );
          }
          if (input.model) {
            input.inferenceHeaders = await store.resolveHeaders(
              input.providerId,
              input.model,
              input.headers,
            );
          }
        }
        return json(await probe(input));
      }

      if (url.pathname === "/api/discover") {
        if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
        const input = validateDiscoveryBody(await readJsonObject(request));
        if (input.providerId) {
          const snapshot = await store.list();
          const provider = snapshot.providers.find(({ id }) => id === input.providerId);
          if (!provider) throw new HttpError(404, `Provider not found: ${input.providerId}`);
          if (input.apiKey === undefined) input.apiKey = await store.resolveApiKey(input.providerId);
          const storedHeaders = await store.resolveHeaders(input.providerId);
          if (input.headers === undefined) {
            input.headers = storedHeaders;
          } else {
            input.headers = Object.fromEntries(
              Object.entries(input.headers).flatMap(([name, value]) => {
                if (value !== SECRET_SENTINEL) return [[name, value]];
                return storedHeaders[name] === undefined ? [] : [[name, storedHeaders[name]]];
              }),
            );
          }
          if (Array.isArray(provider.definition.models)) {
            input.configuredModels = provider.definition.models;
          }
        }
        return json(await discover(input));
      }

      if (url.pathname.startsWith("/api/")) throw new HttpError(404, "API route not found");
      if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
      return (await staticResponse(url.pathname)) ?? json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof RevisionConflictError) return json({ error: error.message }, 409);
      if (error instanceof ConfigStoreError && error.message.startsWith("Provider not found:")) {
        return json({ error: error.message }, 404);
      }
      return json({ error: "Internal server error" }, 500);
    }
  };
}

export const DEFAULT_SERVER_PORT = 4380;

export interface StartServerOptions {
  port?: number;
  store?: ConfigStore;
  /** When true, bind to the next free port when the preferred one is occupied. */
  autoPort?: boolean;
  /** Maximum ports to probe when `autoPort` is enabled (default 100). */
  maxPortAttempts?: number;
}

/** True when a thrown error means the requested port is already bound. */
export function isPortInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /in use|EADDRINUSE/i.test(message);
}

function resolvePreferredPort(port: number | undefined): number {
  const configuredPort = port ?? Number(process.env.MODELS_WEBUI_PORT ?? DEFAULT_SERVER_PORT);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
    throw new Error("MODELS_WEBUI_PORT must be an integer between 1 and 65535");
  }
  return configuredPort;
}

export function startServer(options: StartServerOptions = {}): Bun.Server<unknown> {
  const preferredPort = resolvePreferredPort(options.port);
  const handler = createRequestHandler({ store: options.store });

  if (!options.autoPort) {
    return Bun.serve({ hostname: "127.0.0.1", port: preferredPort, fetch: handler });
  }

  const maxAttempts = options.maxPortAttempts ?? 100;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = preferredPort + attempt;
    if (candidate > 65_535) break;
    try {
      return Bun.serve({ hostname: "127.0.0.1", port: candidate, fetch: handler });
    } catch (error) {
      lastError = error;
      if (!isPortInUseError(error)) throw error;
    }
  }
  throw lastError ?? new Error(`No available port found near ${preferredPort}`);
}

if (import.meta.main) {
  const server = startServer();
  console.log(`OMP models manager listening on http://${server.hostname}:${server.port}`);
}
