import { spawn } from "node:child_process";

/**
 * Runs one measurement of the workload in its own process group (docs/observe-plan.md §8): SIGINT/SIGTERM are
 * forwarded to the group, a timeout sends SIGTERM and then SIGKILL after a grace period, and the run ends only
 * once every process in the group has exited (launchers such as npm may exit before their children).
 */

export interface WorkloadRun {
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** SIGKILL was needed after the grace period. */
  readonly killed: boolean;
  readonly wallMs: number;
}

export interface SpawnOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly graceMs?: number;
  /** Defaults to inheriting the terminal. */
  readonly stdio?: "inherit" | "ignore" | "pipe";
}

export function runWorkload(options: SpawnOptions): Promise<WorkloadRun> {
  const [file, ...args] = options.command;
  if (!file) return Promise.reject(new Error("No workload command given."));
  const graceMs = options.graceMs ?? 10_000;
  const started = performance.now();

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: options.stdio ?? "inherit", detached: process.platform !== "win32" });
    const group = child.pid;
    let timedOut = false;
    let killed = false;
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (group === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-group, signal);
      } catch {
        // Already gone.
      }
    };
    const forward = (signal: NodeJS.Signals) => () => signalGroup(signal);
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);

    const escalate = (): void => {
      killTimer ??= setTimeout(() => {
        killed = true;
        signalGroup("SIGKILL");
      }, graceMs);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      escalate();
    }, options.timeoutMs);

    const finish = (code: number | null, signal: string | null): void => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolvePromise({ code, signal, timedOut, killed, wallMs: Math.round(performance.now() - started) });
    };

    child.once("error", (error) => {
      clearTimeout(timeout);
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      rejectPromise(new Error(`Unable to start '${file}': ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      // Wait for the rest of the group (children of launchers still write their profiles).
      if (group === undefined || process.platform === "win32") {
        finish(code, signal);
        return;
      }
      const deadline = Date.now() + graceMs;
      const poll = (): void => {
        if (!groupAlive(group)) {
          finish(code, signal);
        } else if (Date.now() > deadline) {
          killed = true;
          signalGroup("SIGKILL");
          setTimeout(() => finish(code, signal), 100);
        } else {
          setTimeout(poll, 25);
        }
      };
      poll();
    });
  });
}

function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
