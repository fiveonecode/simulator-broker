// -------------------------------------------------------------------------- //
//                                  IMPORTS                                   //
// -------------------------------------------------------------------------- //

import { readFileSync } from "node:fs";

import type { RuleResult } from "./types.js";

// -------------------------------------------------------------------------- //
//                              SPEC VALIDATION                               //
// -------------------------------------------------------------------------- //

export function validateRelatedLines(filePath: string): RuleResult {
  const source = readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  const details: string[] = [];

  lines.forEach((line, index) => {
    if (/^#{1,6}\s+\S/.test(line) === false) {
      return;
    }

    const nextNonEmptyLine = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0);

    if (nextNonEmptyLine?.startsWith("Related:") !== true) {
      details.push(`Heading on line ${index + 1} is missing a following Related: line.`);
    }
  });

  return {
    details,
    name: "related-lines",
    passed: details.length === 0,
  };
}
