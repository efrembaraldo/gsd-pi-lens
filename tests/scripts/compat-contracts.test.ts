/**
 * Tests for scripts/lib/compat-contracts.mjs — the pinned third-party
 * contract matchers backing the nightly compat-smoke (#476, Layer A).
 *
 * Each matcher is exercised against a MINIMAL synthetic snippet that carries
 * just the semantic shape it looks for (never real vendor source — that's
 * what scripts/compat-contracts.mjs verifies live against either a real npm
 * install, for the third-party extensions, or the gsd-pi checkout, for the
 * @gsd SDK packages), plus a mutated/absent variant to confirm the matcher
 * actually fails closed.
 *
 * The four SDK contracts (2a-2d) now pin the @gsd re-scoped SDK. They read
 * from a gsd-pi checkout (the SDK is a monorepo workspace, absent from the
 * npm registry), so the fixtures mirror the real dist sources:
 *   - 2a  loader.js  (@gsd/pi-coding-agent)         `_moduleImporters` cache
 *   - 2b  agent-session-extensions.js (@gsd/agent-core) bindExtensions emit
 *   - 2c  agent-session-events.js (@gsd/agent-core)  invalidate call site
 *   - 2d  runner.js  (@gsd/pi-coding-agent)          stale-ctx message
 */

import { describe, expect, it } from "vitest";
import {
	checkAvtcChildEnv,
	checkNicobailonChildEnv,
	checkSdkBindExtensionsEmitsSessionStart,
	checkSdkExtensionCache,
	checkSdkInvalidateCalled,
	checkSdkStaleCtxMessage,
	checkTintinwebInProcessBind,
	runAllContractChecks,
} from "../../scripts/lib/compat-contracts.mjs";

describe("checkNicobailonChildEnv", () => {
	const GOOD = `
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
env[SUBAGENT_CHILD_ENV] = "1";
`;

	it("passes when the child flag is set and both identity consts exist", () => {
		const result = checkNicobailonChildEnv(GOOD);
		expect(result.pass).toBe(true);
	});

	it("fails when the child-flag assignment is missing", () => {
		const noAssignment = GOOD.replace('env[SUBAGENT_CHILD_ENV] = "1";', "");
		const result = checkNicobailonChildEnv(noAssignment);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("PI_SUBAGENT_CHILD");
	});

	it("fails when the run-id const is missing", () => {
		const noRunId = GOOD.replace(
			'export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";',
			"",
		);
		const result = checkNicobailonChildEnv(noRunId);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("PI_SUBAGENT_RUN_ID");
	});

	it("fails on an unrelated source", () => {
		const result = checkNicobailonChildEnv("export const X = 1;");
		expect(result.pass).toBe(false);
	});
});

describe("checkAvtcChildEnv", () => {
	const GOOD = `
if (agent.name) subagentEnv.PI_SUBAGENT_CHILD_AGENT = agent.name;
subagentEnv.PI_SUBAGENT_PARENT_PID = String(process.pid);
`;

	it("passes when both the child-agent and parent-pid assignments exist", () => {
		const result = checkAvtcChildEnv(GOOD);
		expect(result.pass).toBe(true);
	});

	it("fails when the child-agent assignment is missing", () => {
		const noChildAgent = GOOD.replace(
			"if (agent.name) subagentEnv.PI_SUBAGENT_CHILD_AGENT = agent.name;",
			"",
		);
		const result = checkAvtcChildEnv(noChildAgent);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("PI_SUBAGENT_CHILD_AGENT");
	});

	it("fails when the parent-pid assignment is missing", () => {
		const noParentPid = GOOD.replace(
			"subagentEnv.PI_SUBAGENT_PARENT_PID = String(process.pid);",
			"",
		);
		const result = checkAvtcChildEnv(noParentPid);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("PI_SUBAGENT_PARENT_PID");
	});

	it("fails when the parent-pid assignment doesn't use String(process.pid)", () => {
		const wrongShape = GOOD.replace(
			"subagentEnv.PI_SUBAGENT_PARENT_PID = String(process.pid);",
			"subagentEnv.PI_SUBAGENT_PARENT_PID = process.pid;",
		);
		const result = checkAvtcChildEnv(wrongShape);
		expect(result.pass).toBe(false);
	});

	it("fails on an unrelated source", () => {
		const result = checkAvtcChildEnv("export const X = 1;");
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("PI_SUBAGENT_CHILD_AGENT");
		expect(result.detail).toContain("PI_SUBAGENT_PARENT_PID");
	});
});

