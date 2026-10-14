import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Real path; for a missing file, the real path of its nearest existing ancestor plus the rest. Profile URLs carry
 * real paths (e.g. /private/var on macOS, pnpm's store links), so roots and paths are compared in this form.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}
