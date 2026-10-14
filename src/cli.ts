#!/usr/bin/env node
import { runCli } from "./index.js";

void Promise.resolve(runCli(process.argv.slice(2))).then((code) => {
  process.exitCode = code;
});