import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type FileHandle,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import {
  Document,
  isMap,
  isSeq,
  isScalar,
  parseDocument,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

export type CredentialSource = "none" | "env" | "command" | "unknown";

export interface CredentialMetadata {
  configured: boolean;
  source: CredentialSource;
  ref?: string;
}

export interface ProviderRecord {
  id: string;
  definition: Record<string, unknown>;
  credential: CredentialMetadata;
}

export interface ProvidersSnapshot {
  revision: string;
  path: string;
  providers: ProviderRecord[];
}

export interface PutProviderInput {
  revision: string;
  definition: Record<string, unknown>;
  apiKey?: string;
}

export class RevisionConflictError extends Error {
  constructor() {
    super("models.yml changed; reload before saving");
    this.name = "RevisionConflictError";
  }
}

export class ConfigStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigStoreError";
  }
}

const ENV_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function defaultModelsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MODELS_YML_PATH) return env.MODELS_YML_PATH;
  const agentDirectory = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
  return join(agentDirectory, "models.yml");
}

export function isValidProviderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id);
}

export const SECRET_SENTINEL = "__OMP_MODELS_WEBUI_SECRET__";

export function apiKeyEnvironmentName(id: string): string {
  let readableId = "";
  for (const character of id) {
    if (character === ".") readableId += "_DOT_";
    else if (character === "-") readableId += "_DASH_";
    else if (character === "_") readableId += "_UNDERSCORE_";
    else readableId += character.toUpperCase();
  }
  return `OMP_CUSTOM_${readableId}_API_KEY`;
}

function revisionOf(modelsSource: string, envSource: string): string {
  return createHash("sha256")
    .update(String(Buffer.byteLength(modelsSource)))
    .update(":")
    .update(modelsSource)
    .update(String(Buffer.byteLength(envSource)))
    .update(":")
    .update(envSource)
    .digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}


function stripSecrets(value: unknown, inHeaders = false): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item));
  if (!isPlainObject(value)) return value;

  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "apiKey") continue;
    if (inHeaders) {
      safe[key] = SECRET_SENTINEL;
      continue;
    }
    safe[key] = stripSecrets(item, key.toLowerCase() === "headers");
  }
  return safe;
}

function redactTaggedHeaderCommands(
  node: Node | null | undefined,
  safeValue: unknown,
  inHeaders = false,
): void {
  if (isMap(node) && isPlainObject(safeValue)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (key === "apiKey" || !Object.prototype.hasOwnProperty.call(safeValue, key)) continue;
      if (inHeaders && isScalar(pair.value) && pair.value.tag === "!command") {
        safeValue[key] = SECRET_SENTINEL;
        continue;
      }
      redactTaggedHeaderCommands(
        pair.value as Node | null | undefined,
        safeValue[key],
        key.toLowerCase() === "headers",
      );
    }
    return;
  }
  if (isSeq(node) && Array.isArray(safeValue)) {
    node.items.forEach((item, index) => {
      redactTaggedHeaderCommands(item as Node | null | undefined, safeValue[index], false);
    });
  }
}

function isUnavailableCommand(node: unknown): boolean {
  if (typeof node === "string") return node.startsWith("!");
  return isScalar(node) && (
    node.tag === "!command" ||
    (typeof node.value === "string" && node.value.startsWith("!"))
  );
}


function credentialFrom(node: unknown): CredentialMetadata {
  if (node == null || node === "") return { configured: false, source: "none" };
  if (typeof node === "string") {
    if (node.startsWith("!")) return { configured: true, source: "command" };
    return ENV_REFERENCE.test(node)
      ? { configured: true, source: "env", ref: node }
      : { configured: true, source: "unknown" };
  }
  if (isScalar(node) && node.tag === "!command") {
    return { configured: true, source: "command" };
  }
  if (isScalar(node) && typeof node.value === "string") {
    if (!node.value) return { configured: false, source: "none" };
    if (node.value.startsWith("!")) return { configured: true, source: "command" };
    if (ENV_REFERENCE.test(node.value)) {
      return { configured: true, source: "env", ref: node.value };
    }
  }
  return { configured: true, source: "unknown" };
}