describe("checkSdkExtensionCache", () => {
	// 2a — @gsd/pi-coding-agent dist/core/extensions/loader.js: the
	// module-scope `_moduleImporters` Map cache consulted via get/set. This
	// (formely `extensionCache`) is what makes an in-process bindExtensions()
	// reuse pi-lens's own module-scope singletons instead of a fresh isolated
	// instance.
	const GOOD = `
const _moduleImporters = new Map();
function getModuleImporter(parentModuleUrl) {
    let importer = _moduleImporters.get(parentModuleUrl);
    if (!importer) {
        importer = createJiti(parentModuleUrl, { moduleCache: true });
        _moduleImporters.set(parentModuleUrl, importer);
    }
    return importer;
}
`;

	it("passes when the module-scope Map cache exists AND is consulted via get/set", () => {
		const result = checkSdkExtensionCache(GOOD);
		expect(result.pass).toBe(true);
	});

	it("fails when the cache is a plain object, not a Map", () => {
		const result = checkSdkExtensionCache(
			"const _moduleImporters = {};\n_moduleImporters.get(k);\n_moduleImporters.set(k, v);",
		);
		expect(result.pass).toBe(false);
	});

	it("fails when the Map is declared but never consulted via get", () => {
		const noGet = GOOD.replace("_moduleImporters.get(parentModuleUrl);", "");
		const result = checkSdkExtensionCache(noGet);
		expect(result.pass).toBe(false);
	});

	it("fails when the Map is declared but never consulted via set", () => {
		const noSet = GOOD.replace(
			"_moduleImporters.set(parentModuleUrl, importer);",
			"",
		);
		const result = checkSdkExtensionCache(noSet);
		expect(result.pass).toBe(false);
	});

	it("fails when there is no cache Map at all", () => {
		const result = checkSdkExtensionCache("const somethingElse = new Map();");
		expect(result.pass).toBe(false);
	});
});

describe("checkSdkBindExtensionsEmitsSessionStart", () => {
	// 2b — @gsd/agent-core dist/session/agent-session-extensions.js: the
	// real bindExtensions() body emits `this.host._sessionStartEvent`.
	const GOOD = `
    async bindExtensions(bindings) {
        this.applyExtensionBindings(this.host._extensionRunner);
        await this.host._extensionRunner.emit(this.host._sessionStartEvent);
    }
`;

	it("passes when bindExtensions() unconditionally emits this.host._sessionStartEvent", () => {
		const result = checkSdkBindExtensionsEmitsSessionStart(GOOD);
		expect(result.pass).toBe(true);
	});

	it("passes with extra statements between the emit and the closing brace", () => {
		const withTail = `
    async bindExtensions(bindings) {
        this.applyExtensionBindings(this.host._extensionRunner);
        await this.host._extensionRunner.emit(this.host._sessionStartEvent);
        await this.extendResourcesFromExtensions("startup");
    }
`;
		const result = checkSdkBindExtensionsEmitsSessionStart(withTail);
		expect(result.pass).toBe(true);
	});

	it("fails when bindExtensions exists but emits a different event", () => {
		const otherEmit = GOOD.replace(
			"this.host._extensionRunner.emit(this.host._sessionStartEvent)",
			"this.host._extensionRunner.emit({ type: \"other_event\" })",
		);
		const result = checkSdkBindExtensionsEmitsSessionStart(otherEmit);
		expect(result.pass).toBe(false);
	});

	it("fails when bindExtensions exists but never emits", () => {
		const source = `
    async bindExtensions(bindings) {
        this.applyExtensionBindings(this.host._extensionRunner);
    }
`;
		const result = checkSdkBindExtensionsEmitsSessionStart(source);
		expect(result.pass).toBe(false);
	});

	it("fails when bindExtensions method is absent entirely", () => {
		const result = checkSdkBindExtensionsEmitsSessionStart("class Foo {}");
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("not found");
	});

	it("fails when the emit uses the legacy this._ (non-host) receiver", () => {
		const legacyReceiver = GOOD.replaceAll("this.host.", "this.");
		const result = checkSdkBindExtensionsEmitsSessionStart(legacyReceiver);
		expect(result.pass).toBe(false);
	});
});

