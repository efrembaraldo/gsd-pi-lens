import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPiLensGlobalConfigPath } from "../../clients/lens-config.js";
import {
	_resetMarkdownFrontmatterAlwaysReadCacheForTests,
	_resetRpcCacheForTests,
	_resetRunnerTimeoutFloorCacheForTests,
	getMarkdownFrontmatterAlwaysRead,
	getRpcMaxDiagnosticsPerResponse,
	getRpcResponseTtlMs,
	getRunnerTimeoutFloorMs,
} from "../../clients/runtime-config.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];
let previousConfigPath: string | undefined;
let previousFloor: string | undefined;
let previousRpcMax: string | undefined;
let previousRpcTtl: string | undefined;

function makeTempHome(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-runtime-config-"));
	tmpDirs.push(dir);
	return dir;
}

function writeConfig(home: string, contents: string): string {
	const configPath = getPiLensGlobalConfigPath(home);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, contents, "utf-8");
	return configPath;
}

beforeEach(() => {
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	previousFloor = process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS;
	previousRpcMax = process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE;
	previousRpcTtl = process.env.PI_LENS_RPC_RESPONSE_TTL_MS;
	delete process.env.PI_LENS_CONFIG_PATH;
	delete process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS;
	delete process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE;
	delete process.env.PI_LENS_RPC_RESPONSE_TTL_MS;
	_resetRunnerTimeoutFloorCacheForTests();
	_resetMarkdownFrontmatterAlwaysReadCacheForTests();
	_resetRpcCacheForTests();
});

afterEach(() => {
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	if (previousFloor === undefined)
		delete process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS;
	else process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = previousFloor;
	if (previousRpcMax === undefined)
		delete process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE;
	else process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE = previousRpcMax;
	if (previousRpcTtl === undefined)
		delete process.env.PI_LENS_RPC_RESPONSE_TTL_MS;
	else process.env.PI_LENS_RPC_RESPONSE_TTL_MS = previousRpcTtl;
	_resetRunnerTimeoutFloorCacheForTests();
	_resetMarkdownFrontmatterAlwaysReadCacheForTests();
	_resetRpcCacheForTests();
	for (const dir of tmpDirs.splice(0)) {
		removeTempDirSync(dir);
	}
});

describe("getRunnerTimeoutFloorMs", () => {
	it("returns 0 when neither config nor env is set", () => {
		const home = makeTempHome();
		// No config file written under this home.
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		expect(getRunnerTimeoutFloorMs()).toBe(0);
	});

	it("returns 0 — not NaN — when the env var is unset (regression: NaN poisoning Math.max)", () => {
		const home = makeTempHome();
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		const floor = getRunnerTimeoutFloorMs();
		expect(Number.isNaN(floor)).toBe(false);
		expect(floor).toBe(0);
	});

	it("reads from the env var when set", () => {
		const home = makeTempHome();
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "60000";
		expect(getRunnerTimeoutFloorMs()).toBe(60000);
	});

	it("rejects a non-numeric env var and returns 0", () => {
		const home = makeTempHome();
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "not-a-number";
		expect(getRunnerTimeoutFloorMs()).toBe(0);
	});

	it("rejects a negative env var and returns 0", () => {
		const home = makeTempHome();
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "-1000";
		expect(getRunnerTimeoutFloorMs()).toBe(0);
	});

	it("reads from the config file when set", () => {
		const home = makeTempHome();
		writeConfig(
			home,
			JSON.stringify({ dispatch: { runnerTimeoutFloorMs: 90000 } }),
		);
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		expect(getRunnerTimeoutFloorMs()).toBe(90000);
	});

	it("takes the maximum across config and env when both are set", () => {
		const home = makeTempHome();
		writeConfig(
			home,
			JSON.stringify({ dispatch: { runnerTimeoutFloorMs: 90000 } }),
		);
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "180000";
		expect(getRunnerTimeoutFloorMs()).toBe(180000);
	});

	it("memoizes — second call does not re-read the env var", () => {
		const home = makeTempHome();
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "60000";
		expect(getRunnerTimeoutFloorMs()).toBe(60000);

		// Mutate after first read; cache should hold the original value until reset.
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "120000";
		expect(getRunnerTimeoutFloorMs()).toBe(60000);

		_resetRunnerTimeoutFloorCacheForTests();
		expect(getRunnerTimeoutFloorMs()).toBe(120000);
	});
});

