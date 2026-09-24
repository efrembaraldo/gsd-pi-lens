import {
	spawn,
	spawnSync,
	type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
	cpSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
	sweepScratchDirs,
} from "../../scripts/lib/scratch-dir.mjs";

// flake-shape: raw-timer-wait — the bounded timeout waits for real child progress, and the bounded log poll waits for the real child's async log writes to land

type JsonObject = Record<string, unknown>;
type HarnessEvent = JsonObject & { event?: string; type?: string };
class RealPiChildExitError extends Error {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;

	constructor(code: number | null, signal: NodeJS.Signals | null) {
		super(
			`real pi child exited (code ${code ?? "null"}, signal ${signal ?? "none"})`,
		);
		this.name = "RealPiChildExitError";
		this.code = code;
		this.signal = signal;
	}
}
export type Script = Array<
	Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; name: string; id?: string; arguments?: JsonObject }
	>
>;
export type RealPi = {
	prompt(text: string): Promise<JsonObject>;
	getState(): Promise<JsonObject>;
	getCommands(): Promise<JsonObject>;
	newSession(): Promise<JsonObject>;
	events(kind: string): Promise<ReadonlyArray<HarnessEvent>>;
	toolResults(): ReadonlyArray<HarnessEvent>;
	awaitAssistantTurn(): Promise<HarnessEvent>;
	awaitToolResult(name: string): Promise<HarnessEvent>;
	killChildForTest(): void;
	providerObservations(): ReadonlyArray<JsonObject>;
	projectPath(): string;
	lens: {
		latencyRows(): ReadonlyArray<JsonObject>;
		extensionLog(): ReadonlyArray<JsonObject>;
		sessionStartLog(): ReadonlyArray<string>;
		degradations(): ReadonlyArray<JsonObject>;
	};
};
type RpcMessage = HarnessEvent;
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
export const realHarnessFixtureRoot = path.join(
	repoRoot,
	"tests/fixtures/real-harness",
);
const fixtureRoot = realHarnessFixtureRoot;
// The host this fork targets is @opengsd/gsd-pi, whose bin is `gsd` (the
// upstream `pi` binary does not exist in this ecosystem). Exported so every
// real-harness availability probe spawns the same binary the harness does.
export const REAL_HOST_BINARY = "gsd";
// Every real-harness file spawns REAL_HOST_BINARY as a real OS process — on
// a machine without it (a bare CI runner, unlike the dev host where gsd-pi
// is globally npm-installed), spawn() fails with an 'error' event, not an
// 'exit' event, and every file's own withRealPi() call throws
// RealPiChildExitError before the test's own assertions ever run. Computed
// once at module load and shared, so `describe.skipIf(!REAL_PI_AVAILABLE)`
// skips visibly instead of failing on every machine lacking the binary.
export const REAL_PI_AVAILABLE: boolean =
	spawnSync(REAL_HOST_BINARY, ["--version"], { stdio: "ignore" }).status === 0;
// gsd's top-level CLI parser (src/cli-web-branch.ts: parseCliArgs) rejects any
// flag outside its own whitelist, and src/cli.ts never forwards extension-
// registered flag values to the session. A scenario whose precondition IS a
// pi-lens CLI flag therefore cannot run against this host: it skips on this
// constant instead of silently proving something weaker. Flip it together with
// REAL_HOST_BINARY if the host ever forwards extension flags; the harness then
// passes such flags on argv instead of translating them.
export const REAL_HOST_FORWARDS_EXTENSION_FLAGS: boolean = false;
// gsd has no `--provider` flag: `--model` takes `<provider>/<model-id>` and is
// resolved after extension-registered providers are flushed into the model
// registry (src/cli.ts: flushPendingProviderRegistrations -> applyModelOverride).
const SCRIPTED_MODEL = "scripted/harness";

export function validateScript(value: unknown, source = "script.json"): Script {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error(`${source} must be a non-empty array of turns`);
	for (const [turnIndex, turn] of value.entries()) {
		if (!Array.isArray(turn) || turn.length === 0)
			throw new Error(`${source} turn ${turnIndex} must be a non-empty array`);
		for (const [actionIndex, action] of turn.entries()) {
			if (
				!action ||
				typeof action !== "object" ||
				typeof (action as JsonObject).type !== "string"
			)
				throw new Error(
					`${source} turn ${turnIndex} action ${actionIndex} must have a type field`,
				);
			const record = action as JsonObject;
			if (record.type === "text" && typeof record.text !== "string")
				throw new Error(
					`${source} turn ${turnIndex} action ${actionIndex} text must be a string`,
				);
			if (record.type === "toolCall" && typeof record.name !== "string")
				throw new Error(
					`${source} turn ${turnIndex} action ${actionIndex} name must be a string`,
				);
			if (record.type !== "text" && record.type !== "toolCall")
				throw new Error(
					`${source} turn ${turnIndex} action ${actionIndex} has unsupported type ${String(record.type)}`,
				);
		}
	}
	return value as Script;
}

function fixtureProject(scenario: string, root: string): string {
	const dir = claimScratchDir(root, `real-pi-${scenario}-project`);
	writeFileSync(path.join(dir, "guarded.ts"), "export const value = 1;\n");
	writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
	return dir;
}

