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

const packageJson = JSON.parse(readRepoFile("package.json"));
const version = packageJson.version;

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

test("README Use it orders Homebrew CLI, cask, guided setup, then hello world", () => {
  const readme = readRepoFile("README.md");
  const useIt = headingSection(readme, "Use it");
  const hello = headingSection(readme, "Five-minute hello world");
  const gettingStarted = readRepoFile("docs/getting-started.md");

  assert.ok(useIt.includes("brew install fiveonecode/simulator-broker/simbroker"));
  assert.ok(useIt.includes("brew install --cask fiveonecode/simulator-broker/simulator-broker"));
  assert.ok(
    useIt.includes("Set Up This Mac") || useIt.includes("Complete first-time setup"),
    "Use it must name the app first-run surface",
  );
  assert.ok(useIt.includes("simbroker setup"));
  assert.ok(useIt.includes("--apply --confirm <plan-id> --json"));
  assert.equal(useIt.includes("simbroker host init --bootstrap-config\nsimbroker service start"), false);
  assert.ok(
    /Homebrew\s+does not create/i.test(useIt),
    "Use it must not claim Homebrew creates simulators",
  );
  assert.ok(
    /after `simbroker setup` reports ready/i.test(hello),
    "Use it must place hello world after guided setup reports ready",
  );

  assert.ok(hello.includes("simbroker capacity check --purpose agent-ui-session --json"));
  assert.ok(hello.includes("purposes[].status"));
  assert.ok(hello.includes("needs_attention"));
  assert.ok(/unavailable/.test(hello));
  assert.ok(/repair_needed/.test(hello));
  assert.ok(hello.includes("simbroker capacity reconcile --json"));
  assert.ok(hello.includes("simbroker doctor"));
  assert.ok(hello.includes("simbroker simulators repair --alias <alias>"));
  assert.equal(hello.includes("simbroker simulators repair\n"), false);
  assert.ok(hello.includes("simbroker lease acquire"));
  const gettingHello = headingSection(gettingStarted, "Hello world");
  assert.ok(gettingHello.includes("simbroker capacity check --purpose agent-ui-session --json"));
  assert.ok(gettingHello.includes("purposes[].status"));
  assert.ok(gettingHello.includes("simbroker capacity reconcile --json"));
  assert.ok(gettingHello.includes("simbroker doctor"));
  assert.ok(gettingHello.includes("simbroker simulators repair --alias <alias>"));
  assert.ok(/unavailable/.test(gettingHello));
  assert.ok(/repair_needed/.test(gettingHello));
});

