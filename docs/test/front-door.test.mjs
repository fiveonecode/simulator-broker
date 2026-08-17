import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function firstScreen(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headingIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      headingIndexes.push(index);
    }
  }
  const cutoff = headingIndexes.length >= 2 ? headingIndexes[1] : lines.length;
  return lines.slice(0, cutoff).join("\n");
}

test("README first screen is a product front door, not an implementation changelog", () => {
  const readme = readRepoFile("README.md");
  const screen = firstScreen(readme);

  assert.ok(readme.startsWith("# Simulator Broker\n"));
  assert.equal(screen.includes("Simulator Broker App"), false);
  assert.ok(screen.includes("iOS Simulator"));
  assert.ok(/humans/i.test(screen));
  assert.ok(/agents/i.test(screen));
  assert.ok(screen.includes("CI"));
  assert.ok(screen.includes("Alpha"));
  assert.ok(screen.includes("macOS"));
  assert.ok(screen.includes("Xcode"));
  assert.equal(
    screen.includes("a first extracted file-backed `broker-core` slice exists"),
    false,
  );
  assert.equal(/^Current status:/m.test(screen), false);
});

test("README separates use-versus-develop install guidance and includes a hello-world block", () => {
  const readme = readRepoFile("README.md");

  assert.ok(readme.includes("\n## Use it\n"));
  assert.ok(readme.includes("\n## Develop it\n"));
  assert.ok(readme.includes("npm run install:local"));
  assert.ok(readme.includes("\n## Five-minute hello world\n"));
  assert.ok(readme.includes("simbroker project init"));
  assert.ok(readme.includes("simbroker lease acquire"));
});

test("README links newcomer docs and embeds a real screenshot file", () => {
  const readme = readRepoFile("README.md");
  const imageMatch = /!\[.*?]\((.*?)\)/.exec(readme);

  assert.ok(imageMatch, "README must embed a screenshot image");
  assert.ok(readme.includes("[Getting started](docs/getting-started.md)"));
  assert.ok(readme.includes("[Concepts](docs/concepts.md)"));
  assert.equal(fs.existsSync(path.join(repoRoot, "docs/getting-started.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "docs/concepts.md")), true);

  const relativeImage = imageMatch[1];
  const imagePath = path.join(repoRoot, relativeImage);
  assert.equal(fs.existsSync(imagePath), true, `missing screenshot ${relativeImage}`);

  const bytes = fs.readFileSync(imagePath);
  assert.ok(bytes.length > 10_000, "screenshot must not be an empty or stub file");
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "screenshot must be a PNG",
  );
});
