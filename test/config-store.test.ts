import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isScalar, parseDocument } from "yaml";
import {
  ConfigStore,
  RevisionConflictError,
  apiKeyEnvironmentName,
  SECRET_SENTINEL,
  isValidProviderId,
} from "../src/config-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(source: string): Promise<{ directory: string; path: string; store: ConfigStore }> {
  const directory = await mkdtemp(join(tmpdir(), "omp-models-store-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "models.yml");
  await Bun.write(path, source);
  return { directory, path, store: new ConfigStore(path) };
}

describe("ConfigStore", () => {
  test("lists only safe credential metadata and never evaluates command credentials", async () => {
    const { directory, store } = await fixture(`# heading\nother: keep-me\nproviders:\n  env-provider:\n    baseUrl: https://env.example\n    apiKey: EXISTING_API_KEY # env ref\n  command-provider:\n    baseUrl: https://command.example\n    apiKey: !command touch ${join(tmpdir(), "must-not-run")}\n`);

    const snapshot = await store.list();

    expect(snapshot.path).toBe(join(directory, "models.yml"));
    expect(snapshot.providers).toEqual([
      {
        id: "env-provider",
        definition: { baseUrl: "https://env.example" },
        credential: { configured: true, source: "env", ref: "EXISTING_API_KEY" },
      },
      {
        id: "command-provider",
        definition: { baseUrl: "https://command.example" },
        credential: { configured: true, source: "command" },
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("touch");
  });

  test("updates one provider while preserving comments, unrelated YAML, and other providers", async () => {
    const { directory, path, store } = await fixture(`# file comment\nother:\n  nested: true # keep nested\nproviders:\n  first: # keep provider\n    baseUrl: https://old.example\n    apiKey: OLD_KEY\n  second:\n    baseUrl: https://second.example # keep second\n`);
    await Bun.write(join(directory, ".env"), "# existing\nUNRELATED=value\n");
    const before = await store.list();

    const result = await store.put("first", {
      revision: before.revision,
      definition: {
        baseUrl: "https://new.example",
        api: "openai-responses",
      },
      apiKey: "top-secret-value",
    });

    expect(result.revision).not.toBe(before.revision);
    expect(result.provider).toEqual({
      id: "first",
      definition: { baseUrl: "https://new.example", api: "openai-responses" },
      credential: { configured: true, source: "env", ref: apiKeyEnvironmentName("first") },
    });
    expect(JSON.stringify(await store.list())).not.toContain("top-secret-value");

    const yamlSource = await readFile(path, "utf8");
    expect(yamlSource).toContain("# file comment");
    expect(yamlSource).toContain("# keep provider");
    expect(yamlSource).toContain("nested: true # keep nested");
    expect(yamlSource).toContain("https://second.example # keep second");
    expect(yamlSource).toContain(`apiKey: ${apiKeyEnvironmentName("first")}`);
    expect(yamlSource).not.toContain("top-secret-value");
    const parsed = parseDocument(yamlSource).toJS();
    expect(parsed.other).toEqual({ nested: true });
    expect(parsed.providers.second.baseUrl).toBe("https://second.example");

    const envSource = await readFile(join(directory, ".env"), "utf8");
    expect(envSource).toContain("# existing\nUNRELATED=value\n");
    expect(envSource).toContain(`${apiKeyEnvironmentName("first")}="top-secret-value"`);
    expect((await stat(join(directory, ".env"))).mode & 0o777).toBe(0o600);
  });

  test("an empty key preserves an existing tagged credential without executing it", async () => {
    const marker = join(tmpdir(), `omp-command-${crypto.randomUUID()}`);
    const { path, store } = await fixture(`providers:\n  custom:\n    baseUrl: https://old.example\n    apiKey: !command touch ${marker} # keep command\n`);
    const before = await store.list();

    await store.put("custom", {
      revision: before.revision,
      definition: { baseUrl: "https://new.example" },
      apiKey: "",
    });

    const source = await readFile(path, "utf8");
    const credential = parseDocument(source).getIn(["providers", "custom", "apiKey"], true);
    expect(isScalar(credential) && credential.tag).toBe("!command");
    expect(isScalar(credential) && credential.value).toBe(`touch ${marker}`);
    expect(isScalar(credential) && credential.comment).toContain("keep command");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("serializes mutations so a stale concurrent revision cannot overwrite a winner", async () => {
    const { path, store } = await fixture("providers: {}\n");
    const competingStore = new ConfigStore(path);
    const before = await store.list();

    const outcomes = await Promise.allSettled([
      store.put("alpha", { revision: before.revision, definition: { baseUrl: "https://alpha.example" } }),
      competingStore.put("beta", { revision: before.revision, definition: { baseUrl: "https://beta.example" } }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toBeInstanceOf(RevisionConflictError);
    expect((await store.list()).providers).toHaveLength(1);
  });

  test("uses OMP provider IDs and resolves credentials without executing commands", async () => {
    expect(isValidProviderId("llama.cpp")).toBe(true);
    expect(isValidProviderId("Uppercase")).toBe(false);
    expect(isValidProviderId(`a${"b".repeat(64)}`)).toBe(false);

    const environmentRef = `OMP_TEST_${crypto.randomUUID().replaceAll("-", "_")}`;
    const marker = join(tmpdir(), `omp-resolve-${crypto.randomUUID()}`);
    const { directory, store } = await fixture(`providers:
  from-env:
    apiKey: ${environmentRef}
  literal:
    apiKey: sk-literal-secret
  command:
    apiKey: !command touch ${marker}
  quoted-command:
    apiKey: "!touch ${marker}"
`);
    await Bun.write(join(directory, ".env"), `${environmentRef}="file-secret"\n`);
    const previous = process.env[environmentRef];
    try {
      process.env[environmentRef] = "process-secret";
      expect(await store.resolveApiKey("from-env")).toBe("process-secret");
      delete process.env[environmentRef];
      expect(await store.resolveApiKey("from-env")).toBe("file-secret");
      expect(await store.resolveApiKey("literal")).toBe("sk-literal-secret");
      expect(await store.resolveApiKey("command")).toBeUndefined();
      expect(await store.resolveApiKey("quoted-command")).toBeUndefined();
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[environmentRef];
      else process.env[environmentRef] = previous;
    }
  });

  test("redacts every header and preserves sentinel-backed model nodes through reordering", async () => {
    const { path, store } = await fixture(`providers:
  guarded:
    baseUrl: https://old.example # keep base URL comment
    headers:
      Authorization: Bearer original-secret # keep auth comment
      X_API_KEY: key-secret # keep key comment
      X-Auth: auth-secret # keep short auth comment
      X-Safe: visible
      X-Resolver: "!security find-generic-password -w"
      X-Tagged: !command echo tagged-secret
    models:
      - id: guarded-model # keep guarded model comment
        headers:
          X-Model-Token: model-secret # keep model header comment
          X-Safe: model-visible # keep model override comment
      - id: team-model # keep team model comment
        name: Team model # keep team name comment
        headers:
          X-Team: team-secret # keep team header comment
`);
    const before = await store.list();
    expect(before.providers[0]?.definition.headers).toEqual({
      Authorization: SECRET_SENTINEL,
      X_API_KEY: SECRET_SENTINEL,
      "X-Auth": SECRET_SENTINEL,
      "X-Safe": SECRET_SENTINEL,
      "X-Resolver": SECRET_SENTINEL,
      "X-Tagged": SECRET_SENTINEL,
    });
    const models = before.providers[0]?.definition.models as Array<Record<string, unknown>>;
    expect(models[0]?.headers).toEqual({
      "X-Model-Token": SECRET_SENTINEL,
      "X-Safe": SECRET_SENTINEL,
    });
    expect(models[1]?.headers).toEqual({ "X-Team": SECRET_SENTINEL });
    expect(JSON.stringify(before)).not.toContain("original-secret");
    expect(JSON.stringify(before)).not.toContain("visible");
    expect(JSON.stringify(before)).not.toContain("find-generic-password");
    expect(JSON.stringify(before)).not.toContain("tagged-secret");
    expect(JSON.stringify(before)).not.toContain("model-secret");
    expect(JSON.stringify(before)).not.toContain("team-secret");
    expect(JSON.stringify(before)).not.toContain("model-visible");
    expect(await store.resolveHeaders("guarded", "guarded-model")).toEqual({
      Authorization: "Bearer original-secret",
      X_API_KEY: "key-secret",
      "X-Auth": "auth-secret",
      "X-Safe": "model-visible",
      "X-Model-Token": "model-secret",
    });

    const reordered = await store.put("guarded", {
      revision: before.revision,
      definition: {
        ...before.providers[0]!.definition,
        baseUrl: "https://new.example",
        models: [
          models[1],
          {
            id: "new-model",
            headers: { "X-New": "new-value", "X-Unknown": SECRET_SENTINEL },
          },
          models[0],
        ],
      },
    });

    let source = await readFile(path, "utf8");
    expect(source).toContain("Authorization: Bearer original-secret # keep auth comment");
    expect(source).toContain("X_API_KEY: key-secret # keep key comment");
    expect(source).toContain("X-Tagged: !command echo tagged-secret");
    expect(source).toContain("X-Auth: auth-secret # keep short auth comment");
    expect(source).toContain("id: guarded-model # keep guarded model comment");
    expect(source).toContain("X-Model-Token: model-secret # keep model header comment");
    expect(source).toContain("X-Safe: model-visible # keep model override comment");
    expect(source).toContain("id: team-model # keep team model comment");
    expect(source).toContain("name: Team model # keep team name comment");
    expect(source).toContain("X-Team: team-secret # keep team header comment");
    expect(source).toContain("X-New: new-value");
    expect(source).not.toContain(SECRET_SENTINEL);
    expect(source).not.toContain("X-Unknown");
    expect(source.indexOf("id: team-model")).toBeLessThan(source.indexOf("id: new-model"));
    expect(source.indexOf("id: new-model")).toBeLessThan(source.indexOf("id: guarded-model"));

    const reorderedModels = reordered.provider.definition.models as Array<Record<string, unknown>>;
    await store.put("guarded", {
      revision: reordered.revision,
      definition: {
        ...reordered.provider.definition,
        models: [reorderedModels[2], reorderedModels[1]],
      },
    });
    source = await readFile(path, "utf8");
    expect(source).not.toContain("id: team-model");
    expect(source).toContain("id: guarded-model # keep guarded model comment");
    expect(source.indexOf("id: guarded-model")).toBeLessThan(source.indexOf("id: new-model"));
    expect(source).not.toContain(SECRET_SENTINEL);
    expect(await store.resolveHeaders("guarded")).toEqual({
      Authorization: "Bearer original-secret",
      X_API_KEY: "key-secret",
      "X-Auth": "auth-secret",
      "X-Safe": "visible",
    });
  });

  test("uses human-readable collision-free provider environment names", () => {
    const names = ["foo-bar", "foo_bar", "foo.bar"].map(apiKeyEnvironmentName);
    expect(names).toEqual([
      "OMP_CUSTOM_FOO_DASH_BAR_API_KEY",
      "OMP_CUSTOM_FOO_UNDERSCORE_BAR_API_KEY",
      "OMP_CUSTOM_FOO_DOT_BAR_API_KEY",
    ]);
    expect(new Set(names).size).toBe(3);
  });

  test("includes .env in revisions and rejects stale writes after an env-only change", async () => {
    const { directory, path, store } = await fixture("providers: {}\n");
    await Bun.write(join(directory, ".env"), "EXISTING=one\n");
    const before = await store.list();
    await Bun.write(join(directory, ".env"), "EXISTING=two\n");
    const after = await store.list();

    expect(after.revision).not.toBe(before.revision);
    await expect(
      store.put("stale", {
        revision: before.revision,
        definition: { baseUrl: "https://stale.example" },
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await readFile(path, "utf8")).toBe("providers: {}\n");
  });

  test("cleans up its adjacent lockfile when a locked mutation throws", async () => {
    const { path, store } = await fixture("providers: {}\n");
    const before = await store.list();

    await expect(store.delete("missing", before.revision)).rejects.toThrow("Provider not found");
    expect(await Bun.file(`${path}.lock`).exists()).toBe(false);
  });

  test("recovers an abandoned lock older than thirty seconds", async () => {
    const { path, store } = await fixture("providers: {}\n");
    const before = await store.list();
    const lockPath = `${path}.lock`;
    await Bun.write(lockPath, JSON.stringify({ pid: 999_999, createdAt: 0 }));
    const abandonedAt = new Date(Date.now() - 31_000);
    await utimes(lockPath, abandonedAt, abandonedAt);

    await store.put("recovered", {
      revision: before.revision,
      definition: { baseUrl: "https://recovered.example" },
    });

    expect((await store.list()).providers.map(({ id }) => id)).toContain("recovered");
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  test("deletes only the provider and leaves env assignments untouched", async () => {
    const { directory, path, store } = await fixture("providers:\n  removable:\n    baseUrl: https://remove.example\n    apiKey: REMOVABLE_API_KEY\n  keeper:\n    baseUrl: https://keep.example\n");
    const envName = apiKeyEnvironmentName("removable");
    await Bun.write(join(directory, ".env"), `${envName}=still-here\n`);
    const before = await store.list();

    const after = await store.delete("removable", before.revision);

    expect(after.providers.map(({ id }) => id)).toEqual(["keeper"]);
    expect(await readFile(join(directory, ".env"), "utf8")).toBe(`${envName}=still-here\n`);
    expect(await readFile(path, "utf8")).not.toContain("removable:");
  });
});
