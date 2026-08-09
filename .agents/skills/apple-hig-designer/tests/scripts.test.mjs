import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(".");

function runScript(scriptPath, args, input = "") {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input,
  });
}

function generateComponent({
  componentName,
  componentOption,
  features = "",
  frameworkOption = "1",
  outputDir,
}) {
  return runScript(
    ".agents/skills/apple-hig-designer/scripts/generate_ios_component.sh",
    [],
    `${frameworkOption}\n${componentOption}\n${componentName}\n${features}\n1\n${outputDir}\n`,
  );
}

test("component generator defines functions before dispatching", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-generator-"));
  try {
    const outputDir = path.join(tempRoot, "Components");
    const result = generateComponent({
      componentName: "SampleButton",
      componentOption: "1",
      features: "accessibility",
      outputDir,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.includes("command not found"), false);
    const generated = fs.readFileSync(path.join(outputDir, "SampleButton.swift"), "utf8");
    assert.match(generated, /struct SampleButton: View/);
    assert.match(generated, /\.accessibilityLabel/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("SwiftUI generator previews satisfy required stored properties", () => {
  const cases = [
    {
      componentName: "PreviewButton",
      componentOption: "1",
      pattern: /PreviewButton\(title: "Continue"\) \{/,
    },
    {
      componentName: "PreviewList",
      componentOption: "2",
      pattern: /PreviewList\(items: \["First", "Second", "Third"\]\)/,
    },
    {
      componentName: "PreviewCard",
      componentOption: "3",
      pattern: /PreviewCard\(\n\s+title: "Card Title",\n\s+description: "Supporting card description\."/,
    },
  ];

  for (const testCase of cases) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-preview-"));
    try {
      const outputDir = path.join(tempRoot, "Components");
      const result = generateComponent({
        componentName: testCase.componentName,
        componentOption: testCase.componentOption,
        outputDir,
      });

      assert.equal(result.status, 0, result.stderr);
      const generated = fs.readFileSync(path.join(outputDir, `${testCase.componentName}.swift`), "utf8");
      assert.match(generated, testCase.pattern);
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  }
});

test("UIKit list generator emits required table view conformances", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-uikit-list-"));
  try {
    const outputDir = path.join(tempRoot, "Components");
    const result = generateComponent({
      componentName: "GeneratedListView",
      componentOption: "2",
      frameworkOption: "2",
      outputDir,
    });

    assert.equal(result.status, 0, result.stderr);
    const generated = fs.readFileSync(path.join(outputDir, "GeneratedListView.swift"), "utf8");
    assert.match(generated, /extension GeneratedListView: UITableViewDataSource, UITableViewDelegate/);
    assert.match(generated, /numberOfRowsInSection/);
    assert.match(generated, /cellForRowAt/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("component generator rejects path-like component names", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-generator-path-"));
  try {
    const outputDir = path.join(tempRoot, "Components");
    const siblingFile = path.join(tempRoot, "ContentView.swift");
    fs.writeFileSync(siblingFile, "original sibling\n");

    const result = generateComponent({
      componentName: "../ContentView",
      componentOption: "1",
      outputDir,
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Component name must be a Swift type identifier/);
    assert.equal(fs.existsSync(outputDir), false);
    assert.equal(fs.readFileSync(siblingFile, "utf8"), "original sibling\n");
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("design validation runs navigation checks for directory targets", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-validation-"));
  try {
    fs.writeFileSync(path.join(tempRoot, "BrokenNavigation.swift"), [
      "import SwiftUI",
      "struct BrokenNavigation: View {",
      "    var body: some View {",
      "        NavigationStack { Text(\"Details\") }",
      "    }",
      "}",
      "",
    ].join("\n"));

    const result = runScript(".agents/skills/apple-hig-designer/scripts/validate_design.sh", [tempRoot]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /NavigationStack missing \.navigationTitle/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("design validation counts zero legacy tab items without exiting early", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-tabs-"));
  try {
    const swiftFile = path.join(tempRoot, "ModernTabs.swift");
    fs.writeFileSync(swiftFile, [
      "import SwiftUI",
      "struct ModernTabs: View {",
      "    var body: some View {",
      "        TabView {",
      "            Tab(\"Home\", systemImage: \"house\") { Text(\"Home\") }",
      "        }",
      "    }",
      "}",
      "",
    ].join("\n"));

    const result = runScript(".agents/skills/apple-hig-designer/scripts/validate_design.sh", [swiftFile]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Consider if TabView is appropriate for 0 tabs/);
    assert.match(result.stdout, /Validation Summary/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("accessibility audit fails when no Swift files are inspected", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-accessibility-"));
  try {
    const emptyDir = path.join(tempRoot, "Empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    const result = runScript(".agents/skills/apple-hig-designer/scripts/audit_accessibility.sh", [emptyDir]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /No Swift files found/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("accessibility audit requires each SF Symbol image to have its own label", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-accessibility-images-"));
  try {
    const swiftFile = path.join(tempRoot, "Toolbar.swift");
    fs.writeFileSync(swiftFile, [
      "import SwiftUI",
      "struct ToolbarView: View {",
      "    var body: some View {",
      "        HStack {",
      "            Image(systemName: \"square.and.arrow.up\")",
      "            Image(systemName: \"trash\")",
      "                .accessibilityLabel(\"Delete\")",
      "        }",
      "        Text(\"Actions\")",
      "            .font(.body)",
      "    }",
      "}",
      "",
    ].join("\n"));

    const result = runScript(".agents/skills/apple-hig-designer/scripts/audit_accessibility.sh", [swiftFile]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /1 image\(s\) missing accessibility labels/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("accessibility audit does not count unrelated later labels for a system image", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-accessibility-image-chain-"));
  try {
    const swiftFile = path.join(tempRoot, "Footer.swift");
    fs.writeFileSync(swiftFile, [
      "import SwiftUI",
      "struct FooterView: View {",
      "    var body: some View {",
      "        VStack {",
      "            Image(systemName: \"info.circle\")",
      "        }",
      "        Text(\"Details\")",
      "            .accessibilityLabel(\"More details\")",
      "            .font(.body)",
      "    }",
      "}",
      "",
    ].join("\n"));

    const result = runScript(".agents/skills/apple-hig-designer/scripts/audit_accessibility.sh", [swiftFile]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /1 image\(s\) missing accessibility labels/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("accessibility audit checks touch targets per interactive control", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-accessibility-touch-"));
  try {
    const swiftFile = path.join(tempRoot, "Actions.swift");
    fs.writeFileSync(swiftFile, [
      "import SwiftUI",
      "struct ActionsView: View {",
      "    var body: some View {",
      "        VStack {",
      "            Button(\"Tiny\") { }",
      "            Text(\"Spacer\")",
      "                .frame(height: 44)",
      "            Button(\"Large\") { }",
      "                .frame(minWidth: 44, minHeight: 44)",
      "        }",
      "        .font(.body)",
      "    }",
      "}",
      "",
    ].join("\n"));

    const result = runScript(".agents/skills/apple-hig-designer/scripts/audit_accessibility.sh", [swiftFile]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /1 interactive control\(s\) may have too-small touch targets/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("accessibility audit requires both touch target dimensions", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-accessibility-touch-dimensions-"));
  try {
    const swiftFile = path.join(tempRoot, "NarrowAction.swift");
    fs.writeFileSync(swiftFile, [
      "import SwiftUI",
      "struct NarrowActionView: View {",
      "    var body: some View {",
      "        Button(\"Narrow\") { }",
      "            .frame(width: 8, height: 44)",
      "            .contentShape(Rectangle())",
      "    }",
      "}",
      "",
    ].join("\n"));

    const result = runScript(".agents/skills/apple-hig-designer/scripts/audit_accessibility.sh", [swiftFile]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /1 interactive control\(s\) may have too-small touch targets/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("accessibility audit checks trailing-closure interactive controls", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-accessibility-touch-trailing-"));
  try {
    const swiftFile = path.join(tempRoot, "TrailingActions.swift");
    fs.writeFileSync(swiftFile, [
      "import SwiftUI",
      "struct TrailingActionsView: View {",
      "    var body: some View {",
      "        VStack {",
      "            Button {",
      "                print(\"tap\")",
      "            } label: {",
      "                Text(\"Tiny\")",
      "            }",
      "            Text(\"Tap target\")",
      "                .onTapGesture {",
      "                    print(\"tap\")",
      "                }",
      "        }",
      "    }",
      "}",
      "",
    ].join("\n"));

    const result = runScript(".agents/skills/apple-hig-designer/scripts/audit_accessibility.sh", [swiftFile]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /2 interactive control\(s\) may have too-small touch targets/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("accessibility audit accepts framed trailing-closure gesture chains", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-hig-accessibility-touch-framed-trailing-"));
  try {
    const swiftFile = path.join(tempRoot, "FramedTrailingAction.swift");
    fs.writeFileSync(swiftFile, [
      "import SwiftUI",
      "struct FramedTrailingActionView: View {",
      "    var body: some View {",
      "        Text(\"Tap target\")",
      "            .frame(minWidth: 44, minHeight: 44)",
      "            .onTapGesture {",
      "                print(\"tap\")",
      "            }",
      "            .font(.body)",
      "    }",
      "}",
      "",
    ].join("\n"));

    const result = runScript(".agents/skills/apple-hig-designer/scripts/audit_accessibility.sh", [swiftFile]);

    assert.equal(result.status, 0);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});
