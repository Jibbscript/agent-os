# Benchmarks

## Results

### Cold Start Latency

Sequential — VMs created one at a time:

| Batch Size | Samples | Mean     | p50      | p95      | p99      |
| ---------- | ------- | -------- | -------- | -------- | -------- |
| 1          | 5       | 39.3 ms  | 36.3 ms  | 52.7 ms  | —        |
| 10         | 50      | 35.7 ms  | 34.1 ms  | 43.6 ms  | —        |

Concurrent — up to `os.availableParallelism() - 4` VMs created in parallel (16 on this machine):

| Batch Size | Samples | Mean     | p50      | p95       | p99      |
| ---------- | ------- | -------- | -------- | --------- | -------- |
| 1          | 5       | 35.8 ms  | 35.9 ms  | 37.8 ms   | —        |
| 10         | 50      | 97.0 ms  | 96.9 ms  | 117.1 ms  | —        |

p99 is omitted (—) where sample count is below 100, as the percentile is not statistically meaningful at that size.

**Key takeaway:** Sequential cold start is stable at **~35 ms p50** regardless of batch size.
This includes creating the full kernel with all three runtime mounts (WASM, Node.js, Python).
Concurrent cold start scales to ~97 ms at batch=10 due to CPU contention from parallel
kernel initialization. Compared to traditional sandbox providers (e2b p95 TTI of 950 ms),
WASM cold start is **~22x faster**.

### Warm Start Latency

Sequential:

| Batch Size | Samples | Mean     | p50      | p95      | p99      |
| ---------- | ------- | -------- | -------- | -------- | -------- |
| 1          | 5       | 23.5 ms  | 23.3 ms  | 24.6 ms  | —        |
| 10         | 50      | 24.0 ms  | 23.5 ms  | 27.7 ms  | —        |

Concurrent:

| Batch Size | Samples | Mean     | p50      | p95      | p99      |
| ---------- | ------- | -------- | -------- | -------- | -------- |
| 1          | 5       | 23.7 ms  | 23.1 ms  | 25.9 ms  | —        |
| 10         | 50      | 37.8 ms  | 36.3 ms  | 50.4 ms  | —        |

p99 is omitted (—) where sample count is below 100.

**Key takeaway:** Warm start is **~23 ms sequential** — roughly 1.5x faster than cold start.
The difference (~12 ms) is the one-time cost of VM creation (kernel setup, runtime mounting,
filesystem initialization). Per-command overhead is dominated by WASM Worker thread dispatch
and shell execution.

### Memory Overhead

Measured using the staircase approach: a throwaway VM is created and destroyed first to warm
all caches (module compilation, JIT, etc.), then VMs are added one at a time with the
incremental RSS and heap delta recorded after each step. RSS is measured across the entire
process tree (host + child processes) via `/proc` to capture the V8 runtime child process.

#### Sleep workload (WASM process)

Each VM spawns `sleep 99999` so the WASM Worker thread stays alive during measurement.
WASM processes run as Worker threads inside the host process, so all memory is captured by
host RSS alone.

| Step | RSS delta | Heap delta |
| ---- | --------- | ---------- |
| 0    | 7.0 MB    | 0.21 MB    |
| 1    | 6.1 MB    | 0.16 MB    |
| 2    | 7.2 MB    | 0.15 MB    |

**Average: ~7 MB RSS / ~0.17 MB heap per VM.**

#### PI session workload (Node.js V8 isolate)

Each VM creates a full PI agent session via `createSession("pi")` backed by a mock LLM
server. This spawns the pi-acp adapter and PI agent inside the VM's Node.js runtime. The
Node.js runtime runs as a separate child process (a Rust binary hosting V8 isolates), shared
across all VMs in the same host process. Each session creates its own V8 isolate(s) within
that child process, loading the full PI dependency tree (Anthropic SDK, undici, streaming
parsers, pi-acp adapter) into a separate heap.

The benchmark verifies that both the pi-acp process and the V8 isolate child process are
running before each memory snapshot.

| Step | RSS delta | Heap delta |
| ---- | --------- | ---------- |
| 0    | 185 MB    | 3.2 MB     |
| 1    | 146 MB    | 3.5 MB     |
| 2    | 147 MB    | 1.8 MB     |

Step 0 includes ~40 MB of one-time V8 runtime process startup. Steps 1-2 reflect the true
incremental per-session cost.

**Incremental per session: ~146 MB RSS / ~3 MB host heap.**

The bulk of the cost (~140 MB) is in the V8 child process, where each session loads the PI
agent's full JS dependency tree into its own V8 isolate heap. Only ~3-8 MB is on the host
side (kernel wrappers, WASM Worker threads, IPC state).

#### Comparison

| | Sleep (WASM) | PI Session (V8) |
|---|---|---|
| Incremental RSS per VM | ~7 MB | ~146 MB |
| Host heap per VM | ~0.17 MB | ~3 MB |
| Minimum sandbox provider | 256 MB | 256 MB |

**Key takeaway:** A minimal WASM-only VM costs ~7 MB. A full PI agent session costs ~146 MB,
dominated by the V8 isolate heap in the shared Rust child process. The V8 runtime process
itself is shared (one per host process), so the ~40 MB base cost is amortized across all
sessions. Both workloads are more memory-efficient than traditional sandbox providers
(256 MB minimum allocation).