// gsd's top-level CLI parser (src/cli-web-branch.ts: parseCliArgs) throws
// "Unknown option" for any flag outside its own whitelist, and gsd never
// forwards extension-registered flag values to the session — so pi-lens flags
// cannot travel on the gsd argv. A flag is translated into the global config
// ONLY when that is semantically identical: `--no-lazy-tools` maps to
// `tools.lazy=false`, a `scope: "global"` key no project config can override.
// `--no-tool=<name>` is deliberately NOT translated: tool enablement resolves
// CLI > project > global (clients/tool-config.ts: resolveLensToolEnabled), so
// a global `tools.<name>.enabled=false` loses to a project config that enables
// the tool — the one case the CLI flag exists to win. Anything untranslatable
// fails loudly: silently weakening a precondition would let a scenario pass
// while proving something else.
function lensFlagArgsToGlobalConfig(
	args: readonly string[],
): JsonObject | undefined {
	if (args.length === 0) return undefined;
	const tools: JsonObject = {};
	for (const arg of args) {
		if (arg === "--no-lazy-tools") {
			tools.lazy = false;
			continue;
		}
		throw new Error(
			`real-harness: pi-lens flag ${arg} has no gsd CLI channel (gsd rejects extension flags) and no semantically equivalent global-config translation`,
		);
	}
	return { tools };
}

function startRealPi(
	scenario: string,
	scriptFile: string,
	homeOverride?: string,
	args: readonly string[] = [],
	env: Record<string, string> = {},
) {
	const scratchRoot = homeOverride ?? SCRATCH_DIR_ROOT;
	sweepScratchDirs(scratchRoot, "real-pi-", { maxAgeMs: 0 });
	const project = fixtureProject(scenario, scratchRoot);
	const home = homeOverride ?? claimScratchDir(scratchRoot, "real-pi-home");
	cpSync(path.join(fixtureRoot, scenario, "project"), project, {
		recursive: true,
	});
	const providerLog = path.join(home, "provider.jsonl");
	const globalConfig = REAL_HOST_FORWARDS_EXTENSION_FLAGS
		? undefined
		: lensFlagArgsToGlobalConfig(args);
	const globalConfigPath = path.join(home, "pi-lens-global-config.json");
	if (globalConfig)
		writeFileSync(globalConfigPath, JSON.stringify(globalConfig));
	const child: ChildProcessWithoutNullStreams = spawn(
		REAL_HOST_BINARY,
		[
			"--mode",
			"rpc",
			"--no-session",
			"--model",
			SCRIPTED_MODEL,
			// gsd accepts only the long form; `-e` is "Unknown option".
			"--extension",
			path.join(repoRoot, "index.js"),
			"--extension",
			path.join(fixtureRoot, "scripted-provider.mjs"),
			...(REAL_HOST_FORWARDS_EXTENSION_FLAGS ? args : []),
		],
		{
			cwd: project,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				// Keep the real host outside Vitest's runner-only rethrow mode.
				VITEST: undefined,
				PI_LENS_HOME: home,
				HOME: home,
				REAL_PI_HARNESS_SCRIPT: scriptFile,
				REAL_PI_HARNESS_PROVIDER_LOG: providerLog,
				ANTHROPIC_API_KEY: "sk-ant-real-harness-dummy",
				...(globalConfig ? { PI_LENS_CONFIG_PATH: globalConfigPath } : {}),
				...env,
			},
		},
	);
	const events: RpcMessage[] = [];
	const waiters = new Map<
		string,
		Array<{
			timer: NodeJS.Timeout;
			predicate: (message: RpcMessage) => boolean;
			resolve: (message: RpcMessage) => void;
			reject: (error: Error) => void;
		}>
	>();
	let childFailure: RealPiChildExitError | undefined;
	const rejectPending = (error: RealPiChildExitError) => {
		childFailure = error;
		for (const pending of waiters.values()) {
			for (const waiter of pending) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		}
		waiters.clear();
	};
	child.once("error", (error) => {
		if (!childFailure) rejectPending(new RealPiChildExitError(null, null));
		else void error;
	});
	child.once("exit", (code, signal) => {
		if (!childFailure) rejectPending(new RealPiChildExitError(code, signal));
	});
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		let end = buffer.indexOf("\n");
		while (end >= 0) {
			const line = buffer.slice(0, end).replace(/\r$/, "");
			buffer = buffer.slice(end + 1);
			end = buffer.indexOf("\n");
			if (!line.trim()) continue;
			try {
				const message = JSON.parse(line) as RpcMessage;
				events.push(message);
				for (const key of [message.id, message.event, message.type]) {
					const pending = waiters.get(String(key));
					if (!pending) continue;
					const remaining = pending.filter((waiter) => {
						if (!waiter.predicate(message)) return true;
						clearTimeout(waiter.timer);
						waiter.resolve(message);
						return false;
					});
					if (remaining.length) waiters.set(String(key), remaining);
					else waiters.delete(String(key));
				}
			} catch {
				/* protocol owns stdout */
			}
		}
	});
	const waitFor = (
		key: string,
		predicate: (message: RpcMessage) => boolean = () => true,
	) =>
		new Promise<RpcMessage>((resolve, reject) => {
			if (childFailure) {
				reject(childFailure);
				return;
			}
			const timer = setTimeout(() => {
				waiters.delete(key);
				reject(new Error(`timed out waiting for ${key}`));
			}, 60_000);
			const waiter = {
				timer,
				predicate,
				resolve,
				reject,
			};
			waiters.set(key, [...(waiters.get(key) ?? []), waiter]);
		});
	const request = (type: string, fields: RpcMessage = {}) => {
		const id = `${type}-${Date.now()}-${Math.random()}`;
		const response = waitFor(id);
		child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
		return response;
	};
	return {
		child,
		project,
		home,
		events,
		request,
		waitFor,
		killChildForTest: () => child.kill("SIGKILL"),
		providerObservations: () =>
			readFileSync(providerLog, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as JsonObject),
		async close() {
			child.stdin.end();
			child.kill("SIGKILL");
			rmSync(project, { recursive: true, force: true });
			if (!homeOverride) rmSync(home, { recursive: true, force: true });
		},
	};
}

