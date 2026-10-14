declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

// Milliseconds per work unit. Each fixture spins its own inline loop until its share of wall time has passed, so the
// expected shares hold regardless of how well the JIT compiles each loop (Node 24's V8 differs from Node 22's).
export const UNIT_MS = Number(process.env.OBSERVE_FIXTURE_UNIT_MS ?? 50);