async function readTextIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function parseModels(source: string): Document {
  const document = parseDocument(source || "{}\n", {
    keepSourceTokens: true,
    strict: true,
  });
  if (document.errors.length > 0) {
    throw new ConfigStoreError(`Invalid models.yml: ${document.errors[0]?.message}`);
  }
  if (document.contents != null && !isMap(document.contents)) {
    throw new ConfigStoreError("Invalid models.yml: top-level value must be an object");
  }
  return document;
}

function providersMap(document: Document, create: boolean): YAMLMap | undefined {
  if (document.contents == null) {
    if (!create) return undefined;
    document.contents = document.createNode({}) as YAMLMap;
  }
  if (!isMap(document.contents)) {
    throw new ConfigStoreError("Invalid models.yml: top-level value must be an object");
  }

  const existing = document.contents.get("providers", true);
  if (existing == null) {
    if (!create) return undefined;
    const created = document.createNode({}) as YAMLMap;
    document.contents.set("providers", created);
    return created;
  }
  if (!isMap(existing)) {
    throw new ConfigStoreError("Invalid models.yml: providers must be an object");
  }
  return existing;
}

function recordsFrom(document: Document): ProviderRecord[] {
  const providers = providersMap(document, false);
  if (!providers) return [];

  return providers.items.map((pair) => {
    const id = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (!isMap(pair.value)) {
      throw new ConfigStoreError(`Invalid models.yml: provider ${id} must be an object`);
    }
    const converted = pair.value.toJSON() as unknown;
    const definition = stripSecrets(converted);
    redactTaggedHeaderCommands(pair.value, definition);
    if (!isPlainObject(definition)) {
      throw new ConfigStoreError(`Invalid models.yml: provider ${id} must be an object`);
    }
    return {
      id,
      definition,
      credential: credentialFrom(pair.value.get("apiKey", true) as Node | undefined),
    };
  });
}

function providerRecord(document: Document, id: string): ProviderRecord {
  const providers = providersMap(document, false);
  const provider = providers?.get(id, true);
  if (!isMap(provider)) throw new ConfigStoreError(`Provider not found: ${id}`);
  const definition = stripSecrets(provider.toJSON());
  redactTaggedHeaderCommands(provider, definition);
  if (!isPlainObject(definition)) throw new ConfigStoreError(`Provider ${id} must be an object`);
  return {
    id,
    definition,
    credential: credentialFrom(provider.get("apiKey", true) as Node | undefined),
  };
}

async function targetMode(path: string): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0o600;
    throw error;
  }
}

function jsonValue(node: Node | null | undefined): unknown {
  return node == null ? undefined : node.toJSON();
}

function mergeSeqInPlace(
  document: Document,
  target: YAMLSeq,
  input: unknown[],
): void {
  const existingById = new Map<string, YAMLMap>();
  for (const item of target.items) {
    if (!isMap(item)) continue;
    const id = item.get("id");
    if (typeof id === "string" && !existingById.has(id)) existingById.set(id, item);
  }

  const reused = new Set<Node>();
  const merged = input.map((value, index) => {
    const id = isPlainObject(value) && typeof value.id === "string" ? value.id : undefined;
    const byId = id === undefined ? undefined : existingById.get(id);
    const positional = target.items[index] as Node | null | undefined;
    const existing = byId && !reused.has(byId)
      ? byId
      : positional && !reused.has(positional) && id === undefined
        ? positional
        : undefined;

    if (isMap(existing) && isPlainObject(value)) {
      reused.add(existing);
      mergeMapInPlace(document, existing, value);
      return existing;
    }
    if (isSeq(existing) && Array.isArray(value)) {
      reused.add(existing);
      mergeSeqInPlace(document, existing, value);
      return existing;
    }
    if (existing && JSON.stringify(jsonValue(existing)) === JSON.stringify(value)) {
      reused.add(existing);
      return existing;
    }
    if (isPlainObject(value)) {
      const created = document.createNode({}) as YAMLMap;
      mergeMapInPlace(document, created, value);
      return created;
    }
    if (Array.isArray(value)) {
      const created = document.createNode([]) as YAMLSeq;
      mergeSeqInPlace(document, created, value);
      return created;
    }
    return document.createNode(value);
  });

  target.items.splice(0, target.items.length, ...merged);
}

