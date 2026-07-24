/**
 * OMP (oh-my-pi) extension entry point — thin plugin around the existing
 * `Bun.serve` web UI in `server.ts`.
 *
 * Registers a `/models-ui` slash command that starts the local management
 * server (reusing it across invocations), reports its URL, optionally opens a
 * browser, and stops the server when the OMP session shuts down. The plugin
 * never duplicates the config/discovery/security logic — it only owns server
 * lifecycle. See issue #1.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "./omp-extension";
import { DEFAULT_SERVER_PORT, startServer, type StartServerOptions } from "./server";
import { ConfigStore } from "./config-store";

// ============================================================================
// Server lifecycle manager (dependency-free, unit-testable)
// ============================================================================

export interface ManagedServerInfo {
	/** Absolute URL of the running server, e.g. `http://127.0.0.1:4390`. */
	url: string;
	hostname: string;
	port: number;
	/** True when an already-running server was returned instead of binding a new one. */
	reused: boolean;
}

/**
 * Owns the in-process `Bun.Server` started by the plugin. A single module-level
 * instance (see bottom of file) is reused across `/models-ui` invocations so the
 * command is idempotent. Stopping it only ever closes a server this manager
 * started — a standalone `bun run start` lives in a separate process and is
 * never touched.
 */
export class ModelsUiServerManager {
	private server: Bun.Server<unknown> | null = null;

	get running(): boolean {
		return this.server !== null;
	}

	get info(): ManagedServerInfo | null {
		const server = this.server;
		if (!server) return null;
		return describe(server, false);
	}

	/**
	 * Start the server on `preferredPort`, or reuse the running one. With
	 * `autoPort` the next free port is chosen when the preferred one is bound.
	 * Throws if no port can be claimed.
	 */
	start(
		preferredPort: number,
		options: Omit<StartServerOptions, "port" | "autoPort"> = {},
	): ManagedServerInfo {
		const existing = this.server;
		if (existing) return describe(existing, true);

		const server = startServer({ ...options, port: preferredPort, autoPort: true });
		this.server = server;
		return describe(server, false);
	}

	/** Stop and forget the running server. Returns false when nothing was running. */
	stop(): boolean {
		const server = this.server;
		if (!server) return false;
		this.server = null;
		try {
			server.stop(true);
		} catch {
			// Best-effort teardown; the server handle is already dropped.
		}
		return true;
	}
}

function describe(server: Bun.Server<unknown>, reused: boolean): ManagedServerInfo {
	// startServer binds hostname/port synchronously before returning, so both are defined.
	const hostname = server.hostname ?? "127.0.0.1";
	const port = server.port ?? 0;
	return {
		url: `http://${hostname}:${port}`,
		hostname,
		port,
		reused,
	};
}

// ============================================================================
// Command parsing
// ============================================================================

export type ModelsUiCommand =
	| { kind: "start"; port: number }
	| { kind: "stop" }
	| { kind: "status" }
	| { kind: "help" };

/** Parse the raw argument text of `/models-ui` into a structured command. */
export function parseModelsUiCommand(args: string): ModelsUiCommand {
	const value = args.trim();
	if (value.length === 0 || value === "start") return { kind: "start", port: DEFAULT_SERVER_PORT };
	if (value === "stop") return { kind: "stop" };
	if (value === "status") return { kind: "status" };
	if (value === "help") return { kind: "help" };
	const port = Number(value);
	if (value.length > 0 && Number.isInteger(port) && port >= 1 && port <= 65_535) {
		return { kind: "start", port };
	}
	return { kind: "help" };
}

export function helpText(): string {
	return [
		"OMP 模型管理 Web UI",
		"",
		"  /models-ui            启动（或复用）本地管理服务并打开浏览器",
		"  /models-ui <端口>      使用指定首选端口启动",
		"  /models-ui status      查看服务状态",
		"  /models-ui stop        停止由插件启动的服务",
		"  /models-ui help        显示此帮助",
		"",
		"服务仅监听 127.0.0.1；首选端口被占用时会自动选择下一个可用端口。",
		"重复执行命令会复用已在运行的服务并直接打开页面，不会启动多个实例。",
	].join("\n");
}

// ============================================================================
// Browser opening (best-effort, never fatal)
// ============================================================================

