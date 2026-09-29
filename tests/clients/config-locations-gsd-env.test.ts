/**
 * GSD-pi-lens adaptation (slice S03/T03, requirement R024, refs #2457).
 *
 * The `gsd-pi` host sets `GSD_CODING_AGENT_DIR` in addition to the upstream
 * `PI_CODING_AGENT_DIR`. T01 centralised the precedence in
 * `resolveAgentDir()` (`clients/config-locations.ts:351`), and this suite
 * pins the resulting resolution contract.
 *
 * Coverage shape:
 *   - The first three `it` blocks exercise `resolveGlobalConfigLocation()`
 *     WITHOUT injection (no `homeDir`/`exists` seam), so production
 *     resolution reads the ambient env through `resolveAgentDir()`. They
 *     assert the END-TO-END effect of the new precedence on the resolved
 *     file path and `source` tier.
 *   - The fourth `it` block directly covers `resolveAgentDir()` itself, so a
 *     future regression in the helper is caught even when only its consumer
 *     changes. The helper is exported from `clients/config-locations.ts` but
 *     NOT re-exported by `clients/lens-config.ts`, so the test imports it
 *     from the original module.
 *
 * Hermeticity contract:
 *   - `OVERRIDDEN_ENV_KEYS` is the single source of truth for env cleanup;
 *     `beforeEach` deletes every key, `afterEach` restores from the saved
 *     snapshot. No env key survives a test.
 *   - The production memo (`resetGlobalConfigLocationCache()`) is reset
 *     both before and after every test, so a previous test's fingerprint
 *     cannot serve a stale resolution.
 *   - The temp-home prefix `pilens-gsdenv-` is distinct from the upstream
 *     template's `pi-lens-globalcfg-`, so this file's tmp dirs cannot
 *     crosstalk with the global-config-location suite (#3306 / #3314 family
 *     of ownership-aware tmp hygiene).
 *
 * Three env scenarios (verbatim from the slice plan):
 *   1. SOLO `GSD_CODING_AGENT_DIR` → `source: "pi-coding-agent-dir"`,
 *      path = `$GSD_CODING_AGENT_DIR/extensions/pi-lens.json`.
 *   2. SOLO `PI_CODING_AGENT_DIR` → same `source`, path under
 *      `$PI_CODING_AGENT_DIR/extensions/pi-lens.json`. Regression guard for
 *      backward compatibility with the upstream host.
 *   3. ENTRAMBE settate con file presente in entrambe le posizioni → il
 *      path risolto è quello di `GSD_CODING_AGENT_DIR` (precedenza).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../../clients/config-locations.js";
import {
	resetGlobalConfigLocationCache,
	resolveGlobalConfigLocation,
} from "../../clients/lens-config.js";
import { removeTempDirSync } from "./test-utils.js";

// Same sink-forwarding mock the other config suites use (#1333): config
// notices go to the ndjson sink, and the mock forwards to `console.error`
// so this suite can share the degradation-ledger / warn-once machinery
// without re-deriving it.
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => console.error(entry.message),
	};
});

const tmpDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

// `GSD_CODING_AGENT_DIR` is the FIRST entry — the slice plan explicitly
// requires it: T01 placed the new variable ahead of `PI_CODING_AGENT_DIR`
// in the fingerprint memo (`clients/config-locations.ts:493`) so a
// pre-swap cache cannot serve a stale resolution; this test reflects the
// same priority in cleanup order, where it makes intent visible.
const OVERRIDDEN_ENV_KEYS = [
	"GSD_CODING_AGENT_DIR",
	"PI_LENS_CONFIG_PATH",
	"PI_CODING_AGENT_DIR",
	"PI_LENS_HOME",
	"HOME",
	"USERPROFILE",
] as const;

type AgentDirEnvKey = "GSD_CODING_AGENT_DIR" | "PI_CODING_AGENT_DIR";

function makeTempHome(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-gsdenv-"));
	tmpDirs.push(dir);
	return dir;
}

/**
 * Point the process's real homedir at the fixture home. The PRODUCTION
 * resolution (no `homeDir` injection) probes `$HOME/.pi-lens/config.json`
 * for the grandfathering tier, so the tests that exercise it must not depend
 * on the maintainer's real home (the #525 hermeticity class). Both spellings
 * are set because `os.homedir()` reads `$HOME` on POSIX and `USERPROFILE`
 * on Windows.
 */
function adoptHomeEnv(home: string): void {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
}

/**
 * Write a config file under `<dir>/extensions/pi-lens.json`. The agent-dir
 * tier is "present" only when this file exists on disk; an absent file is
 * never chosen for reading (`clients/config-locations.ts` resolution order,
 * tier 3).
 */
