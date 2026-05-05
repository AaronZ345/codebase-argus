#!/usr/bin/env node

import { runCli } from "./lib/cli";

void runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
