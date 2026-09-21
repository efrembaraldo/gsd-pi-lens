// flake-shape: raw-timer-wait — explicit microtask-yield before asserting safeSpawnAsyncMock was never called; deferred work must have a real turn to fire

/**
 * T03 of M001/S04 — pins that the production `handleSessionStart` path
 * populates `runtime.errorDebtBaseline` only when the opt-in flag
 * `error-debt-baseline` is on AND the structural guards let the task through.
 *
 * Five gates are covered (each its own `it`):
 *   1. flag off              → task runs, exits on flag check, no spawn, baseline null
 *   2. flag on + full + JS/TS → spawn npm test + npm run build succeed, baseline populated
 *   3. flag on + quick mode    → quick path skips startup_scans entirely, baseline null
 *   4. flag on + session replacement → second `isCurrentSession` returns false, baseline null
 *   5. flag on + non-JS/TS     → `canRunJsTsHeavyScans` is false, function returns early, baseline null
 *
 * The default `errorDebtBaseline` on the runtime mock is `null` so "stays
 * null" reads as a real observation, not a stale sibling-test carry-over.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LatencyEntry } from "../../clients/latency-logger.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);

// Hoist the mock implementation holder so the `vi.mock` factory (which
// vitest hoists above all imports) can reference it before the const
// below is initialized. The actual `vi.fn` is attached after the mock
// factory returns so per-test overrides (case 4) can layer on top.
const safeSpawnMockHolder = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 0 })),
}));

vi.mock("../../clients/latency-logger.js", async (importActual) => ({
	...((await importActual()) as typeof import("../../clients/latency-logger.js")),
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

vi.mock("../../clients/lsp/config.js", async (importActual) => ({
	...((await importActual()) as typeof import("../../clients/lsp/config.js")),
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", async (importActual) => ({
	...((await importActual()) as typeof import("../../clients/lsp/index.js")),
	getLSPService: vi.fn(() =>
		makeLspServiceDouble({
			touchFile: vi.fn().mockResolvedValue(undefined),
			supportsLSP: () => false,
		}),
	),
}));

vi.mock("../../clients/safe-spawn.js", async (importActual) => ({
	...((await importActual()) as typeof import("../../clients/safe-spawn.js")),
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: safeSpawnMockHolder.safeSpawnAsync,
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

const safeSpawnAsyncMock = safeSpawnMockHolder.safeSpawnAsync;

vi.mock("../../clients/installer/index.js", async (importActual) => ({
	...((await importActual()) as typeof import("../../clients/installer/index.js")),
	ensureTool: vi.fn(async () => undefined),
	resetResolvedPathCache: vi.fn(),
	isSpawnableCommand: vi.fn(async () => false),
	resetPathWalkMemo: vi.fn(),
}));

import { handleSessionStart } from "../../clients/runtime-session.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

interface RuntimeMock {
	sessionGeneration: number;
	isCurrentSession: (generation: number) => boolean;
	markStartupScanInFlight: () => void;
	clearStartupScanInFlight: () => void;
	complexityBaselines: Map<unknown, unknown>;
	resetForSession: () => void;
	projectRoot: string;
	projectRulesScan: { hasCustomRules: boolean; rules: unknown[] };
	cachedExports: Map<unknown, unknown>;
	errorDebtBaseline: { testsPassed: boolean; buildPassed: boolean } | null;
}

function makeRuntime(overrides: Partial<RuntimeMock> = {}): RuntimeMock {
	return {
		sessionGeneration: 1,
		isCurrentSession: () => true,
		markStartupScanInFlight: () => {},
		clearStartupScanInFlight: () => {},
		complexityBaselines: new Map(),
		resetForSession: () => {},
		projectRoot: "",
		projectRulesScan: { hasCustomRules: false, rules: [] },
		cachedExports: new Map(),
		errorDebtBaseline: null,
		...overrides,
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeps(ctxCwd: string, runtime: RuntimeMock, getFlag: (name: string) => unknown) {
	return withResidentBootstrap({
		ctxCwd,
		getFlag,
		notify: vi.fn(),
		dbg: () => {},
		log: () => {},
		runtime,
		metricsClient: { reset: () => {} },
		cacheManager: { writeCache: () => {}, readCache: () => null },
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		astGrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			scanExports: async () => new Map(),
		},
		biomeClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		knipClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		jscpdClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		testRunnerClient: {
			detectRunner: () => ({ runner: "vitest", config: null }),
			runTestFile: () => ({ failed: 1, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any;
}

function setStartupMode(mode: "full" | "quick"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

describe("error-debt-baseline population in production session_start (M001/S04/T03)", () => {
	let tmpDir: string;
	let restoreStartupMode: () => void;

	beforeEach(() => {
		vi.clearAllMocks();
		latencyEntries.length = 0;
		tmpDir = setupTestEnvironment("pi-lens-errdebt-").tmpDir;
		restoreStartupMode = setStartupMode("full");
	});

	/**
	 * Materialize a minimal JS/TS project layout so
	 * `detectProjectLanguageProfile` reports `present.jsts === true` and the
	 * deferred-scan block in `handleSessionStart` (which contains the
	 * `error-debt-baseline` task) is reached. Without a TS file,
	 * `canRunJsTsHeavyScans` returns false and the function returns BEFORE
	 * scheduling the deferred tasks at all.
	 */
	function makeJsTsProject(dir: string): void {
		fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
		fs.writeFileSync(path.join(dir, "index.ts"), "export const x = 1;\n");
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				name: "errdebt-fixture",
				version: "0.0.0",
				scripts: { test: "echo ok", build: "echo ok" },
			}),
		);
	}

	afterEach(() => {
		restoreStartupMode?.();
		removeTempDirSync(tmpDir);
	});

	it("stays null when the flag is off (no spawns)", async () => {
		vi.useFakeTimers();
		try {
			const runtime = makeRuntime();
			const getFlag = vi.fn((name: string) =>
				name === "error-debt-baseline" ? false : false,
			);
			await handleSessionStart(makeDeps(tmpDir, runtime, getFlag));
			// Advance past the 5600ms deferral so the task actually runs.
			await vi.advanceTimersByTimeAsync(6000);

			expect(runtime.errorDebtBaseline).toBeNull();
			expect(safeSpawnAsyncMock).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("populates the baseline when the flag is on and the project is JS/TS (full mode)", async () => {
		vi.useFakeTimers();
		try {
			makeJsTsProject(tmpDir);
			const runtime = makeRuntime();
			const getFlag = vi.fn((name: string) =>
				name === "error-debt-baseline" ? true : false,
			);
			await handleSessionStart(makeDeps(tmpDir, runtime, getFlag));
			await vi.advanceTimersByTimeAsync(6000);

			expect(runtime.errorDebtBaseline).toEqual({
				testsPassed: true,
				buildPassed: true,
			});
			// The error-debt-baseline task fires exactly two safeSpawnAsync
			// calls (npm test, npm run build); the full-mode startup may also
			// spawn tools/installer probes, so we pin the ORDER and the npm
			// argv via the per-call assertions rather than the total count.
			const allCalls = safeSpawnAsyncMock.mock.calls as unknown as Array<
				[string, string[], object?]
			>;
			const isNpmTest = ([cmd, args]: [string, string[], object?]) =>
				cmd === "npm" && Array.isArray(args) && args[0] === "test";
			const isNpmBuild = ([cmd, args]: [string, string[], object?]) =>
				cmd === "npm" && args[0] === "run" && args[1] === "build";
			expect(allCalls.filter(isNpmTest)).toHaveLength(1);
			expect(allCalls.filter(isNpmBuild)).toHaveLength(1);
			// npm test fires before npm run build (the task's first spawn is
			// the test, the second is the build).
			const npmTestIdx = allCalls.findIndex(isNpmTest);
			const npmBuildIdx = allCalls.findIndex(isNpmBuild);
			expect(npmTestIdx).toBeLessThan(npmBuildIdx);
			expect(safeSpawnAsyncMock).toHaveBeenNthCalledWith(
				npmTestIdx + 1,
				"npm",
				["test"],
				expect.objectContaining({ cwd: expect.any(String) }),
			);
			expect(safeSpawnAsyncMock).toHaveBeenNthCalledWith(
				npmBuildIdx + 1,
				"npm",
				["run", "build"],
				expect.objectContaining({ cwd: expect.any(String) }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stays null in quick mode regardless of the flag (quick path skips startup_scans entirely)", async () => {
		restoreStartupMode();
		restoreStartupMode = setStartupMode("quick");

		const runtime = makeRuntime();
		const getFlag = vi.fn((name: string) =>
			name === "error-debt-baseline" ? true : false,
		);
		await handleSessionStart(makeDeps(tmpDir, runtime, getFlag));
		// Give any deferred work the runtime might schedule a chance to fire —
		// there should be none, but assert it explicitly.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(runtime.errorDebtBaseline).toBeNull();
		expect(safeSpawnAsyncMock).not.toHaveBeenCalled();
	});

	it("stays null when isCurrentSession turns false after the first guard (session replacement)", async () => {
		vi.useFakeTimers();
		try {
			makeJsTsProject(tmpDir);
			// Link `isCurrentSession` to `safeSpawnAsync`: every other task's
			// guard sees `true` (they never spawn), so the first call here
			// returns true regardless of which task fires first. Once the
			// error-debt-baseline task reaches its first safeSpawnAsync, the
			// second guard observes `false` — a session-replacement scenario
			// captured deterministically without races between sibling tasks.
			let errorDebtSpawnFired = false;
			const linkedSpawnMock = vi.fn(async () => {
				errorDebtSpawnFired = true;
				return { stdout: "", stderr: "", status: 0 };
			});
			safeSpawnAsyncMock.mockImplementation(linkedSpawnMock);

			const runtime = makeRuntime({
				isCurrentSession: () => !errorDebtSpawnFired,
			});
			const getFlag = vi.fn((name: string) =>
				name === "error-debt-baseline" ? true : false,
			);
			await handleSessionStart(makeDeps(tmpDir, runtime, getFlag));
			await vi.advanceTimersByTimeAsync(6000);

			expect(runtime.errorDebtBaseline).toBeNull();
			// The flag was on and the first guard passed, so the test spawn
			// ran before the post-spawn guard fired — verify the guard pattern
			// observed the spawn rather than no-op'd at the top.
			expect(linkedSpawnMock).toHaveBeenCalledTimes(1);
			expect(safeSpawnAsyncMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stays null for non-JS/TS projects (canRunJsTsHeavyScans is false, function returns early)", async () => {
		// No `makeJsTsProject` call here — empty tmpDir has no JS/TS files,
		// so `detectProjectLanguageProfile` reports `present.jsts === false`
		// and `handleSessionStart` returns BEFORE scheduling any runTask.
		const runtime = makeRuntime();
		const getFlag = vi.fn((name: string) =>
			name === "error-debt-baseline" ? true : false,
		);
		await handleSessionStart(makeDeps(tmpDir, runtime, getFlag));
		expect(runtime.errorDebtBaseline).toBeNull();
		expect(safeSpawnAsyncMock).not.toHaveBeenCalled();
	});
});
