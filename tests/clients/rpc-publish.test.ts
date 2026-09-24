/**
 * R009 / S07/T05 — behavioral contract for `clients/rpc-publish.ts`.
 *
 * The conformance test (`tests/config/rpc-publish-coverage.test.ts`,
 * S07/T04) pins the structural surface — the registered events, the
 * exported names, the typed envelope. THIS file pins the BEHAVIOR: a
 * well-formed `pilens:rpc:diagnostics` / `pilens:rpc:files-touched`
 * request produces a token-correlated response on `pilens:rpc:<token>:response`
 * carrying the verbatim `PilensDiagnosticsPayload` / `PilensRpcFilesTouchedPayload`
 * with the per-response cap applied and the TTL honored.
 *
 * House-style ratchet #2547: every test runs under `vi.useFakeTimers()` and
 * asserts through the real emitted-bytes seam (`responseEmit` mock that the
 * events mock routes the per-token response channel to). No real wall-clock
 * wait, no `Date.now()` compared as a numeric assertion.
 *
 * The TTL test exercises the structurally-unreachable-with-sync-handlers
 * branch (`Date.now() - ctx.receivedAt > ttlMs` with synchronous calls). The
 * module doc states this branch exists "for tests that force the boundary by
 * stamping the receipt timestamp artificially" — we honor that by sequencing
 * the two `Date.now()` reads via `vi.spyOn(Date, 'now').mockReturnValueOnce`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as busEventsLoggerModule from "../../clients/bus-events-logger.js";
import { _resetForTests as _resetBusPublishForTests } from "../../clients/bus-publish.js";
import type { PilensDiagnosticsFileEntry } from "../../clients/diagnostics-publish.js";
import {
	BUS_RPC_REQUEST_DIAGNOSTICS_EVENT,
	BUS_RPC_REQUEST_FILES_TOUCHED_EVENT,
	resetRpcPublishSessionState,
	wireRpcBusSubscriber,
	type BusEventsLike,
	type GetDiagnosticsState,
	type GetRecentTouches,
	type PilensRpcRecentTouchEntry,
} from "../../clients/rpc-publish.js";
import { _resetRpcCacheForTests } from "../../clients/runtime-config.js";

// --- Test environment ---

interface RpcTestEnv {
	events: BusEventsLike;
	responseEmit: ReturnType<typeof vi.fn>;
	getDiagnosticsState: GetDiagnosticsState;
	getRecentTouches: GetRecentTouches;
	dbg: (msg: string) => void;
}

interface SetupOpts {
	state?: PilensDiagnosticsFileEntry[];
	touches?: PilensRpcRecentTouchEntry[];
}

function setupRpcTestEnv(opts: SetupOpts = {}): RpcTestEnv {
	const responseEmit = vi.fn();
	let diagnosticsHandler: ((data: unknown) => void) | undefined;
	let filesTouchedHandler: ((data: unknown) => void) | undefined;

	const onFn = vi.fn((channel: string, handler: (data: unknown) => void) => {
		if (channel === BUS_RPC_REQUEST_DIAGNOSTICS_EVENT) {
			diagnosticsHandler = handler;
		} else if (channel === BUS_RPC_REQUEST_FILES_TOUCHED_EVENT) {
			filesTouchedHandler = handler;
		}
	});
	const offFn = vi.fn();

	const emitFn = vi.fn((channel: string, data: unknown) => {
		if (channel === BUS_RPC_REQUEST_DIAGNOSTICS_EVENT && diagnosticsHandler) {
			diagnosticsHandler(data);
		} else if (
			channel === BUS_RPC_REQUEST_FILES_TOUCHED_EVENT &&
			filesTouchedHandler
		) {
			filesTouchedHandler(data);
		} else if (
			channel.startsWith("pilens:rpc:") &&
			channel.endsWith(":response")
		) {
			responseEmit(channel, data);
		}
	});

	return {
		events: { on: onFn, off: offFn, emit: emitFn },
		responseEmit,
		getDiagnosticsState: vi.fn(() => opts.state ?? []),
		getRecentTouches: vi.fn(() => opts.touches ?? []),
		dbg: vi.fn(),
	};
}

// --- Lifecycle ---

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	resetRpcPublishSessionState();
	_resetRpcCacheForTests();
	_resetBusPublishForTests();
});

afterEach(() => {
	vi.useRealTimers();
	resetRpcPublishSessionState();
	_resetRpcCacheForTests();
	_resetBusPublishForTests();
});

// --- Tests ---

describe("rpc-publish behavioral contract (S07/T05)", () => {
	it("responds to pilens:rpc:diagnostics request with token-correlated channel", () => {
		const state: PilensDiagnosticsFileEntry[] = [
			{
				path: "/tmp/a.ts",
				diagnostics: [{ severity: "error", message: "boom", tool: "ts" }],
			},
		];
		const env = setupRpcTestEnv({ state });
		wireRpcBusSubscriber({
			events: env.events,
			getDiagnosticsState: env.getDiagnosticsState,
			getRecentTouches: env.getRecentTouches,
			dbg: env.dbg,
		});

		env.events.emit(BUS_RPC_REQUEST_DIAGNOSTICS_EVENT, {
			v: 1,
			source: "test",
			token: "abc",
		});

		expect(env.responseEmit).toHaveBeenCalledTimes(1);
		const [channel, payload] = env.responseEmit.mock.calls[0];
		expect(channel).toBe("pilens:rpc:abc:response");
		// Verbatim `PilensDiagnosticsPayload` carried inside the RPC wrapper,
		// unchanged shape from the push publisher (#502).
		expect(payload).toEqual({
			v: 1,
			source: "pi-lens",
			token: "abc",
			ttlMs: 5000,
			payload: {
				v: 1,
				source: "pi-lens",
				cwd: "",
				seq: 0,
				ts: 0, // fake clock anchor
				files: [
					{
						path: "/tmp/a.ts",
						diagnostics: [{ severity: "error", message: "boom", tool: "ts" }],
						// `truncated` is absent on a non-capped entry — `toEqual`
						// ignores `undefined` properties, so a literal here would
						// be redundant and brittle to future `truncated: false`
						// normalization.
					},
				],
			},
		});
	});

	it("responds to pilens:rpc:files-touched request", () => {
		const touches: PilensRpcRecentTouchEntry[] = [
			{ path: "/tmp/x.ts", ts: 1_700_000_000_000 },
			{ path: "/tmp/y.ts", ts: 1_700_000_001_000 },
		];
		const env = setupRpcTestEnv({ touches });
		wireRpcBusSubscriber({
			events: env.events,
			getDiagnosticsState: env.getDiagnosticsState,
			getRecentTouches: env.getRecentTouches,
			dbg: env.dbg,
		});

		env.events.emit(BUS_RPC_REQUEST_FILES_TOUCHED_EVENT, {
			v: 1,
			source: "test",
			token: "ft-1",
		});

		expect(env.responseEmit).toHaveBeenCalledTimes(1);
		const [channel, payload] = env.responseEmit.mock.calls[0];
		expect(channel).toBe("pilens:rpc:ft-1:response");
		expect(payload).toMatchObject({
			v: 1,
			source: "pi-lens",
			token: "ft-1",
			ttlMs: 5000,
			payload: {
				paths: ["/tmp/x.ts", "/tmp/y.ts"],
				ts: 1_700_000_001_000,
			},
		});
	});

	it("applies rpc.maxDiagnosticsPerResponse cap as global total", () => {
		// 25 files × 9 diagnostics + 1 fat file with 25 diagnostics = 250
		// diagnostics across 26 files. Cap = 200 forces a partial-fit on the
		// fat file and drops the trailing files entirely.
		const state: PilensDiagnosticsFileEntry[] = [];
		for (let i = 0; i < 25; i++) {
			state.push({
				path: `/tmp/f${i}.ts`,
				diagnostics: Array.from({ length: 9 }, () => ({
					severity: "warning" as const,
					tool: "test",
					message: "d",
					source: "test",
				})),
			});
		}
		state.push({
			path: "/tmp/fat.ts",
			diagnostics: Array.from({ length: 25 }, () => ({
				severity: "warning" as const,
				tool: "test",
				message: "fat",
				source: "test",
			})),
		});

		const env = setupRpcTestEnv({ state });
		wireRpcBusSubscriber({
			events: env.events,
			getDiagnosticsState: env.getDiagnosticsState,
			getRecentTouches: env.getRecentTouches,
			dbg: env.dbg,
		});

		env.events.emit(BUS_RPC_REQUEST_DIAGNOSTICS_EVENT, {
			v: 1,
			source: "test",
			token: "cap",
		});

		expect(env.responseEmit).toHaveBeenCalledTimes(1);
		const [, payload] = env.responseEmit.mock.calls[0];
		const files = payload.payload.files as PilensDiagnosticsFileEntry[];
		expect(files.length).toBeLessThan(state.length);
		const totalDiagnostics = files.reduce(
			(sum, f) => sum + f.diagnostics.length,
			0,
		);
		expect(totalDiagnostics).toBeLessThanOrEqual(200);
		// The last included file is the partial-fit on the fat entry.
		expect(files[files.length - 1].truncated).toBe(true);
	});

	it("respects rpc.responseTtlMs via fake timers", () => {
		const env = setupRpcTestEnv();
		wireRpcBusSubscriber({
			events: env.events,
			getDiagnosticsState: env.getDiagnosticsState,
			getRecentTouches: env.getRecentTouches,
			dbg: env.dbg,
		});

		// The synchronous handler reads `Date.now()` TWICE per request:
		//   1. inside the listener (sets `ctx.receivedAt`)
		//   2. inside the handler body (compares against `ctx.receivedAt`)
		// Both reads happen at the same wall-clock instant, so the elapsed
		// window is always 0 in production. The module doc explicitly
		// acknowledges this and states the TTL branch "exists for the
		// future async case and for tests that force the boundary by
		// stamping the receipt timestamp artificially". We force the
		// boundary by sequencing the two reads — first returns 0 (the
		// listener's `receivedAt`), second returns 5001 (the handler's
		// expiry check). 5001 - 0 > 5000 = expired.
		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValueOnce(0);
		nowSpy.mockReturnValueOnce(5001);

		env.events.emit(BUS_RPC_REQUEST_DIAGNOSTICS_EVENT, {
			v: 1,
			source: "test",
			token: "ttl",
		});

		expect(env.responseEmit).toHaveBeenCalledTimes(1);
		const [channel, payload] = env.responseEmit.mock.calls[0];
		expect(channel).toBe("pilens:rpc:ttl:response");
		expect(payload.expired).toBe(true);
		expect(payload.ttlMs).toBe(5000);
		expect(payload.payload).toEqual({
			v: 1,
			source: "pi-lens",
			cwd: "",
			seq: 0,
			ts: 0, // first Date.now() read = receivedAt
			files: [],
		});
	});

	it("ignores request with empty or non-string token", () => {
		// Spying on the namespace export — ESM named imports are LIVE
		// bindings, so mutating `busEventsLoggerModule.logBusEvent` is
		// visible to `rpc-publish.ts`'s static `import { logBusEvent }`.
		const logBusEventSpy = vi.spyOn(busEventsLoggerModule, "logBusEvent");
		const env = setupRpcTestEnv();
		wireRpcBusSubscriber({
			events: env.events,
			getDiagnosticsState: env.getDiagnosticsState,
			getRecentTouches: env.getRecentTouches,
			dbg: env.dbg,
		});

		env.events.emit(BUS_RPC_REQUEST_DIAGNOSTICS_EVENT, {
			v: 1,
			source: "test",
			token: "",
		});

		expect(env.responseEmit).not.toHaveBeenCalled();
		// A request that survives token validation would still need
		// diagnostics state to be present; verify the failure path is the
		// token validator, not the cap or the state reader.
		expect(env.getDiagnosticsState).not.toHaveBeenCalled();
		// The failure outcome is recorded on the bus-events log so the
		// session-end rollup can attribute invalid-token traffic per
		// request event name.
		expect(logBusEventSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				event: BUS_RPC_REQUEST_DIAGNOSTICS_EVENT,
				outcome: "rpc_request_invalid_no_token",
			}),
		);
		logBusEventSpy.mockRestore();
	});

	it("respects isBusPublishEnabled kill switch", () => {
		const original = process.env.PI_LENS_BUS_PUBLISH;
		process.env.PI_LENS_BUS_PUBLISH = "0";
		_resetBusPublishForTests();
		try {
			const env = setupRpcTestEnv();
			wireRpcBusSubscriber({
				events: env.events,
				getDiagnosticsState: env.getDiagnosticsState,
				getRecentTouches: env.getRecentTouches,
				dbg: env.dbg,
			});

			env.events.emit(BUS_RPC_REQUEST_DIAGNOSTICS_EVENT, {
				v: 1,
				source: "test",
				token: "kill",
			});

			// Kill switch is honored at emit time (NOT wire time) so the
			// listeners stay registered — a toggle mid-session still finds
			// them. Verify both contracts.
			expect(env.responseEmit).not.toHaveBeenCalled();
			expect(env.events.on).toHaveBeenCalledWith(
				BUS_RPC_REQUEST_DIAGNOSTICS_EVENT,
				expect.any(Function),
			);
		} finally {
			if (original === undefined) {
				delete process.env.PI_LENS_BUS_PUBLISH;
			} else {
				process.env.PI_LENS_BUS_PUBLISH = original;
			}
			_resetBusPublishForTests();
		}
	});

	it("does not crash when pi.events is absent", () => {
		const env = setupRpcTestEnv();
		expect(() =>
			wireRpcBusSubscriber({
				events: undefined,
				getDiagnosticsState: env.getDiagnosticsState,
				getRecentTouches: env.getRecentTouches,
				dbg: env.dbg,
			}),
		).not.toThrow();
		// The no-bus path is a structural no-op: the subscriber registers
		// nothing and emits nothing — the MCP mirror and the host's
		// print/RPC modes rely on this to stay quiet.
		expect(env.events.on).not.toHaveBeenCalled();
	});
});
