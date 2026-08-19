import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  assert.ok(screen.includes("> **Alpha.**"), "README first screen must use a visible Alpha banner");
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
  assert.ok(readme.includes("bash scripts/install_local.sh --cli-only"));
  assert.ok(readme.includes("npm run install:local"));
  assert.ok(readme.includes("\n## Five-minute hello world\n"));
  assert.ok(readme.includes("simbroker project init"));
  assert.ok(readme.includes("simbroker lease acquire"));
});

function headingSection(markdown, heading) {
  const marker = `\n## ${heading}\n`;
  const start = markdown.indexOf(marker);
  if (start === -1) {
    return "";
  }
  const bodyStart = start + marker.length;
  const next = markdown.indexOf("\n## ", bodyStart);
  return markdown.slice(bodyStart, next === -1 ? markdown.length : next);
}

test("CONTRIBUTING leads with a public Node-20 patch track that does not require the harness", () => {
  const contributing = readRepoFile("CONTRIBUTING.md");
  const human = headingSection(contributing, "Public patches");
  const firstHeading = contributing.split(/\r?\n/).find((line) => line.startsWith("## "));

  assert.equal(firstHeading, "## Public patches");
  assert.ok(human.length > 0, "CONTRIBUTING must have a Public patches section");
  assert.ok(
    contributing.includes("Node.js 20") || contributing.includes("Node 20") || contributing.includes(">=20"),
    "CONTRIBUTING must name Node 20",
  );
  assert.ok(
    human.includes("npm run test:broker-core")
      || human.includes("npm run test:client")
      || human.includes("npm run test:harness-adoption")
      || human.includes("npm test"),
    "public track must name a Node test command that is not agent:*",
  );
  assert.equal(human.includes("You do not need to run `agent:context`"), true);
  assert.equal(human.includes("$HOME/.codex"), false);
  assert.equal(human.includes("npm run agent:context --"), false);
  assert.equal(human.includes("npm run agent:verify --"), false);
  assert.equal(human.includes("npm run agent:complete --"), false);
});

test("CONTRIBUTING keeps a labeled maintainer harness track", () => {
  const contributing = readRepoFile("CONTRIBUTING.md");
  const harness = headingSection(contributing, "Maintainers and agent runs");

  assert.ok(harness.length > 0, "CONTRIBUTING must have a Maintainers and agent runs section");
  assert.ok(harness.includes("agent:context"));
  assert.ok(harness.includes("agent:verify"));
  assert.ok(harness.includes("agent:complete"));
  assert.ok(harness.includes("npm run agent:context --"));
  assert.ok(harness.includes("npm run agent:verify --"));
  assert.ok(harness.includes("npm run agent:complete --"));
});

