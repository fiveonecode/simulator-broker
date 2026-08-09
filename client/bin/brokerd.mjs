#!/usr/bin/env node

import process from "node:process";

import { resolveBrokerPaths } from "../../broker-core/index.mjs";
import { flagValue, format, parseArgs } from "../command-dispatch.mjs";
import { startBrokerService } from "../service/brokerd.mjs";

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const paths = resolveBrokerPaths({
    cwd: process.cwd(),
    hostConfigPath: flagValue(flags, "host-config"),
    serviceSocketPath: flagValue(flags, "service-socket"),
    stateRoot: flagValue(flags, "state-root"),
  });

  const { metadata } = await startBrokerService(paths);
  if (flags.has("print-ready")) {
    process.stdout.write(format({
      ok: true,
      service: metadata,
    }));
  }
}

main().catch((error) => {
  process.stdout.write(format({
    error: error?.message ?? String(error),
    ok: false,
    stack: error?.stack ?? null,
  }));
  process.exit(1);
});