export async function withRealPi<T>(
	options: {
		fixture: string;
		script: string;
		home?: string;
		args?: readonly string[];
		env?: Record<string, string>;
	},
	callback: (pi: RealPi) => Promise<T>,
): Promise<T> {
	const fixture = options.fixture;
	const scriptFile = path.join(fixtureRoot, fixture, options.script);
	if (!existsSync(scriptFile))
		throw new Error(`real-harness fixture: ${options.script} does not exist`);
	validateScript(JSON.parse(readFileSync(scriptFile, "utf8")), scriptFile);
	const harness = startRealPi(
		fixture,
		scriptFile,
		options.home,
		options.args,
		options.env,
	);
	try {
		let cursor = harness.events.length;
		const matches = (kind: string, after: number) =>
			harness.events
				.slice(after)
				.filter((event) => event.event === kind || event.type === kind);
		const waitEvent = async (
			kind: string,
			after: number,
			predicate: (event: RpcMessage) => boolean = () => true,
		) => {
			const existing = matches(kind, after).filter(predicate);
			if (existing.length) return existing[existing.length - 1];
			return harness.waitFor(
				kind,
				(event) => harness.events.indexOf(event) > after && predicate(event),
			);
		};
		const pi: RealPi = {
			getCommands: () => harness.request("get_commands"),
			getState: () => harness.request("get_state"),
			newSession: async () => {
				cursor = harness.events.length;
				return harness.request("new_session");
			},
			prompt: async (message) => {
				cursor = harness.events.length;
				return harness.request("prompt", { message });
			},
			events: async (kind) => {
				const event = await waitEvent(kind, cursor);
				cursor = harness.events.indexOf(event) + 1;
				return [event];
			},
			awaitAssistantTurn: async () => {
				const event = await waitEvent(
					"message_end",
					cursor,
					(candidate) =>
						(candidate.message as JsonObject | undefined)?.role === "assistant",
				);
				cursor = harness.events.indexOf(event) + 1;
				return event;
			},
			awaitToolResult: async (name) => {
				const event = await waitEvent("tool_execution_end", cursor);
				const toolName =
					event.toolName ?? event.name ?? (event as JsonObject).tool_name;
				if (toolName !== name)
					throw new Error(
						`expected tool result ${name}, received ${String(toolName)}`,
					);
				cursor = harness.events.indexOf(event) + 1;
				return event;
			},
			killChildForTest: harness.killChildForTest,
			toolResults: () =>
				harness.events.filter(
					(event) =>
						event.event === "tool_execution_end" ||
						event.type === "tool_execution_end",
				),
			providerObservations: () => harness.providerObservations(),
			projectPath: () => harness.project,
			lens: {
				latencyRows: () => readRows(path.join(harness.home, "latency.log")),
				extensionLog: () => readRows(path.join(harness.home, "extension.log")),
				sessionStartLog: () =>
					readLines(path.join(harness.home, "sessionstart.log")),
				degradations: () =>
					readRows(path.join(harness.home, "degradation-ledger.json")),
			},
		};
		await harness.request("get_commands");
		return await callback(pi);
	} finally {
		await harness.close();
	}
}

// pi-lens's NDJSON sinks are synchronous-call, async-write
// (clients/ndjson-logger.ts): a line enqueued before the turn ended can still
// be in flight when an assertion reads the file, and a one-shot read then sees
// no file at all. Re-read until `done` holds or the budget elapses, and return
// the LAST read either way, so the caller's own assertion reports the real
// value (including "more than once") instead of a synthetic timeout.
export async function pollLensLog<T>(
	read: () => T,
	done: (value: T) => boolean,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let value = read();
	while (!done(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		value = read();
	}
	return value;
}

function readRows(file: string): JsonObject[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const row = JSON.parse(line) as unknown;
				return row && typeof row === "object" ? [row as JsonObject] : [];
			} catch {
				return [];
			}
		});
}

function readLines(file: string): string[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean);
}
