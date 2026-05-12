// Runtime observability for the agent sandbox. Three responsibilities:
//
//   1. Heartbeat: periodic `/v1/tasks/:id/heartbeat` ping so the manager can
//      tell the agent is alive even when the LLM is mid-thought.
//   2. Watchdog: if the underlying child (pi/opencode) hasn't emitted a line
//      in STALL_MS milliseconds, kill the child and mark the run failed. The
//      runner can also call `markActivity()` from anywhere to refresh the
//      idle timer.
//   3. Transcript capture: every line forwarded to the manager is also
//      appended to an in-memory NDJSON buffer; on shutdown the buffer plus
//      any files under workdir are uploaded as run artifacts so an operator
//      can read what happened from the UI without scraping CloudWatch.
//
// This module is duplicated verbatim in am-pi-agent and am-opencode-agent;
// there is no shared SDK yet by design. Keep changes in sync.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { ManagerClient } from "./sdk.js";

export interface MonitorOpts {
  client: ManagerClient;
  taskId: string;
  workdir: string;
  /** Heartbeat ping cadence in ms. Default 30_000. */
  heartbeatMs?: number;
  /** Watchdog stall threshold in ms. Default 120_000. */
  stallMs?: number;
  /** Called when the watchdog fires. Should kill the child. */
  onStall?: (idleMs: number) => void;
}

export interface Monitor {
  /** Append a line to the captured transcript. */
  appendTranscript(line: string): void;
  /** Refresh the watchdog. Call on every child stdout/stderr line. */
  markActivity(): void;
  /** Take a snapshot for the UI: never throws, returns the full transcript. */
  getTranscript(): string;
  /** Stop the heartbeat + watchdog timers. */
  stop(): void;
  /**
   * Upload transcript + workdir contents to manager artifacts. Safe to call
   * multiple times; the last call wins. Never throws.
   */
  finalize(opts: {
    systemPrompt: string;
    payload: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
  }): Promise<void>;
}

export function startMonitor(opts: MonitorOpts): Monitor {
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const stallMs = opts.stallMs ?? 120_000;
  const transcript: string[] = [];
  let lastActivity = Date.now();
  let stopped = false;

  const heartbeat = setInterval(() => {
    if (stopped) return;
    const idle = Date.now() - lastActivity;
    void opts.client
      .heartbeat?.({ idleMs: idle, transcriptLines: transcript.length })
      .catch(() => {
        /* heartbeat is best effort */
      });
  }, heartbeatMs);

  const watchdog = setInterval(() => {
    if (stopped) return;
    const idle = Date.now() - lastActivity;
    if (idle > stallMs) {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(watchdog);
      try {
        opts.onStall?.(idle);
      } catch {
        /* swallow */
      }
    }
  }, Math.max(5_000, Math.floor(stallMs / 4)));

  return {
    appendTranscript(line) {
      transcript.push(line);
      // Cap at ~50k lines to avoid runaway memory; older lines drop.
      if (transcript.length > 50_000) transcript.splice(0, transcript.length - 50_000);
    },
    markActivity() {
      lastActivity = Date.now();
    },
    getTranscript() {
      return transcript.join("\n");
    },
    stop() {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(watchdog);
    },
    async finalize({ systemPrompt, payload, result, error }) {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(watchdog);
      const uploads: Array<{ key: string; body: Buffer; ct: string }> = [];
      uploads.push({
        key: "transcript.ndjson",
        body: Buffer.from(`${transcript.join("\n")}\n`),
        ct: "application/x-ndjson",
      });
      uploads.push({
        key: "system-prompt.md",
        body: Buffer.from(systemPrompt),
        ct: "text/markdown",
      });
      uploads.push({
        key: "payload.json",
        body: Buffer.from(JSON.stringify(payload, null, 2)),
        ct: "application/json",
      });
      if (result) {
        uploads.push({
          key: "result.json",
          body: Buffer.from(JSON.stringify(result, null, 2)),
          ct: "application/json",
        });
      }
      if (error) {
        uploads.push({
          key: "error.json",
          body: Buffer.from(JSON.stringify(error, null, 2)),
          ct: "application/json",
        });
      }
      // Walk workdir, upload every regular file under .am-out/ and any other
      // file the agent produced at top level (vulns.json, coverage.json,
      // template.yaml, etc).
      try {
        for (const file of walk(opts.workdir, 4)) {
          const rel = relative(opts.workdir, file).replace(/\\/g, "/");
          if (rel.startsWith(".am-out/") || !rel.includes("/")) {
            try {
              uploads.push({
                key: `workdir/${rel}`,
                body: readFileSync(file),
                ct: "application/octet-stream",
              });
            } catch {
              /* skip unreadable */
            }
          }
        }
      } catch {
        /* workdir walk best effort */
      }
      for (const u of uploads) {
        try {
          await opts.client.uploadArtifact(u.key, u.body, u.ct);
        } catch {
          /* each upload best effort; don't block finalize */
        }
      }
    },
  };
}

function* walk(dir: string, depth: number): Generator<string> {
  if (depth < 0) return;
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p, depth - 1);
    } else if (e.isFile()) {
      try {
        const s = statSync(p);
        if (s.size <= 2_000_000) yield p; // skip files >2 MB
      } catch {
        /* skip */
      }
    }
  }
}