function writeAgentDirConfig(dir: string): string {
	fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
	const configPath = path.join(dir, "extensions", "pi-lens.json");
	fs.writeFileSync(configPath, "{}");
	return configPath;
}

/**
 * Set exactly one of the two agent-dir env vars. The other is left alone —
 * `clearAgentDirEnvs()` is the explicit exclusivity call.
 */
function setAgentDirEnv(key: AgentDirEnvKey, dir: string): void {
	process.env[key] = dir;
}

/**
 * Clear BOTH agent-dir env vars. Used as a defensive setup step before
 * `setAgentDirEnv(...)` so the asserted-only-one-set state is true by
 * construction, not by accident.
 */
function clearAgentDirEnvs(): void {
	delete process.env.GSD_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
}

beforeEach(() => {
	for (const key of OVERRIDDEN_ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
	resetGlobalConfigLocationCache();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetGlobalConfigLocationCache();
	for (const key of OVERRIDDEN_ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of tmpDirs.splice(0)) removeTempDirSync(dir);
});

describe("config-locations — GSD_CODING_AGENT_DIR support (R024)", () => {
	it("GSD_CODING_AGENT_DIR alone resolves the agent-dir tier", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const agentDir = path.join(home, "agent-gsd");
		writeAgentDirConfig(agentDir);
		clearAgentDirEnvs();
		setAgentDirEnv("GSD_CODING_AGENT_DIR", agentDir);
		resetGlobalConfigLocationCache();

		const resolution = resolveGlobalConfigLocation();
		expect(resolution.source).toBe("pi-coding-agent-dir");
		expect(resolution.path).toBe(
			path.join(agentDir, "extensions", "pi-lens.json"),
		);
	});

	it("PI_CODING_AGENT_DIR alone still resolves (backward compat)", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const agentDir = path.join(home, "agent-pi");
		writeAgentDirConfig(agentDir);
		clearAgentDirEnvs();
		setAgentDirEnv("PI_CODING_AGENT_DIR", agentDir);
		resetGlobalConfigLocationCache();

		const resolution = resolveGlobalConfigLocation();
		expect(resolution.source).toBe("pi-coding-agent-dir");
		expect(resolution.path).toBe(
			path.join(agentDir, "extensions", "pi-lens.json"),
		);
	});

	it("GSD_CODING_AGENT_DIR wins when both are set", () => {
		const home = makeTempHome();
		adoptHomeEnv(home);
		const gsdAgentDir = path.join(home, "agent-gsd");
		const piAgentDir = path.join(home, "agent-pi");
		writeAgentDirConfig(gsdAgentDir);
		writeAgentDirConfig(piAgentDir);
		clearAgentDirEnvs();
		setAgentDirEnv("GSD_CODING_AGENT_DIR", gsdAgentDir);
		setAgentDirEnv("PI_CODING_AGENT_DIR", piAgentDir);
		resetGlobalConfigLocationCache();

		const resolution = resolveGlobalConfigLocation();
		expect(resolution.source).toBe("pi-coding-agent-dir");
		expect(resolution.path).toBe(
			path.join(gsdAgentDir, "extensions", "pi-lens.json"),
		);
	});

	it("resolveAgentDir is exported and respects GSD-before-PI precedence", () => {
		// Direct unit coverage of `resolveAgentDir()`
		// (`clients/config-locations.ts:351`). The first three tests assert
		// the END-TO-END effect on `resolveGlobalConfigLocation()`; this one
		// asserts the helper itself so a future regression in the precedence
		// is caught even if only its consumer changes. The helper is NOT
		// re-exported by `clients/lens-config.ts`, so we import it from the
		// original module.
		const home = makeTempHome();
		const gsdDir = path.join(home, "gsd-dir");
		const piDir = path.join(home, "pi-dir");

		// (a) Only GSD set → returns GSD value.
		clearAgentDirEnvs();
		setAgentDirEnv("GSD_CODING_AGENT_DIR", gsdDir);
		expect(resolveAgentDir()).toBe(gsdDir);

		// (b) Only PI set → returns PI value (backward compat at the helper).
		clearAgentDirEnvs();
		setAgentDirEnv("PI_CODING_AGENT_DIR", piDir);
		expect(resolveAgentDir()).toBe(piDir);

		// (c) Both set → GSD wins (precedence rule).
		clearAgentDirEnvs();
		setAgentDirEnv("GSD_CODING_AGENT_DIR", gsdDir);
		setAgentDirEnv("PI_CODING_AGENT_DIR", piDir);
		expect(resolveAgentDir()).toBe(gsdDir);
	});
});