describe("getMarkdownFrontmatterAlwaysRead", () => {
	it("defaults to true when the config file is missing", () => {
		const home = makeTempHome();
		// No config file written under this home.
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		expect(getMarkdownFrontmatterAlwaysRead()).toBe(true);
	});

	it("defaults to true when the config is empty", () => {
		const home = makeTempHome();
		writeConfig(home, "{}");
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		expect(getMarkdownFrontmatterAlwaysRead()).toBe(true);
	});

	it("defaults to true when readGuard is present without a markdown block", () => {
		const home = makeTempHome();
		writeConfig(home, JSON.stringify({ readGuard: { enabled: true } }));
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		expect(getMarkdownFrontmatterAlwaysRead()).toBe(true);
	});

	it("defaults to true when markdown is present without frontmatterAlwaysRead", () => {
		const home = makeTempHome();
		writeConfig(home, JSON.stringify({ readGuard: { markdown: {} } }));
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		expect(getMarkdownFrontmatterAlwaysRead()).toBe(true);
	});

	it("reads true when explicitly set to true in config", () => {
		const home = makeTempHome();
		writeConfig(
			home,
			JSON.stringify({
				readGuard: { markdown: { frontmatterAlwaysRead: true } },
			}),
		);
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		expect(getMarkdownFrontmatterAlwaysRead()).toBe(true);
	});

	it("reads false when explicitly set to false in config", () => {
		const home = makeTempHome();
		writeConfig(
			home,
			JSON.stringify({
				readGuard: { markdown: { frontmatterAlwaysRead: false } },
			}),
		);
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		expect(getMarkdownFrontmatterAlwaysRead()).toBe(false);
	});

	it("falls back to default true when the value is malformed (not a boolean)", () => {
		const home = makeTempHome();
		// The loader warns once on malformed values and stores `undefined`, so the
		// runtime getter should still surface the default `true` — a bad config
		// never silently narrows coverage.
		writeConfig(
			home,
			JSON.stringify({
				readGuard: { markdown: { frontmatterAlwaysRead: "yes" } },
			}),
		);
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		expect(getMarkdownFrontmatterAlwaysRead()).toBe(true);
	});

	it("memoizes — second call does not re-read the config file", () => {
		const home = makeTempHome();
		writeConfig(
			home,
			JSON.stringify({
				readGuard: { markdown: { frontmatterAlwaysRead: true } },
			}),
		);
		process.env.PI_LENS_CONFIG_PATH = getPiLensGlobalConfigPath(home);
		expect(getMarkdownFrontmatterAlwaysRead()).toBe(true);

		// Rewrite the config to flip the value; the cache should hold the
		// original until explicitly reset.
		writeConfig(
			home,
			JSON.stringify({
				readGuard: { markdown: { frontmatterAlwaysRead: false } },
			}),
		);
		expect(getMarkdownFrontmatterAlwaysRead()).toBe(true);

		_resetMarkdownFrontmatterAlwaysReadCacheForTests();
		expect(getMarkdownFrontmatterAlwaysRead()).toBe(false);
	});
});