## Methodology

### Cold Start

Time from `AgentOs.create()` through the first `vm.exec("echo hello")` completing. This
captures the full VM boot sequence:

1. In-memory filesystem and kernel creation
2. WASM runtime mounting (loading the coreutils WASM command directory)
3. Node.js runtime mounting (V8 isolate sandboxed runtime)
4. Python runtime mounting (Pyodide WASM runtime)
5. First WASM process spawn (the `sh` shell as a Worker thread)
6. Shell parsing and executing the `echo` command
7. Stdout pipe collection and return to host

All three runtimes (WASM, Node.js, Python) are mounted during cold start, matching the
production `AgentOs.create()` configuration. A trivial command (`echo hello`) is used so the
measurement reflects pure runtime overhead without workload noise. The output is verified to
be `"hello\n"` on every iteration to ensure correctness.

Each configuration runs 5 iterations (x batch size samples each) with 1 warmup iteration
discarded. Tail percentiles at small batch sizes (<=10) have low sample counts and should be
interpreted with caution.

Sandbox provider comparison uses the **p95 TTI** (time-to-interactive) from
[ComputeSDK benchmarks](https://www.computesdk.com/benchmarks/). As of March 2026, **e2b**
is the best-performing sandbox provider at **0.95s** p95 TTI.

### Warm Start

Time for a second `vm.exec("echo hello")` on an already-initialized VM. The kernel, all three
runtimes, and mounted filesystems are already set up. Only the per-command overhead is
measured: process table entry creation, WASM Worker thread dispatch, command execution, and
stdout pipe collection.

The difference between cold and warm start (~12 ms) isolates the cost of VM creation, which
only happens once per VM lifetime.

### Memory Per Instance

Uses a **staircase approach** to isolate the true incremental cost per VM:

1. **Warmup**: Create and destroy one throwaway VM to pay all one-time costs (module
   compilation, JIT warmup, code cache population). This ensures subsequent measurements
   reflect only per-instance overhead.
2. **Baseline**: Force GC (two passes, `--expose-gc`) and sample RSS/heap.
3. **Staircase**: Add VMs one at a time. After each VM is created and its workload started,
   wait for settle time, force GC, and sample memory. The delta from the previous sample
   is the incremental cost of that VM.
4. **Verification**: Before each snapshot, the benchmark asserts that the expected processes
   are running. For the PI workload, this checks both the pi-acp adapter in the spawn table
   and the V8 isolate child process (`driver === "node"`) in the kernel process table.
5. **Teardown**: Dispose all VMs and measure reclaimed RSS.

Two workloads are tested:

- **Sleep** (`--workload=sleep`): Each VM spawns `sleep 99999` to keep the WASM Worker
  thread alive. WASM processes run as Worker threads in the host process.
- **PI** (`--workload=pi`): Each VM creates a full PI agent session via `createSession("pi")`
  backed by a mock LLM server (llmock). This exercises the complete ACP session lifecycle
  including the V8 isolate child process.

**RSS measurement spans the full process tree.** The Node.js V8 runtime runs as a separate
child process (a Rust binary). `process.memoryUsage().rss` only captures the host process
and its Worker threads (WASM). To include the V8 child process, the benchmark reads
`/proc/[pid]/statm` for the host and all descendant PIDs, summing their RSS. This ensures
the reported numbers reflect the true total memory cost, not just the host side.

Sandbox provider memory comparison uses the **minimum allocatable memory** across popular
providers (e2b, Daytona, Modal, Cloudflare) as of March 2026. The minimum is **256 MB**
(Modal and Cloudflare).

## Test Environment

| Component          | Details                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| CPU                | 12th Gen Intel i7-12700KF, 12 cores / 20 threads @ 3.7 GHz, 25 MB cache |
| Node.js            | v24.13.0                                                                 |
| RAM                | 2x 32 GB Kingston FURY Beast DDR4 (KF3200C16D4/32GX), 3200 MHz CL16    |
| OS                 | Linux 6.1.0-41-amd64 (x64)                                              |
| Timing             | Host-side `performance.now()` used for all measurements. WASM processes run in Worker threads; timing is unaffected by any in-VM clock restrictions. |

## Reproducing

```bash
# Clone and install
git clone https://github.com/rivet-dev/agent-os
cd agent-os && pnpm install

# Run all benchmarks (saves timestamped results to benchmarks/results/)
cd registry/tool/sandbox
./benchmarks/run-benchmarks.sh

# Or run individually
npx tsx benchmarks/echo.bench.ts                                            # cold + warm start

# Memory with sleep workload (WASM process)
npx tsx --expose-gc benchmarks/memory.bench.ts                              # default (5 VMs)
npx tsx --expose-gc benchmarks/memory.bench.ts --count=1                    # single VM

# Memory with PI session workload (V8 isolate)
npx tsx --expose-gc benchmarks/memory.bench.ts --workload=pi                # default (5 VMs)
npx tsx --expose-gc benchmarks/memory.bench.ts --workload=pi --count=1      # single VM
```

Results will vary by hardware. The numbers above are from the test environment described above.