describe("checkSdkInvalidateCalled", () => {
	// 2c — @gsd/agent-core dist/session/agent-session-events.js: the dispose
	// route calls this.host._extensionRunner.invalidate(...), which is what
	// probeCtxActive() in session-lifecycle.ts depends on.
	it("passes when invalidate() is called on the host extension runner", () => {
		const result = checkSdkInvalidateCalled(
			'this.host._extensionRunner.invalidate("This extension ctx is stale after session replacement");',
		);
		expect(result.pass).toBe(true);
	});

	it("fails when invalidate uses the legacy this._ (non-host) receiver", () => {
		const result = checkSdkInvalidateCalled(
			'this._extensionRunner.invalidate("stale after session replacement");',
		);
		expect(result.pass).toBe(false);
	});

	it("fails when invalidate is never called", () => {
		const result = checkSdkInvalidateCalled(
			"this.host._extensionRunner.emit(event);",
		);
		expect(result.pass).toBe(false);
	});
});

describe("checkSdkStaleCtxMessage", () => {
	// 2d — @gsd/pi-coding-agent dist/core/extensions/runner.js: the default
	// param of invalidate() (canonical source) carries the exact fragment
	// probeCtxActive() matches on.
	it("passes when the exact fragment is present", () => {
		const result = checkSdkStaleCtxMessage(
			'invalidate(message = "This extension ctx is stale after session replacement or reload.") {',
		);
		expect(result.pass).toBe(true);
	});

	it("fails when the wording has drifted", () => {
		const result = checkSdkStaleCtxMessage(
			'invalidate("This context is no longer valid.");',
		);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("session-lifecycle.ts");
	});
});

describe("checkTintinwebInProcessBind", () => {
	it("passes when both the resource loader and bindExtensions call exist", () => {
		const source = `
const loader = new DefaultResourceLoader({ cwd });
await session.bindExtensions({ onError });
`;
		const result = checkTintinwebInProcessBind(source);
		expect(result.pass).toBe(true);
	});

	it("fails when DefaultResourceLoader is not constructed", () => {
		const result = checkTintinwebInProcessBind(
			"await session.bindExtensions({});",
		);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("DefaultResourceLoader");
	});

	it("fails when bindExtensions is never called", () => {
		const result = checkTintinwebInProcessBind(
			"const loader = new DefaultResourceLoader({ cwd });",
		);
		expect(result.pass).toBe(false);
		expect(result.detail).toContain("bindExtensions");
	});
});

// Shared SDK fixtures used by the runAllContractChecks aggregate tests.
const SDK_LOADER_GOOD = `
const _moduleImporters = new Map();
function getModuleImporter(parentModuleUrl) {
    let importer = _moduleImporters.get(parentModuleUrl);
    if (!importer) {
        importer = createJiti(parentModuleUrl, { moduleCache: true });
        _moduleImporters.set(parentModuleUrl, importer);
    }
    return importer;
}
`;

