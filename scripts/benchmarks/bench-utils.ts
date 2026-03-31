import { AgentOs } from "@rivet-dev/agent-os-core";
import { coreutils } from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";
import { LLMock } from "@copilotkit/llmock";
import os from "node:os";

// Benchmark parameters. Keep batch sizes minimal for fast iteration.
export const BATCH_SIZES = [1, 10];
export const ITERATIONS = 5;
export const WARMUP_ITERATIONS = 1;
export const MAX_CONCURRENCY = Math.max(1, os.availableParallelism() - 4);

export const ECHO_COMMAND = "echo hello";
export const EXPECTED_OUTPUT = "hello\n";

// ── Shared mock LLM server ─────────────────────────────────────────

let _llmock: LLMock | undefined;
let _llmockUrl: string | undefined;
let _llmockPort: number | undefined;

/** Start a shared llmock server (idempotent). */
export async function ensureLlmock(): Promise<{
	url: string;
	port: number;
}> {
	if (_llmock) return { url: _llmockUrl!, port: _llmockPort! };
	_llmock = new LLMock({ port: 0, logLevel: "silent" });
	_llmock.addFixtures([
		{ match: { predicate: () => true }, response: { content: "ok" } },
	]);
	_llmockUrl = await _llmock.start();
	_llmockPort = Number(new URL(_llmockUrl).port);
	return { url: _llmockUrl, port: _llmockPort };
}

/** Stop the shared llmock server. */
export async function stopLlmock(): Promise<void> {
	if (_llmock) {
		await _llmock.stop();
		_llmock = undefined;
		_llmockUrl = undefined;
		_llmockPort = undefined;
	}
}

// ── Workload abstraction ────────────────────────────────────────────

/** A workload describes how to create a VM and start a long-running process for memory measurement. */
export interface Workload {
	name: string;
	description: string;
	createVm: () => Promise<AgentOs>;
	/** Start a long-running process so the Worker thread stays alive. */
	start: (vm: AgentOs) => Promise<void> | void;
	/** Verify the expected processes are running. Throws if not. */
	verify: (vm: AgentOs) => void;
	/** Time to wait after start for the process to fully initialize. */
	settleMs: number;
}

export const WORKLOADS: Record<string, Workload> = {
	sleep: {
		name: "sleep",
		description: "Minimal VM with idle Node.js process (setTimeout keepalive)",
		createVm: () => AgentOs.create(),
		start: (vm) => {
			vm.spawn("node", ["-e", "setTimeout(() => {}, 999999999)"], {
				streamStdin: true,
			});
		},
		verify: (vm) => {
			const procs = vm.listProcesses();
			const running = procs.filter((p) => p.running);
			const hasNode = running.some((p) => p.command === "node");
			if (!hasNode) {
				throw new Error(
					`Expected running 'node' process, got: ${JSON.stringify(running.map((p) => p.command))}`,
				);
			}
		},
		settleMs: 2000,
	},
	"pi-session": {
		name: "pi-session",
		description: "VM with PI agent session via createSession",
		createVm: async () => {
			const { port } = await ensureLlmock();
			return AgentOs.create({
				software: [pi],
				loopbackExemptPorts: [port],
			});
		},
		start: async (vm) => {
			const { url } = await ensureLlmock();
			await vm.createSession("pi", {
				env: {
					ANTHROPIC_API_KEY: "bench-key",
					ANTHROPIC_BASE_URL: url,
				},
			});
		},
		verify: (vm) => {
			const procs = vm.listProcesses();
			const running = procs.filter((p) => p.running);
			const hasPi = running.some(
				(p) =>
					p.command === "node" &&
					p.args.some((a) => a.includes("agent-os-pi")),
			);
			if (!hasPi) {
				throw new Error(
					`Expected running agent-os-pi process, got: ${JSON.stringify(running.map((p) => ({ cmd: p.command, args: p.args })))}`,
				);
			}
			const kernelProcs = vm.allProcesses();
			const v8Proc = kernelProcs.find(
				(p) =>
					p.driver === "node" &&
					p.status === "running" &&
					p.args.some((a) => a.includes("agent-os-pi")),
			);
			if (!v8Proc) {
				throw new Error(
					`Expected V8 isolate running agent-os-pi, got: ${JSON.stringify(kernelProcs.map((p) => ({ driver: p.driver, cmd: p.command, status: p.status })))}`,
				);
			}
		},
		settleMs: 2000,
	},
};

// ── VM creation helpers ─────────────────────────────────────────────

/**
 * Create a fresh AgentOS VM with only coreutils (WASM shell + echo).
 * This is the minimal setup needed to run shell commands.
 */
export async function createBenchVm(): Promise<AgentOs> {
	return AgentOs.create({
		software: [coreutils],
	});
}

/**
 * Create a fresh AgentOS VM with PI software and a ready session.
 * Measures cold start from AgentOs.create() through createSession() completing
 * (ACP handshake done, agent ready to accept prompts).
 */
export async function createPiSessionVm(): Promise<{
	vm: AgentOs;
	coldStartMs: number;
}> {
	const { url, port } = await ensureLlmock();
	const t0 = performance.now();
	const vm = await AgentOs.create({
		software: [pi],
		loopbackExemptPorts: [port],
	});
	await vm.createSession("pi", {
		env: {
			ANTHROPIC_API_KEY: "bench-key",
			ANTHROPIC_BASE_URL: url,
		},
	});
	const coldStartMs = performance.now() - t0;
	return { vm, coldStartMs };
}

// ── Stats and formatting ────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

export function stats(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	return {
		mean: round(mean),
		p50: round(percentile(sorted, 50)),
		p95: round(percentile(sorted, 95)),
		p99: round(percentile(sorted, 99)),
		min: round(sorted[0]),
		max: round(sorted[sorted.length - 1]),
	};
}

export function round(n: number, decimals = 2): number {
	const f = 10 ** decimals;
	return Math.round(n * f) / f;
}

export function getHardware() {
	const cpus = os.cpus();
	return {
		cpu: cpus[0]?.model ?? "unknown",
		cores: os.availableParallelism(),
		ram: `${round(os.totalmem() / 1024 ** 3, 1)} GB`,
		node: process.version,
		os: `${os.type()} ${os.release()}`,
		arch: os.arch(),
	};
}

export function forceGC() {
	if (global.gc) {
		global.gc();
	} else {
		console.error("WARNING: global.gc not available. Run with --expose-gc");
	}
}

export async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export function formatBytes(bytes: number): string {
	if (Math.abs(bytes) < 1024) return `${bytes} B`;
	const mb = bytes / (1024 * 1024);
	return `${round(mb, 2)} MB`;
}

/** Print a table to stderr for human readability. */
export function printTable(
	headers: string[],
	rows: (string | number)[][],
): void {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
	);
	const sep = widths.map((w) => "-".repeat(w)).join(" | ");
	const fmt = (row: (string | number)[]) =>
		row.map((c, i) => String(c).padStart(widths[i])).join(" | ");

	console.error("");
	console.error(fmt(headers));
	console.error(sep);
	for (const row of rows) {
		console.error(fmt(row));
	}
	console.error("");
}