describe("getRpcMaxDiagnosticsPerResponse", () => {
	it("returns the documented default (200) when the env var is unset", () => {
		// beforeEach deletes the env var.
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(200);
	});

	it("returns a finite, positive integer — never NaN — on the default path", () => {
		const value = getRpcMaxDiagnosticsPerResponse();
		expect(Number.isFinite(value)).toBe(true);
		expect(value).toBeGreaterThan(0);
	});

	it("reads the env var override when set to a positive integer", () => {
		process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE = "500";
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(500);
	});

	it("rejects a non-numeric env var and returns the default", () => {
		process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE = "not-a-number";
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(200);
	});

	it("rejects a zero/negative env var and returns the default", () => {
		process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE = "0";
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(200);
		process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE = "-100";
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(200);
	});

	it("memoizes — second call does not re-read the env var", () => {
		process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE = "750";
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(750);

		// Mutate after first read; cache should hold the original value until reset.
		process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE = "1000";
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(750);

		_resetRpcCacheForTests();
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(1000);
	});

	it("_resetRpcCacheForTests resets ONLY the RPC memo, not the runner timeout floor", () => {
		// Prime both memos through their env-var surface so they are NOT default.
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = "99000";
		process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE = "750";
		expect(getRunnerTimeoutFloorMs()).toBe(99000);
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(750);

		// Drop the RPC env var so the cleared memo re-reads an UNSET env and
		// falls back to the default — the only way to assert the memo was
		// cleared without the env value shadowing it.
		delete process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE;
		_resetRpcCacheForTests();
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(200);
		// The runner-timeout-floor memo must still hold its 99000 value —
		// _resetRpcCacheForTests only touches the RPC pair.
		expect(getRunnerTimeoutFloorMs()).toBe(99000);
	});
});

describe("getRpcResponseTtlMs", () => {
	it("returns the documented default (5000) when the env var is unset", () => {
		// beforeEach deletes the env var.
		expect(getRpcResponseTtlMs()).toBe(5000);
	});

	it("returns a finite, positive integer — never NaN — on the default path", () => {
		const value = getRpcResponseTtlMs();
		expect(Number.isFinite(value)).toBe(true);
		expect(value).toBeGreaterThan(0);
	});

	it("reads the env var override when set to a positive integer", () => {
		process.env.PI_LENS_RPC_RESPONSE_TTL_MS = "10000";
		expect(getRpcResponseTtlMs()).toBe(10000);
	});

	it("rejects a non-numeric env var and returns the default", () => {
		process.env.PI_LENS_RPC_RESPONSE_TTL_MS = "abc";
		expect(getRpcResponseTtlMs()).toBe(5000);
	});

	it("rejects a zero/negative env var and returns the default", () => {
		process.env.PI_LENS_RPC_RESPONSE_TTL_MS = "0";
		expect(getRpcResponseTtlMs()).toBe(5000);
		process.env.PI_LENS_RPC_RESPONSE_TTL_MS = "-500";
		expect(getRpcResponseTtlMs()).toBe(5000);
	});

	it("memoizes — second call does not re-read the env var", () => {
		process.env.PI_LENS_RPC_RESPONSE_TTL_MS = "12000";
		expect(getRpcResponseTtlMs()).toBe(12000);

		// Mutate after first read; cache should hold the original value until reset.
		process.env.PI_LENS_RPC_RESPONSE_TTL_MS = "15000";
		expect(getRpcResponseTtlMs()).toBe(12000);

		_resetRpcCacheForTests();
		expect(getRpcResponseTtlMs()).toBe(15000);
	});

	it("_resetRpcCacheForTests resets BOTH RPC memos independently", () => {
		process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE = "300";
		process.env.PI_LENS_RPC_RESPONSE_TTL_MS = "9000";
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(300);
		expect(getRpcResponseTtlMs()).toBe(9000);

		// Drop both env vars so the cleared memos re-read UNSET env and
		// fall back to the documented defaults.
		delete process.env.PI_LENS_RPC_MAX_DIAGNOSTICS_PER_RESPONSE;
		delete process.env.PI_LENS_RPC_RESPONSE_TTL_MS;
		_resetRpcCacheForTests();
		expect(getRpcMaxDiagnosticsPerResponse()).toBe(200);
		expect(getRpcResponseTtlMs()).toBe(5000);
	});
});