const SDK_RUNNER_GOOD = `invalidate(message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().") { ... }`;

const SDK_EXTENSIONS_GOOD = `
    async bindExtensions(bindings) {
        this.applyExtensionBindings(this.host._extensionRunner);
        await this.host._extensionRunner.emit(this.host._sessionStartEvent);
    }
`;

const SDK_EVENTS_GOOD = `
class AgentSessionEvents {
    dispose() {
        this.host._extensionRunner.invalidate("This extension ctx is stale after session replacement");
    }
}
`;

describe("runAllContractChecks", () => {
	it("aggregates all seven checks and reports allPass=false on any single failure", () => {
		const inputs = {
			nicobailonPiArgsSource: "export const X = 1;", // fails
			avtcProcessRunnerSource: `
if (agent.name) subagentEnv.PI_SUBAGENT_CHILD_AGENT = agent.name;
subagentEnv.PI_SUBAGENT_PARENT_PID = String(process.pid);
`,
			sdkLoaderSource: SDK_LOADER_GOOD,
			sdkRunnerSource: SDK_RUNNER_GOOD,
			sdkAgentSessionExtensionsSource: SDK_EXTENSIONS_GOOD,
			sdkAgentSessionEventsSource: SDK_EVENTS_GOOD,
			tintinwebAgentRunnerSource: `
const loader = new DefaultResourceLoader({ cwd });
await session.bindExtensions({});
`,
		};
		const { results, allPass } = runAllContractChecks(inputs);
		expect(results).toHaveLength(7);
		expect(allPass).toBe(false);
		const failed = results.filter((r) => !r.pass);
		expect(failed.map((r) => r.id)).toEqual(["nicobailon.child-env"]);
	});

	it("reports allPass=true when every check passes", () => {
		const inputs = {
			nicobailonPiArgsSource: `
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
env[SUBAGENT_CHILD_ENV] = "1";
`,
			avtcProcessRunnerSource: `
if (agent.name) subagentEnv.PI_SUBAGENT_CHILD_AGENT = agent.name;
subagentEnv.PI_SUBAGENT_PARENT_PID = String(process.pid);
`,
			sdkLoaderSource: SDK_LOADER_GOOD,
			sdkRunnerSource: SDK_RUNNER_GOOD,
			sdkAgentSessionExtensionsSource: SDK_EXTENSIONS_GOOD,
			sdkAgentSessionEventsSource: SDK_EVENTS_GOOD,
			tintinwebAgentRunnerSource: `
const loader = new DefaultResourceLoader({ cwd });
await session.bindExtensions({});
`,
		};
		const { allPass } = runAllContractChecks(inputs);
		expect(allPass).toBe(true);
	});

	it("exposes the re-scoped @gsd package names on the SDK result rows", () => {
		const { results } = runAllContractChecks({
			nicobailonPiArgsSource: "export const X = 1;",
			avtcProcessRunnerSource: "no",
			sdkLoaderSource: SDK_LOADER_GOOD,
			sdkRunnerSource: SDK_RUNNER_GOOD,
			sdkAgentSessionExtensionsSource: SDK_EXTENSIONS_GOOD,
			sdkAgentSessionEventsSource: SDK_EVENTS_GOOD,
			tintinwebAgentRunnerSource: "no",
		});
		const sdkRows = results.filter((r) => r.id.startsWith("sdk."));
		const byPackage = Object.fromEntries(
			sdkRows.map((r) => [r.id, r.package]),
		);
		expect(byPackage["sdk.extension-cache"]).toBe("@gsd/pi-coding-agent");
		expect(byPackage["sdk.bind-extensions-session-start"]).toBe(
			"@gsd/agent-core",
		);
		expect(byPackage["sdk.invalidate-called"]).toBe("@gsd/agent-core");
		expect(byPackage["sdk.stale-ctx-message"]).toBe("@gsd/pi-coding-agent");
	});
});