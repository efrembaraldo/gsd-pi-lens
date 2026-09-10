import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPiLensGlobalConfigPath } from "../../clients/lens-config.js";
import {
	_resetMarkdownFrontmatterAlwaysReadCacheForTests,
	_resetRunnerTimeoutFloorCacheForTests,
	getMarkdownFrontmatterAlwaysRead,
	getRunnerTimeoutFloorMs,
} from "../../clients/runtime-config.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];
let previousConfigPath: string | undefined;
let previousFloor: string | undefined;

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
	delete process.env.PI_LENS_CONFIG_PATH;
	delete process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS;
	_resetRunnerTimeoutFloorCacheForTests();
	_resetMarkdownFrontmatterAlwaysReadCacheForTests();
});

afterEach(() => {
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	if (previousFloor === undefined)
		delete process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS;
	else process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS = previousFloor;
	_resetRunnerTimeoutFloorCacheForTests();
	_resetMarkdownFrontmatterAlwaysReadCacheForTests();
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
		writeConfig(
			home,
			JSON.stringify({ readGuard: { markdown: {} } }),
		);
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