function mergeMapInPlace(
  document: Document,
  target: YAMLMap,
  input: Record<string, unknown>,
  inHeaders = false,
): void {
  for (const pair of [...target.items]) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (key === "apiKey") continue;
    if (!Object.prototype.hasOwnProperty.call(input, key)) target.delete(key);
  }

  for (const [key, value] of Object.entries(input)) {
    const existing = target.get(key, true) as Node | undefined;
    if (inHeaders && value === SECRET_SENTINEL) continue;
    if (isPlainObject(value)) {
      const map = isMap(existing) ? existing : (document.createNode({}) as YAMLMap);
      mergeMapInPlace(document, map, value, key.toLowerCase() === "headers");
      if (!isMap(existing)) target.set(key, map);
      continue;
    }
    if (Array.isArray(value)) {
      const sequence = isSeq(existing) ? existing : (document.createNode([]) as YAMLSeq);
      mergeSeqInPlace(document, sequence, value);
      if (!isSeq(existing)) target.set(key, sequence);
      continue;
    }
    if (JSON.stringify(jsonValue(existing)) === JSON.stringify(value)) continue;
    target.set(key, document.createNode(value));
  }
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  let handle: FileHandle | undefined;
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function quoteEnvValue(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll('"', '\\"')}"`;
}

function updateEnvSource(source: string, name: string, value: string): string {
  const replacement = `${name}=${quoteEnvValue(value)}`;
  const lines = source.split(/(?<=\n)/);
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  let replaced = false;
  const updated = lines.map((line) => {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;
    if (assignment.test(body)) {
      replaced = true;
      return replacement + ending;
    }
    return line;
  });
  if (!replaced) {
    if (source && !source.endsWith("\n")) updated.push("\n");
    updated.push(`${replacement}\n`);
  }
  return updated.join("");
}

function parseEnvSource(source: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const assignment = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const name = assignment[1]!;
    const raw = assignment[2]!;
    const doubleQuoted = raw.match(/^"((?:\\.|[^"])*)"\s*(?:#.*)?$/);
    if (doubleQuoted) {
      values.set(
        name,
        doubleQuoted[1]!.replace(/\\([\\nrt"])/g, (_, escaped: string) => {
          if (escaped === "n") return "\n";
          if (escaped === "r") return "\r";
          if (escaped === "t") return "\t";
          return escaped;
        }),
      );
      continue;
    }
    const singleQuoted = raw.match(/^'([^']*)'\s*(?:#.*)?$/);
    if (singleQuoted) {
      values.set(name, singleQuoted[1]!);
      continue;
    }
    values.set(name, raw.replace(/\s+#.*$/, "").trim());
  }
  return values;
}