/**
 * Open `url` in the user's default browser via the platform-native command.
 * Returns false when the command could not be spawned; callers still surface
 * the URL either way. This runs an OS-level "open" command, never an arbitrary
 * user/configured command, so it is safe under the project's credential rules.
 */
export function openBrowser(url: string): boolean {
	const platform = process.platform;
	try {
		if (platform === "win32") {
			Bun.spawn(["cmd", "/c", "start", "", url], { stdio: ["ignore", "ignore", "ignore"] });
		} else {
			const command = platform === "darwin" ? "open" : "xdg-open";
			Bun.spawn([command, url], { stdio: ["ignore", "ignore", "ignore"] });
		}
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Command handler
// ============================================================================

async function handleModelsUi(
	args: string,
	ctx: ExtensionCommandContext,
	manager: ModelsUiServerManager,
	open: (url: string) => boolean = openBrowser,
): Promise<void> {
	const command = parseModelsUiCommand(args);
	switch (command.kind) {
		case "help": {
			ctx.ui.notify(helpText(), "info");
			return;
		}
		case "status": {
			const info = manager.info;
			ctx.ui.notify(info ? `OMP 模型管理服务正在运行：${info.url}` : "OMP 模型管理服务未运行，使用 /models-ui 启动。", "info");
			return;
		}
		case "stop": {
			ctx.ui.notify(manager.stop() ? "已停止 OMP 模型管理服务。" : "OMP 模型管理服务未运行。", "info");
			return;
		}
		case "start": {
			let info: ManagedServerInfo;
			try {
				info = manager.start(command.port, { store: getPluginStore() });
			} catch (error) {
				ctx.ui.notify(`启动失败：${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (info.reused) {
				// 复用已运行的服务时也直接打开页面：用户执行命令的意图是进入界面。
				open(info.url);
				ctx.ui.notify(`OMP 模型管理服务已在运行：${info.url}`, "info");
				return;
			}
			// startServer only resolves after a successful bind, so the service is listening now.
			open(info.url);
			ctx.ui.notify(
				info.port === command.port
					? `OMP 模型管理服务已启动：${info.url}`
					: `端口 ${command.port} 被占用，已改用 ${info.url}`,
				"info",
			);
			return;
		}
	}
}

export { handleModelsUi };

// ============================================================================
// Extension factory
// ============================================================================

/** Module-level manager: one per process, reused across command invocations. */
const manager = new ModelsUiServerManager();
/**
 * ConfigStore whose `onApiKeyPersisted` hook mirrors a freshly saved API key
 * into the live process environment. OMP parses `.env` only once at process
 * start, so without this an already-running OMP cannot see keys added
 * mid-session and reports the new model as unauthenticated. In Bun
 * `process.env` is the same reference as OMP's `Bun.env`/`$env`, which is read
 * live per request, so the new key takes effect on the next API call — no
 * restart needed. Only meaningful when the plugin runs in-process with OMP.
 */
export function createPluginStore(path?: string): ConfigStore {
	return new ConfigStore(path, {
		onApiKeyPersisted: (envName, value) => {
			process.env[envName] = value;
		},
	});
}

let pluginStore: ConfigStore | null = null;
function getPluginStore(): ConfigStore {
	if (!pluginStore) pluginStore = createPluginStore();
	return pluginStore;
}

export default function modelsUiPlugin(pi: ExtensionAPI): void {
	pi.setLabel("OMP Models Web UI");

	pi.registerCommand("models-ui", {
		description: "启动 OMP 模型管理 Web 界面（/models-ui [端口|stop|status|help]）",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["stop", "status", "help"];
			const base = prefix.length === 0 ? subcommands : subcommands.filter((s) => s.startsWith(prefix));
			return base.map((value) => ({ label: value, value, description: describeSubcommand(value) }));
		},
		handler: (args: string, ctx: ExtensionCommandContext) => handleModelsUi(args, ctx, manager),
	});

	pi.on("session_shutdown", () => {
		if (manager.running) {
			manager.stop();
			pi.logger.debug("OMP models web UI server stopped on session shutdown");
		}
	});
}

function describeSubcommand(value: string): string {
	switch (value) {
		case "stop":
			return "停止由插件启动的服务";
		case "status":
			return "查看服务状态";
		case "help":
			return "显示帮助";
		default:
			return "";
	}
}
