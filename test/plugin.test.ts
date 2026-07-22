import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { DEFAULT_SERVER_PORT, isPortInUseError, startServer } from "../src/server";
import {
	ModelsUiServerManager,
	handleModelsUi,
	helpText,
	parseModelsUiCommand,
} from "../src/plugin";
import type { ExtensionCommandContext } from "../src/omp-extension";

// Track every server/tempdir created so nothing leaks across tests (Bun servers
// are ref'd and would keep the process alive if left running).
const servers: Bun.Server<unknown>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		try {
			server.stop(true);
		} catch {
			// ignore
		}
	}
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function blockerServer(): Bun.Server<unknown> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("blocker") });
	servers.push(server);
	return server;
}

/** Bind a port-0 server, read its assigned port, then release it. */
async function freePort(): Promise<number> {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const port = probe.port ?? 0;
	probe.stop(true);
	return port;
}

/** Isolated ConfigStore so tests never touch the real ~/.omp/agent/models.yml. */
async function isolatedStore(): Promise<ConfigStore> {
	const dir = await mkdtemp(join(tmpdir(), "omp-plugin-"));
	tempDirs.push(dir);
	await Bun.write(join(dir, "models.yml"), "providers: {}\n");
	return new ConfigStore(join(dir, "models.yml"));
}

describe("startServer autoPort", () => {
	test("binds the preferred port when it is free", async () => {
		const port = await freePort();
		const server = startServer({ port, autoPort: true, store: await isolatedStore() });
		servers.push(server);
		expect(server.port).toBe(port);
	});

	test("walks to the next free port when the preferred one is occupied", async () => {
		const blocker = blockerServer();
		const occupied = blocker.port ?? 0;
		const server = startServer({ port: occupied, autoPort: true, store: await isolatedStore() });
		servers.push(server);
		expect(server.port).toBeGreaterThan(occupied);
	});

	test("throws synchronously on an occupied port when autoPort is disabled", async () => {
		const blocker = blockerServer();
		const store = await isolatedStore();
		expect(() => startServer({ port: blocker.port, store })).toThrow();
	});

	test("rejects an out-of-range preferred port regardless of autoPort", async () => {
		expect(() => startServer({ port: 0, autoPort: true })).toThrow();
		expect(() => startServer({ port: 70_000, autoPort: true })).toThrow();
	});
});

describe("isPortInUseError", () => {
	test("matches Bun's in-use phrasing and EADDRINUSE", () => {
		expect(isPortInUseError(new Error("Failed to start server. Is port 4380 in use?"))).toBe(true);
		expect(isPortInUseError(new Error("listen EADDRINUSE: address already in use"))).toBe(true);
		expect(isPortInUseError(new Error("permission denied"))).toBe(false);
		expect(isPortInUseError(undefined)).toBe(false);
	});
});

describe("ModelsUiServerManager", () => {
	test("starts once, reuses on repeat start, then stops", async () => {
		const port = await freePort();
		const manager = new ModelsUiServerManager();
		try {
			expect(manager.running).toBe(false);
			expect(manager.info).toBeNull();

			const first = manager.start(port, { store: await isolatedStore() });
			expect(first.reused).toBe(false);
			expect(first.port).toBe(port);
			expect(first.url).toBe(`http://127.0.0.1:${port}`);
			expect(manager.running).toBe(true);
			expect(manager.info?.url).toBe(first.url);

			// A second start (even with a different preferred port) reuses the running server.
			const second = manager.start(port + 100);
			expect(second.reused).toBe(true);
			expect(second.port).toBe(port);
			expect(second.url).toBe(first.url);

			expect(manager.stop()).toBe(true);
			expect(manager.running).toBe(false);
			expect(manager.info).toBeNull();
			expect(manager.stop()).toBe(false);
		} finally {
			manager.stop();
		}
	});

	test("auto-selects the next free port and serves the UI on it", async () => {
		const blocker = blockerServer();
		const occupied = blocker.port ?? 0;
		const manager = new ModelsUiServerManager();
		try {
			const info = manager.start(occupied, { store: await isolatedStore() });
			expect(info.reused).toBe(false);
			expect(info.port).toBeGreaterThan(occupied);

			const response = await fetch(info.url);
			expect(response.status).toBe(200);
		} finally {
			manager.stop();
		}
	});

	test("stopping the manager never touches an independently started server", async () => {
		const external = blockerServer();
		const manager = new ModelsUiServerManager();
		try {
			const info = manager.start(await freePort(), { store: await isolatedStore() });
			expect(info.port).not.toBe(external.port);

			expect(manager.stop()).toBe(true);

			// The standalone (independent) server must still respond.
			const response = await fetch(`http://${external.hostname}:${external.port}/`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("blocker");
		} finally {
			manager.stop();
		}
	});
});

describe("handleModelsUi", () => {
	test("opens the browser on fresh start and again when reusing the running server", async () => {
		const port = await freePort();
		const manager = new ModelsUiServerManager();
		const opened: string[] = [];
		const notices: string[] = [];
		const ctx = {
			ui: {
				notify: (message: string) => {
					notices.push(message);
				},
				setStatus: () => {},
			},
			cwd: process.cwd(),
			hasPendingMessages: () => false,
		} as unknown as ExtensionCommandContext;
		const open = (url: string): boolean => {
			opened.push(url);
			return true;
		};
		try {
			await handleModelsUi(String(port), ctx, manager, open);
			expect(manager.running).toBe(true);
			expect(opened).toEqual([`http://127.0.0.1:${port}`]);

			// 重复执行：复用已运行的服务，仍然直接打开页面。
			await handleModelsUi(String(port), ctx, manager, open);
			expect(opened).toEqual([`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}`]);
			expect(notices.at(-1)).toContain("已在运行");
		} finally {
			manager.stop();
		}
	});
});

describe("parseModelsUiCommand", () => {
	test("maps bare and explicit start forms to the default port", () => {
		expect(parseModelsUiCommand("")).toEqual({ kind: "start", port: DEFAULT_SERVER_PORT });
		expect(parseModelsUiCommand("   ")).toEqual({ kind: "start", port: DEFAULT_SERVER_PORT });
		expect(parseModelsUiCommand("start")).toEqual({ kind: "start", port: DEFAULT_SERVER_PORT });
	});

	test("parses an explicit in-range port", () => {
		expect(parseModelsUiCommand("4390")).toEqual({ kind: "start", port: 4390 });
		expect(parseModelsUiCommand("  4390  ")).toEqual({ kind: "start", port: 4390 });
		expect(parseModelsUiCommand("65535")).toEqual({ kind: "start", port: 65535 });
	});

	test("maps control subcommands", () => {
		expect(parseModelsUiCommand("stop")).toEqual({ kind: "stop" });
		expect(parseModelsUiCommand("status")).toEqual({ kind: "status" });
		expect(parseModelsUiCommand("help")).toEqual({ kind: "help" });
	});

	test("falls back to help for invalid arguments", () => {
		expect(parseModelsUiCommand("0")).toEqual({ kind: "help" });
		expect(parseModelsUiCommand("99999")).toEqual({ kind: "help" });
		expect(parseModelsUiCommand("1.5")).toEqual({ kind: "help" });
		expect(parseModelsUiCommand("not-a-port")).toEqual({ kind: "help" });
	});
});

describe("helpText", () => {
	test("documents every subcommand and the loopback constraint", () => {
		const text = helpText();
		expect(text).toContain("/models-ui");
		expect(text).toContain("stop");
		expect(text).toContain("status");
		expect(text).toContain("help");
		expect(text).toContain("127.0.0.1");
	});
});