const mutationTails = new Map<string, Promise<void>>();
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 1_000;
const LOCK_STALE_MS = 30_000;

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function removeStaleLock(path: string): Promise<boolean> {
  try {
    const first = await stat(path);
    if (Date.now() - first.mtimeMs <= LOCK_STALE_MS) return false;
    const current = await stat(path);
    if (first.dev !== current.dev || first.ino !== current.ino || first.mtimeMs !== current.mtimeMs) {
      return false;
    }
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function writeIfUnchanged(
  path: string,
  expected: string,
  content: string,
  mode: number,
): Promise<void> {
  if (await readTextIfPresent(path) !== expected) throw new RevisionConflictError();
  await atomicWrite(path, content, mode);
}

export interface ConfigStoreOptions {
  /**
   * Called after a plaintext API key is durably persisted to the adjacent
   * `.env`, receiving the env-var name and plaintext value. The OMP plugin uses
   * it to mirror the value into the running process environment so an
   * already-started OMP reads the new key without a restart (`.env` is parsed
   * only once, at process start). Defaults to no-op; standalone mode does not
   * register it.
   */
  onApiKeyPersisted?: (envName: string, value: string) => void;
}

export class ConfigStore {
  readonly path: string;
  readonly envPath: string;
  private readonly onApiKeyPersisted?: (envName: string, value: string) => void;

  constructor(path = defaultModelsPath(), options: ConfigStoreOptions = {}) {
    this.path = path;
    this.envPath = join(dirname(path), ".env");
    this.onApiKeyPersisted = options.onApiKeyPersisted;
  }

  async list(): Promise<ProvidersSnapshot> {
    const [source, envSource] = await Promise.all([
      readTextIfPresent(this.path),
      readTextIfPresent(this.envPath),
    ]);
    const document = parseModels(source);
    return {
      revision: revisionOf(source, envSource),
      path: this.path,
      providers: recordsFrom(document),
    };
  }

  async resolveApiKey(id: string): Promise<string | undefined> {
    const document = parseModels(await readTextIfPresent(this.path));
    const provider = providersMap(document, false)?.get(id, true);
    if (!isMap(provider)) throw new ConfigStoreError(`Provider not found: ${id}`);
    const credential = provider.get("apiKey", true);
    if (!isScalar(credential) || credential.tag === "!command" || typeof credential.value !== "string") {
      return undefined;
    }
    if (credential.value.startsWith("!")) return undefined;
    if (!ENV_REFERENCE.test(credential.value)) return credential.value || undefined;
    if (process.env[credential.value] !== undefined) return process.env[credential.value];
    return parseEnvSource(await readTextIfPresent(this.envPath)).get(credential.value);
  }

  async resolveHeaders(
    id: string,
    modelId?: string,
    baseHeaders?: Record<string, string>,
  ): Promise<Record<string, string>> {
    const document = parseModels(await readTextIfPresent(this.path));
    const provider = providersMap(document, false)?.get(id, true);
    if (!isMap(provider)) throw new ConfigStoreError(`Provider not found: ${id}`);

    const resolved: Record<string, string> = { ...baseHeaders };
    const apply = (headers: unknown): void => {
      if (!isMap(headers)) return;
      for (const pair of headers.items) {
        if (!isScalar(pair.key)) continue;
        const name = String(pair.key.value);
        if (
          !isScalar(pair.value) ||
          pair.value.tag === "!command" ||
          typeof pair.value.value !== "string" ||
          pair.value.value.startsWith("!")
        ) {
          delete resolved[name];
          continue;
        }
        resolved[name] = pair.value.value;
      }
    };

    if (baseHeaders === undefined) apply(provider.get("headers", true));
    if (modelId !== undefined) {
      const models = provider.get("models", true);
      if (isSeq(models)) {
        for (const model of models.items) {
          if (!isMap(model) || model.get("id") !== modelId) continue;
          apply(model.get("headers", true));
          break;
        }
      }
    }
    return resolved;
  }

  async hasUnavailableCommandCredentials(id: string, modelId?: string): Promise<boolean> {
    const document = parseModels(await readTextIfPresent(this.path));
    const provider = providersMap(document, false)?.get(id, true);
    if (!isMap(provider)) throw new ConfigStoreError(`Provider not found: ${id}`);
    const providerHeaders = provider.get("headers", true);
    if (
      isUnavailableCommand(provider.get("apiKey", true)) ||
      (
        isMap(providerHeaders) &&
        providerHeaders.items.some((pair) => isUnavailableCommand(pair.value))
      )
    ) return true;
    if (modelId === undefined) return false;

    const models = provider.get("models", true);
    if (!isSeq(models)) return false;
    for (const model of models.items) {
      if (!isMap(model) || model.get("id") !== modelId) continue;
      const headers = model.get("headers", true);
      return isMap(headers) && headers.items.some((pair) => isUnavailableCommand(pair.value));
    }
    return false;
  }


  async put(id: string, input: PutProviderInput): Promise<ProvidersSnapshot & { provider: ProviderRecord }> {
    return this.#exclusive(async () => {
      const [source, envSource] = await Promise.all([
        readTextIfPresent(this.path),
        readTextIfPresent(this.envPath),
      ]);
      if (input.revision !== revisionOf(source, envSource)) throw new RevisionConflictError();

      const document = parseModels(source);
      const providers = providersMap(document, true)!;
      const existing = providers.get(id, true);
      const provider = isMap(existing) ? existing : (document.createNode({}) as YAMLMap);
      mergeMapInPlace(document, provider, input.definition);

      let updatedEnvSource = envSource;
      let envWritten = false;
      let persistedApiKey: { name: string; value: string } | null = null;
      if (input.apiKey != null && input.apiKey.trim() !== "") {
        const environmentName = apiKeyEnvironmentName(id);
        updatedEnvSource = updateEnvSource(envSource, environmentName, input.apiKey);
        if (
          await readTextIfPresent(this.path) !== source ||
          await readTextIfPresent(this.envPath) !== envSource
        ) {
          throw new RevisionConflictError();
        }
        await writeIfUnchanged(this.envPath, envSource, updatedEnvSource, 0o600);
        envWritten = true;
        provider.set("apiKey", environmentName);
        persistedApiKey = { name: environmentName, value: input.apiKey };
      }

      if (!isMap(existing)) providers.set(id, provider);
      const updatedSource = document.toString();
      try {
        if (
          await readTextIfPresent(this.path) !== source ||
          await readTextIfPresent(this.envPath) !== updatedEnvSource
        ) {
          throw new RevisionConflictError();
        }
        await writeIfUnchanged(this.path, source, updatedSource, await targetMode(this.path));
      } catch (error) {
        if (envWritten && await readTextIfPresent(this.envPath) === updatedEnvSource) {
          await writeIfUnchanged(this.envPath, updatedEnvSource, envSource, 0o600).catch(() => undefined);
        }
        throw error;
      }

      if (persistedApiKey) {
        this.onApiKeyPersisted?.(persistedApiKey.name, persistedApiKey.value);
      }
      return {
        revision: revisionOf(updatedSource, updatedEnvSource),
        path: this.path,
        providers: recordsFrom(document),
        provider: providerRecord(document, id),
      };
    });
  }

  async delete(id: string, revision: string): Promise<ProvidersSnapshot> {
    return this.#exclusive(async () => {
      const [source, envSource] = await Promise.all([
        readTextIfPresent(this.path),
        readTextIfPresent(this.envPath),
      ]);
      if (revision !== revisionOf(source, envSource)) throw new RevisionConflictError();
      const document = parseModels(source);
      const providers = providersMap(document, false);
      if (!providers?.has(id)) throw new ConfigStoreError(`Provider not found: ${id}`);
      providers.delete(id);
      const updatedSource = document.toString();
      if (
        await readTextIfPresent(this.path) !== source ||
        await readTextIfPresent(this.envPath) !== envSource
      ) {
        throw new RevisionConflictError();
      }
      await writeIfUnchanged(this.path, source, updatedSource, await targetMode(this.path));
      return {
        revision: revisionOf(updatedSource, envSource),
        path: this.path,
        providers: recordsFrom(document),
      };
    });
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mutationTails.get(this.path) ?? Promise.resolve();
    const result = previous.then(
      () => this.#withFileLock(operation),
      () => this.#withFileLock(operation),
    );
    mutationTails.set(
      this.path,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  async #withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let handle: FileHandle;
    while (true) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await removeStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) throw new RevisionConflictError();
        await delay(LOCK_RETRY_MS);
      }
    }

    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
