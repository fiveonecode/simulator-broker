#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("Missing output path.");
}

const report = {
  actorType: process.env.SIMBROKER_ACTOR_TYPE ?? null,
  leaseFile: process.env.SIMBROKER_LEASE_FILE ?? null,
  leaseId: process.env.SIMBROKER_LEASE_ID ?? null,
  projectId: process.env.SIMBROKER_PROJECT_ID ?? null,
  purposeId: process.env.SIMBROKER_PURPOSE_ID ?? null,
  resetPolicy: process.env.SIMBROKER_RESET_POLICY ?? null,
  simulatorAlias: process.env.SIMBROKER_SIMULATOR_ALIAS ?? null,
  simulatorId: process.env.SIMBROKER_SIMULATOR_ID ?? null,
  timestamp: new Date().toISOString(),
};

if (process.env.SIMBROKER_JOB_ID || process.env.CI_JOB_ID) {
  report.jobId = process.env.SIMBROKER_JOB_ID ?? process.env.CI_JOB_ID;
}
if (process.env.SIMBROKER_JOB_KIND || process.env.CI_JOB_KIND) {
  report.jobKind = process.env.SIMBROKER_JOB_KIND ?? process.env.CI_JOB_KIND;
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
