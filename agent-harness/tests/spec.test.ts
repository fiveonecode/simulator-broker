import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateRelatedLines } from "../src/lib/spec.js";

describe("spec related-line validation", () => {
  it("passes when each heading is followed by a Related line", () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-spec-pass-"));
    const filePath = path.join(temporaryDirectory, "valid.md");

    writeFileSync(filePath, "# Title\nRelated: `spec/README.md`\n\n## Section\nRelated: `spec/build-and-test.md`\n");

    expect(validateRelatedLines(filePath).passed).toBe(true);
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  it("fails when a heading is missing a Related line", () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-spec-fail-"));
    const filePath = path.join(temporaryDirectory, "invalid.md");

    writeFileSync(filePath, "# Title\nRelated: `spec/README.md`\n\n## Section\nMissing related line\n");

    expect(validateRelatedLines(filePath).passed).toBe(false);
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });
});
