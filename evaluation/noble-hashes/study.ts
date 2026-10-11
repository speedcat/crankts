// Eval #5: noble-hashes 2.4.0 (pure compute- and typed-array-heavy control; an upper bound, not typical backend code).
// Setup (pinned, outside the repo): ../crankts-eval/noble-hashes@2.4.0, `npm ci --ignore-scripts`. Node runs its
// TypeScript sources directly (type stripping). Scratch workloads in crankts-workloads/: bulk hashing, KDFs, and
// 300k small messages through hash/hmac/hkdf.
import { resolve } from "node:path";
import type { StudyConfig } from "../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const noble = resolve(repoRoot, "../crankts-eval/noble-hashes");

const study: StudyConfig = {
  name: "noble-hashes",
  version: "2.4.0",
  description: "noble-hashes (pure TypeScript hashes and KDFs) on bulk, KDF, and small-message workloads",
  analysisRoot: noble,
  cwd: noble,
  workloads: [
    { name: "bulk hashing (30 rounds x 8 hashes x 1 MiB)", args: ["crankts-workloads/hashes.ts"] },
    { name: "KDFs (pbkdf2 1M, scrypt 2^15, argon2id 64 MiB)", args: ["crankts-workloads/kdf.ts"] },
    { name: "small messages (300k x hash/hmac/hkdf)", args: ["crankts-workloads/small-messages.ts"] },
  ],
  annotations: resolve(repoRoot, "evaluation/noble-hashes/annotations.json"),
  output: resolve(repoRoot, "evaluation/crankts-noble-hashes-coverage.json"),
};
export default study;