test("newcomer docs enforce one guided machine setup and version-agnostic project defaults", () => {
  const readme = readRepoFile("README.md");
  const gettingStarted = readRepoFile("docs/getting-started.md");
  const packageReadme = readRepoFile("packages/simbroker/README.md");
  const brokerCore = readRepoFile("broker-core/index.mjs");
  const installSmoke = readRepoFile("scripts/install_smoke.sh");

  for (const body of [readme, gettingStarted, packageReadme]) {
    assert.ok(body.includes("simbroker setup"));
  }
  assert.equal(
    /Next Alpha availability/i.test(readme),
    false,
    "README must not keep the pre-alpha.3 setup-unavailable warning",
  );
  assert.equal(
    /predates/i.test(packageReadme),
    false,
    "package README must not claim the current tagged package predates setup",
  );
  assert.equal(
    /Next Alpha availability/i.test(gettingStarted),
    false,
    "getting started must not keep the pre-alpha.3 setup-unavailable warning",
  );
  for (const body of [readme, gettingStarted]) {
    assert.equal(
      body.includes("simbroker host init --bootstrap-config\nsimbroker service start"),
      false,
      "newcomer docs must not restore the old two-command machine setup path",
    );
  }
  assert.match(brokerCore, /const normalizedIosVersion = iosVersion === undefined \|\| iosVersion === null/);
  assert.equal(
    /function buildStarterProjectConfig\([\s\S]{0,160}iosVersion = ["']18["']/.test(brokerCore),
    false,
    "new project scaffolds must not restore a hardcoded iOS version",
  );
  assert.equal(
    installSmoke.includes("service_started"),
    false,
    "install smoke cleanup must attempt an idempotent service stop even when setup apply fails",
  );
  assert.match(
    installSmoke,
    /if \[\[ "\$service_stopped" -eq 0 && -x "\$cli_path" \]\]; then[\s\S]*?service stop/,
  );
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
  assert.ok(human.includes("npm run test:docs"), "public track must name test:docs");
  assert.ok(
    human.includes("does not run") && human.includes("npm run test:docs"),
    "public track must not claim Ubuntu CI runs test:docs",
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
  assert.equal(readme.includes("There is no Homebrew formula or npm package yet."), false);
  assert.ok(readme.includes("brew install fiveonecode/simulator-broker/simbroker"));
  assert.ok(readme.includes("brew install --cask fiveonecode/simulator-broker/simulator-broker"));
  assert.ok(readme.includes("homebrew-simulator-broker"));
  assert.ok(readme.includes("npm install -g"));
  assert.ok(readme.includes(`simbroker-${version}.tgz`));
  assert.equal(readme.includes("is not attached"), false);
});

test("CHANGELOG and package.json name the Alpha version", () => {
  const changelog = readRepoFile("CHANGELOG.md");

  assert.equal(packageJson.version, version);
  assert.match(version, /^0\.1\.0-alpha\.\d+$/);
  assert.ok(changelog.includes(`## [${version}]`));
  assert.ok(changelog.includes("scripts/package_cli.sh"));
});

test("public CI splits Ubuntu core suites from macOS client tests and skips the app suite", () => {
  const ci = readRepoFile(".github/workflows/ci.yml");

  assert.ok(ci.includes("runs-on: ubuntu-latest"));
  assert.ok(ci.includes("runs-on: macos-latest"));
  assert.match(ci, /timeout-minutes:\s*10/);
  assert.match(ci, /timeout-minutes:\s*15/);
  assert.equal(ci.includes("npm run verify:public-surface"), false);
  assert.ok(ci.includes("npm run test:broker-core"));
  const clientTestRun = ci
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("run:") && line.includes("client/test/*.test.mjs")) ?? "";
  assert.equal(
    clientTestRun,
    "run: node --test --test-concurrency=1 --test-timeout=120000 client/test/*.test.mjs",
  );
  assert.ok(ci.includes("npm run test:harness-adoption"));
  assert.equal(ci.includes("test:app"), false);
  assert.equal(/\n\s+run:\s*npm install\b/.test(ci), false);
  assert.equal(/\n\s+run:\s*npm ci\b/.test(ci), false);
});

test("release workflow packages the CLI tarball on version tags", () => {
  const release = readRepoFile(".github/workflows/release.yml");

  assert.ok(release.includes("tags:"));
  assert.ok(release.includes("npm run package:cli"));
  assert.ok(release.includes("npm run package:npm"));
  assert.ok(release.includes("artifacts/npm/simbroker-${version}.tgz"));
  assert.ok(release.includes("gh release create"));
  assert.ok(release.includes("--prerelease"));
  assert.equal(release.includes("test:app"), false);
  assert.equal(
    release.replace(/\s+/g, " ").includes("This release is not a Homebrew formula, notarized app, or npm package."),
    false,
    "future release notes must not deny Homebrew and npm",
  );
  assert.equal(
    release.includes("operator app is not attached"),
    false,
    "tag release notes must not claim the notarized app zip is absent",
  );
  assert.ok(release.includes("brew install --cask fiveonecode/simulator-broker/simulator-broker"));
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
  assert.ok(install.includes("brew install fiveonecode/simulator-broker/simbroker"));
  assert.ok(install.includes("npm install -g"));
  assert.ok(install.includes(`simbroker-${version}.tgz`));
  assert.ok(install.includes("brew install --cask fiveonecode/simulator-broker/simulator-broker"));
  assert.equal(install.includes("operator app zip is not attached"), false);
  assert.equal(feature.includes("operator app zip is not attached"), false);
  assert.ok(feature.includes("Homebrew cask"));
  assert.ok(bug.includes("labels:"));
  assert.ok(feature.includes("enhancement"));
  for (const body of [install, bug, feature, config]) {
    assert.ok(body.includes("Alpha"), "community forms must say Alpha");
    assert.ok(body.includes("macOS"), "community forms must say macOS");
    assert.ok(body.includes("Xcode"), "community forms must say Xcode");
    assert.equal(
      body.replace(/\s+/g, " ").includes("There is no Homebrew formula, notarized app, or npm package yet."),
      false,
      "issue forms must not claim Homebrew/npm do not exist",
    );
  }
});

test("PR template is a public-patch checklist and does not require the harness", () => {
  const template = readRepoFile(".github/pull_request_template.md");

  assert.ok(template.includes("npm run test:broker-core"));
  assert.ok(template.includes("npm run test:client"));
  assert.ok(template.includes("npm run test:harness-adoption"));
  assert.ok(template.includes("npm run test:docs"));
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

test("Homebrew one-liner is documented against the homebrew-simulator-broker tap", () => {
  const readme = readRepoFile("README.md");
  const gettingStarted = readRepoFile("docs/getting-started.md");
  const structure = readRepoFile("spec/project-structure.md");
  const changelog = readRepoFile("CHANGELOG.md");
  const syncScript = readRepoFile("scripts/sync_homebrew_tap.sh");

  for (const body of [readme, gettingStarted, structure, changelog]) {
    assert.ok(
      body.includes("brew install fiveonecode/simulator-broker/simbroker"),
      "docs/specs must keep the advertised brew one-liner",
    );
    assert.ok(
      body.includes("homebrew-simulator-broker"),
      "docs/specs must name the GitHub tap repo Homebrew actually clones",
    );
  }

  assert.ok(syncScript.includes("--check-remote"));
  assert.ok(syncScript.includes("cmp -s"));
  assert.ok(syncScript.includes("--max-time"));
  assert.ok(syncScript.includes("Formula/simbroker.rb"));
});

test("sync_homebrew_tap.sh copies Formula and Casks into a tap checkout", () => {
  const tapDir = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-homebrew-tap-"));
  const init = spawnSync("git", ["init", tapDir], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const sync = spawnSync(
    "bash",
    [path.join(repoRoot, "scripts/sync_homebrew_tap.sh"), "--tap-dir", tapDir],
    { encoding: "utf8", cwd: repoRoot },
  );
  assert.equal(sync.status, 0, sync.stderr + sync.stdout);
  assert.equal(fs.existsSync(path.join(tapDir, "Formula/simbroker.rb")), true);
  assert.equal(fs.existsSync(path.join(tapDir, "Casks/simulator-broker.rb")), true);
  const copied = fs.readFileSync(path.join(tapDir, "Formula/simbroker.rb"), "utf8");
  const source = readRepoFile("Formula/simbroker.rb");
  assert.equal(copied, source);
});

test("Homebrew formula points at the Alpha CLI tarball and the cask names a notarized app zip", () => {
  const formula = readRepoFile("Formula/simbroker.rb");
  const cask = readRepoFile("Casks/simulator-broker.rb");
  const checksum = formula.match(/sha256 "([a-f0-9]{64})"/);
  const url = formula.match(/url "([^"]+)"/);

  assert.ok(formula.includes("class Simbroker < Formula"));
  assert.ok(url, "formula must have a url");
  assert.equal(
    url[1],
    `https://github.com/fiveonecode/simulator-broker/releases/download/v${version}/simulator-broker-${version}-cli.tar.gz`,
  );
  assert.ok(checksum, "formula must pin a sha256");
  assert.match(checksum[1], /^[a-f0-9]{64}$/);
  assert.ok(formula.includes('shell_output("#{bin}/simbroker --help")'));
  assert.ok(formula.includes("depends_on macos: :sonoma"));
  assert.equal(formula.includes("package:local"), false);

  assert.ok(cask.includes('cask "simulator-broker"'));
  assert.ok(cask.includes(`version "${version}"`));
  assert.ok(cask.includes("releases/download/v#{version}/Simulator-Broker-#{version}.zip"));
  assert.ok(cask.includes('app "Simulator Broker.app"'));
  assert.ok(cask.includes("depends_on macos: :sonoma"));
  const caskChecksum = cask.match(/sha256 "([a-f0-9]{64})"/);
  assert.ok(caskChecksum, "cask must pin a sha256");
  assert.match(caskChecksum[1], /^[a-f0-9]{64}$/);
  assert.equal(cask.includes("sha256 :no_check"), false);
  assert.equal(cask.includes("package:local"), false);
  assert.equal(cask.includes("package_local"), false);
  assert.ok(cask.includes("package:distribution") || cask.includes("package_distribution"));
  assert.ok(cask.includes("package:cask-zip") || cask.includes("package_cask_zip"));
  assert.equal(cask.includes("not this zip"), false);
});

test("root package stays private and package_npm.sh packs a runnable simbroker bin", () => {
  const rootPackage = JSON.parse(readRepoFile("package.json"));
  const cliPackage = JSON.parse(readRepoFile("packages/simbroker/package.json"));

  assert.equal(rootPackage.private, true);
  assert.equal(rootPackage.bin, undefined);
  assert.equal(cliPackage.name, "simbroker");
  assert.equal(cliPackage.private, false);
  assert.equal(cliPackage.bin.simbroker, "bin/simbroker.js");
  assert.equal(cliPackage.version, rootPackage.version);
  assert.ok(rootPackage.scripts["package:npm"].includes("package_npm.sh"));

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-package-npm-"));
  const pack = spawnSync("bash", [path.join(repoRoot, "scripts/package_npm.sh"), "--output-dir", outputDir], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  assert.equal(pack.status, 0, pack.stderr + pack.stdout);

  const tarball = path.join(outputDir, `simbroker-${version}.tgz`);
  assert.equal(fs.existsSync(tarball), true, pack.stdout);

  const installDir = path.join(outputDir, "prefix");
  fs.mkdirSync(installDir);
  const install = spawnSync("npm", ["install", "--global", "--prefix", installDir, tarball], {
    encoding: "utf8",
    cwd: outputDir,
  });
  assert.equal(install.status, 0, install.stderr + install.stdout);

  const installedBin = path.join(installDir, "bin/simbroker");
  const help = spawnSync(installedBin, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  const helpText = `${help.stdout}${help.stderr}`;
  assert.ok(helpText.includes("simbroker"));
  assert.equal(helpText.trim().startsWith("{"), false, "help must not be JSON-only");
  assert.equal(fs.existsSync(path.join(installDir, "lib/node_modules/simbroker/broker-core/test")), false);
  assert.equal(fs.existsSync(path.join(installDir, "lib/node_modules/simbroker/client/test")), false);
});

test("package_cli.sh writes a runnable CLI tarball without tests or the app", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-package-cli-"));
  const result = spawnSync("bash", [path.join(repoRoot, "scripts/package_cli.sh"), "--output-dir", outputDir], {
    encoding: "utf8",
    cwd: repoRoot,
  });

  assert.equal(result.status, 0, result.stderr);
  const tarball = path.join(outputDir, `simulator-broker-${version}-cli.tar.gz`);
  const checksum = `${tarball}.sha256`;
  assert.equal(fs.existsSync(tarball), true, result.stdout);
  assert.equal(fs.existsSync(checksum), true, result.stdout);

  const extractDir = path.join(outputDir, "extract");
  fs.mkdirSync(extractDir);
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", extractDir], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);

  const root = path.join(extractDir, `simulator-broker-${version}-cli`);
  const help = spawnSync(path.join(root, "bin/simbroker"), ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes("simbroker") || help.stderr.includes("simbroker"));
  assert.equal(fs.existsSync(path.join(root, "broker-core/test")), false);
  assert.equal(fs.existsSync(path.join(root, "client/test")), false);
  assert.equal(fs.existsSync(path.join(root, "app")), false);
  assert.equal(fs.existsSync(path.join(root, "LICENSE")), true);
});

test("package_cask_zip.sh is the Homebrew cask zip path", () => {
  const script = readRepoFile("scripts/package_cask_zip.sh");
  const pkg = JSON.parse(readRepoFile("package.json"));
  const spec = readRepoFile("spec/build-and-test.md");
  const gettingStarted = readRepoFile("docs/getting-started.md");

  assert.ok(pkg.scripts["package:cask-zip"].includes("package_cask_zip.sh"));
  assert.ok(script.includes("ditto -c -k --keepParent"));
  assert.ok(script.includes("Simulator Broker.app"));
  assert.ok(script.includes("Developer ID Application"));
  assert.ok(script.includes("xcrun stapler validate"));
  assert.equal(script.includes("package:local"), false);
  assert.equal(/51Code|51code-developer-id/.test(script), false);
  const missingAppIndex = script.indexOf("Signed app bundle not found");
  const darwinGateIndex = script.indexOf('uname -s');
  assert.ok(missingAppIndex >= 0 && darwinGateIndex >= 0 && missingAppIndex < darwinGateIndex);
  assert.ok(spec.includes("## Tagged Alpha ship"));
  assert.ok(spec.includes("npm run package:cask-zip"));
  assert.ok(spec.includes("xcrun stapler validate"));
  assert.ok(spec.includes("gh release upload"));
  assert.ok(spec.includes("--clobber"));
  assert.ok(gettingStarted.includes("npm run package:cask-zip"));
});

test("package_cask_zip.sh refuses a missing app", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-package-cask-zip-missing-"));
  const result = spawnSync(
    "bash",
    [
      path.join(repoRoot, "scripts/package_cask_zip.sh"),
      "--app",
      path.join(outputDir, "Simulator Broker.app"),
      "--output-dir",
      outputDir,
    ],
    { encoding: "utf8", cwd: repoRoot },
  );

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(`${result.stdout}${result.stderr}`, /not found|does not exist|missing/i);
});

test("package_cask_zip.sh refuses an unsigned app bundle", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-package-cask-zip-unsigned-"));
  const app = path.join(outputDir, "Simulator Broker.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>SimulatorBrokerApp</string>
  <key>CFBundleIdentifier</key><string>dev.codex.simulator-broker-app</string>
  <key>CFBundleName</key><string>Simulator Broker</string>
</dict></plist>
`,
  );
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "SimulatorBrokerApp"), "unsigned\n");
  fs.chmodSync(path.join(app, "Contents", "MacOS", "SimulatorBrokerApp"), 0o755);

  const result = spawnSync(
    "bash",
    [path.join(repoRoot, "scripts/package_cask_zip.sh"), "--app", app, "--output-dir", outputDir],
    { encoding: "utf8", cwd: repoRoot },
  );

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  if (process.platform === "darwin") {
    assert.match(
      `${result.stdout}${result.stderr}`,
      /not signed|ad-hoc|Developer ID Application|codesign could not read/i,
    );
  } else {
    assert.match(`${result.stdout}${result.stderr}`, /requires macOS ditto/i);
  }
  assert.equal(fs.existsSync(path.join(outputDir, `Simulator-Broker-${version}.zip`)), false);
});
