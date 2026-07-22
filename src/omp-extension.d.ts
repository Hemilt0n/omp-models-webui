/**
 * Vendored type surface for the OMP (oh-my-pi) extension runtime.
 *
 * The real types live inside the `@oh-my-pi/pi-coding-agent` host package, which
 * is present at runtime (it is the OMP host) but intentionally NOT a dependency
 * of this repository — that keeps the package self-contained and makes
 * `bunx tsc --noEmit` deterministic regardless of whether the host is hoisted in
 * a parent `node_modules`. This module declares only the surfaces this plugin
 * uses; the host supplies the real `ExtensionAPI` to the default-exported factory
 * at runtime, and these types are erased.
 *
 * Keep in sync with the documented surface in
 * https://github.com/can1357/oh-my-pi/blob/HEAD/docs/extensions.md
 */

export type NotificationType = "info" | "warning" | "error";

export interface ExtensionLogger {
	debug(message: string, context?: unknown): void;
	info(message: string, context?: unknown): void;
	warn(message: string, context?: unknown): void;
	error(message: string, context?: unknown): void;
}

export interface ExtensionUIContext {
	notify(message: string, type?: NotificationType): void;
	setStatus(key: string, text: string | undefined): void;
}

export interface ExtensionCommandContext {
	readonly ui: ExtensionUIContext;
	readonly cwd: string;
	hasPendingMessages(): boolean;
}

export interface CommandArgumentCompletion {
	label: string;
	value: string;
	description?: string;
}

export interface CommandDefinition {
	description: string;
	/** Optional slash-command argument completion provider. */
	getArgumentCompletions?: (prefix: string) => CommandArgumentCompletion[];
	/** Command handler. `args` is the raw text typed after the command name. */
	handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

/**
 * Surface of the OMP extension API consumed by this plugin. Only the methods
 * used here are declared; the real API is far larger (see OMP docs).
 */
export interface ExtensionAPI {
	setLabel(label: string): void;
	registerCommand(name: string, definition: CommandDefinition): void;
	/** Subscribe to a lifecycle event such as `session_shutdown`. */
	on(event: "session_shutdown", handler: () => void | Promise<void>): void;
	readonly logger: ExtensionLogger;
}

/** Extension module default export: a factory receiving the OMP extension API. */
export type ExtensionFactory = (pi: ExtensionAPI) => void;