test("README links newcomer docs and embeds a real screenshot file", () => {
  const readme = readRepoFile("README.md");
  const imageMatch = [...readme.matchAll(/!\[.*?]\((.*?)\)/g)]
    .map((match) => match[1])
    .find((image) => image.endsWith(".png") && !/^https?:\/\//.test(image));

  assert.ok(imageMatch, "README must embed a screenshot image");
  assert.ok(readme.includes("[Getting started](docs/getting-started.md)"));
  assert.ok(readme.includes("[Concepts](docs/concepts.md)"));
  assert.equal(fs.existsSync(path.join(repoRoot, "docs/getting-started.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "docs/concepts.md")), true);

  const relativeImage = imageMatch;
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

test("README advertises GitHub Releases and the public Node CI badge", () => {
  const readme = readRepoFile("README.md");

  assert.ok(readme.includes("actions/workflows/ci.yml/badge.svg"));
  assert.ok(readme.includes("github.com/fiveonecode/simulator-broker/releases"));
  assert.ok(readme.includes("./bin/simbroker --help"));
  assert.equal(readme.includes("or GitHub Release yet"), false);
  assert.ok(readme.includes("There is no Homebrew formula or npm package yet."));
});

test("CHANGELOG and package.json name the Alpha version", () => {
  const changelog = readRepoFile("CHANGELOG.md");
  const packageJson = JSON.parse(readRepoFile("package.json"));

  assert.equal(packageJson.version, "0.1.0-alpha.1");
  assert.ok(changelog.includes("## [0.1.0-alpha.1]"));
  assert.ok(changelog.includes("scripts/package_cli.sh"));
});

test("public CI runs the Node suites on Ubuntu and skips the macOS app suite", () => {
  const ci = readRepoFile(".github/workflows/ci.yml");

  assert.ok(ci.includes("runs-on: ubuntu-latest"));
  assert.match(ci, /timeout-minutes:\s*([3-9]\d|\d{3,})/);
  assert.ok(ci.includes("npm run verify:public-surface"));
  assert.ok(ci.includes("npm run test:broker-core"));
  assert.ok(ci.includes("npm run test:client"));
  assert.ok(ci.includes("npm run test:harness-adoption"));
  assert.equal(ci.includes("test:app"), false);
  assert.equal(ci.includes("macos-latest"), false);
  assert.equal(/\n\s+run:\s*npm install\b/.test(ci), false);
  assert.equal(/\n\s+run:\s*npm ci\b/.test(ci), false);
});

test("release workflow packages the CLI tarball on version tags", () => {
  const release = readRepoFile(".github/workflows/release.yml");

  assert.ok(release.includes("tags:"));
  assert.ok(release.includes("npm run package:cli"));
  assert.ok(release.includes("gh release create"));
  assert.ok(release.includes("--prerelease"));
  assert.equal(release.includes("test:app"), false);
});

test("issue forms cover install failure, bug, and feature and state Alpha limits", () => {
  const config = readRepoFile(".github/ISSUE_TEMPLATE/config.yml");
  const install = readRepoFile(".github/ISSUE_TEMPLATE/install-failure.yml");
  const bug = readRepoFile(".github/ISSUE_TEMPLATE/bug.yml");
  const feature = readRepoFile(".github/ISSUE_TEMPLATE/feature.yml");

  assert.ok(config.includes("blank_issues_enabled: false"));
  assert.ok(config.includes("security/advisories"));
  assert.ok(install.includes("name: Install failure"));
  assert.ok(bug.includes("name: Bug"));
  assert.ok(feature.includes("name: Feature"));
  assert.ok(install.includes("install_local.sh --cli-only"));
  assert.ok(bug.includes("labels:"));
  assert.ok(feature.includes("enhancement"));
  for (const body of [install, bug, feature, config]) {
    assert.ok(body.includes("Alpha"), "community forms must say Alpha");
    assert.ok(body.includes("macOS"), "community forms must say macOS");
    assert.ok(body.includes("Xcode"), "community forms must say Xcode");
  }
});

test("PR template is a public-patch checklist and does not require the harness", () => {
  const template = readRepoFile(".github/pull_request_template.md");

  assert.ok(template.includes("npm run test:broker-core"));
  assert.ok(template.includes("npm run test:client"));
  assert.ok(template.includes("npm run test:harness-adoption"));
  assert.ok(template.includes("Alpha"));
  assert.ok(template.includes("macOS"));
  assert.ok(template.includes("Xcode"));
  assert.equal(template.includes("agent:context"), false);
  assert.equal(template.includes("agent:verify"), false);
  assert.equal(template.includes("agent:complete"), false);
  assert.equal(template.includes("session-dir"), false);
  assert.equal(template.includes("$HOME/.codex"), false);
});

test("status and contributing point strangers at issue forms, not later-sequence work", () => {
  const status = readRepoFile("docs/status.md");
  const contributing = readRepoFile("CONTRIBUTING.md");
  const gettingStarted = readRepoFile("docs/getting-started.md");
  const readme = readRepoFile("README.md");

  assert.ok(status.includes("GitHub issue forms"));
  assert.equal(status.includes("issue templates and starter issues"), false);
  assert.ok(contributing.includes("issues/new/choose"));
  assert.ok(contributing.includes("good first issue"));
  assert.ok(gettingStarted.includes("Report a problem"));
  assert.ok(readme.includes("issues/new/choose"));
});

test("package_cli.sh writes a runnable CLI tarball without tests or the app", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-package-cli-"));
  const result = spawnSync("bash", [path.join(repoRoot, "scripts/package_cli.sh"), "--output-dir", outputDir], {
    encoding: "utf8",
    cwd: repoRoot,
  });

  assert.equal(result.status, 0, result.stderr);
  const tarball = path.join(outputDir, "simulator-broker-0.1.0-alpha.1-cli.tar.gz");
  const checksum = `${tarball}.sha256`;
  assert.equal(fs.existsSync(tarball), true, result.stdout);
  assert.equal(fs.existsSync(checksum), true, result.stdout);

  const extractDir = path.join(outputDir, "extract");
  fs.mkdirSync(extractDir);
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", extractDir], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);

  const root = path.join(extractDir, "simulator-broker-0.1.0-alpha.1-cli");
  const help = spawnSync(path.join(root, "bin/simbroker"), ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes("simbroker") || help.stderr.includes("simbroker"));
  assert.equal(fs.existsSync(path.join(root, "broker-core/test")), false);
  assert.equal(fs.existsSync(path.join(root, "client/test")), false);
  assert.equal(fs.existsSync(path.join(root, "app")), false);
  assert.equal(fs.existsSync(path.join(root, "LICENSE")), true);
});
