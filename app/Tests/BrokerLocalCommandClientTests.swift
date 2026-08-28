import Foundation
import XCTest
@testable import SimulatorBrokerApp

final class BrokerLocalCommandClientTests: XCTestCase {
  func testProcessRunnerDrainsStderrWhileCommandProducesJSON() async throws {
    let tempRoot = try makeTempRoot()
    let scriptURL = tempRoot.appending(path: "large-stderr-command.sh")
    try [
      "#!/bin/sh",
      "/usr/bin/yes x | /usr/bin/head -c 200000 >&2",
      "printf '{\"ok\":true}\\n'",
      "",
    ].joined(separator: "\n").write(to: scriptURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)

    let envelope = try await withTimeout(seconds: 5) {
      try await ProcessBrokerLocalCommandRunner().run(cliPath: scriptURL, arguments: [])
    }

    XCTAssertEqual(envelope.ok, true)
  }

  func testProcessRunnerCancelsLongRunningCommand() async throws {
    let tempRoot = try makeTempRoot()
    let scriptURL = try writeLongRunningCommand(in: tempRoot)
    let pidURL = tempRoot.appending(path: "cancel-pid.txt")
    let markerURL = tempRoot.appending(path: "cancel-terminated.txt")

    let task = Task {
      try await ProcessBrokerLocalCommandRunner().run(cliPath: scriptURL, arguments: [
        pidURL.path,
        markerURL.path,
      ])
    }

    try await waitUntil {
      FileManager.default.fileExists(atPath: pidURL.path)
    }
    task.cancel()

    do {
      _ = try await withTimeout(seconds: 5) {
        try await task.value
      }
      XCTFail("Expected cancellation to throw.")
    } catch is CancellationError {
    }

    try await waitUntil {
      FileManager.default.fileExists(atPath: markerURL.path)
    }
  }

  func testProcessRunnerCancelsDescendantProcessGroup() async throws {
    let tempRoot = try makeTempRoot()
    let scriptURL = try writeCommandThatSpawnsLongRunningChild(in: tempRoot)
    let childPIDURL = tempRoot.appending(path: "child-pid.txt")
    let childMarkerURL = tempRoot.appending(path: "child-terminated.txt")
    let parentPIDURL = tempRoot.appending(path: "parent-pid.txt")

    let task = Task {
      try await ProcessBrokerLocalCommandRunner().run(cliPath: scriptURL, arguments: [
        childPIDURL.path,
        childMarkerURL.path,
        parentPIDURL.path,
      ])
    }

    try await waitUntil {
      FileManager.default.fileExists(atPath: childPIDURL.path)
    }
    task.cancel()

    do {
      _ = try await withTimeout(seconds: 5) {
        try await task.value
      }
      XCTFail("Expected cancellation to throw.")
    } catch is CancellationError {
    }

    try await waitUntil {
      FileManager.default.fileExists(atPath: childMarkerURL.path)
    }
  }

  func testSetupApplyCancellationAllowsCooperativeRollbackBeforeEscalation() async throws {
    let tempRoot = try makeTempRoot()
    let scriptURL = tempRoot.appending(path: "cooperative-setup-command.sh")
    let markerURL = tempRoot.appending(path: "rollback-complete.txt")
    let readyURL = tempRoot.appending(path: "setup-ready.txt")
    try [
      "#!/bin/sh",
      "set -eu",
      "marker_path=\"$5\"",
      "ready_path=\"$6\"",
      "trap 'sleep 2; printf rollback-complete > \"$marker_path\"; exit 0' TERM",
      "printf ready > \"$ready_path\"",
      "while true; do",
      "  sleep 1",
      "done",
      "",
    ].joined(separator: "\n").write(to: scriptURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)

    let task = Task {
      try await ProcessBrokerLocalCommandRunner().run(cliPath: scriptURL, arguments: [
        "setup", "--apply", "--confirm", "sha256:test", markerURL.path, readyURL.path,
      ])
    }
    try await waitUntil {
      FileManager.default.fileExists(atPath: readyURL.path)
    }
    task.cancel()

    do {
      _ = try await withTimeout(seconds: 5) {
        try await task.value
      }
      XCTFail("Expected cancellation to throw.")
    } catch is CancellationError {
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: markerURL.path))
  }

  func testSetupApplyTimeoutAllowsCooperativeRollbackBeforeEscalation() async throws {
    let tempRoot = try makeTempRoot()
    let scriptURL = tempRoot.appending(path: "cooperative-setup-timeout-command.sh")
    let markerURL = tempRoot.appending(path: "rollback-complete.txt")
    let readyURL = tempRoot.appending(path: "setup-ready.txt")
    try [
      "#!/bin/sh",
      "set -eu",
      "marker_path=\"$5\"",
      "ready_path=\"$6\"",
      "trap 'sleep 2; printf rollback-complete > \"$marker_path\"; exit 0' TERM",
      "printf ready > \"$ready_path\"",
      "while true; do",
      "  sleep 1",
      "done",
      "",
    ].joined(separator: "\n").write(to: scriptURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)

    do {
      _ = try await withTimeout(seconds: 5) {
        try await ProcessBrokerLocalCommandRunner(timeoutNanoseconds: 500_000_000).run(
          cliPath: scriptURL,
          arguments: [
            "setup", "--apply", "--confirm", "sha256:test", markerURL.path, readyURL.path,
          ]
        )
      }
      XCTFail("Expected timeout to throw.")
    } catch let BrokerCLICommandError.processTimedOut(url) {
      XCTAssertEqual(url, scriptURL)
    }

    try await waitUntil {
      FileManager.default.fileExists(atPath: markerURL.path)
    }
  }

  func testProcessRunnerTerminatesLongRunningCommandAfterTimeout() async throws {
    let tempRoot = try makeTempRoot()
    let scriptURL = try writeLongRunningCommand(in: tempRoot)
    let pidURL = tempRoot.appending(path: "timeout-pid.txt")
    let markerURL = tempRoot.appending(path: "timeout-terminated.txt")

    do {
      _ = try await withTimeout(seconds: 5) {
        try await ProcessBrokerLocalCommandRunner(timeoutNanoseconds: 500_000_000).run(
          cliPath: scriptURL,
          arguments: [
            pidURL.path,
            markerURL.path,
          ]
        )
      }
      XCTFail("Expected timeout to throw.")
    } catch let BrokerCLICommandError.processTimedOut(url) {
      XCTAssertEqual(url, scriptURL)
    }

    try await waitUntil {
      FileManager.default.fileExists(atPath: markerURL.path)
    }
  }

  func testProcessRunnerUsesCommandSpecificTimeoutBudgets() throws {
    let runner = ProcessBrokerLocalCommandRunner()

    XCTAssertEqual(
      runner.resolvedTimeoutNanoseconds(for: ["service", "start", "--host-config", "/tmp/host.json"]),
      1605 * 1_000_000_000
    )
    XCTAssertEqual(
      runner.resolvedTimeoutNanoseconds(for: ["host", "init", "--bootstrap-config"]),
      14325 * 1_000_000_000
    )
    XCTAssertEqual(
      runner.resolvedTimeoutNanoseconds(for: ["capacity", "check"]),
      925 * 1_000_000_000
    )
    XCTAssertEqual(
      runner.resolvedTimeoutNanoseconds(for: ["setup", "--json"]),
      600 * 1_000_000_000
    )
    XCTAssertEqual(
      runner.resolvedTimeoutNanoseconds(for: ["setup", "--apply", "--confirm", "sha256:test", "--json"]),
      10_765 * 1_000_000_000
    )
    XCTAssertEqual(
      runner.resolvedCancellationEscalationNanoseconds(for: ["setup", "--json"]),
      1 * 1_000_000_000
    )
    XCTAssertEqual(
      runner.resolvedCancellationEscalationNanoseconds(for: ["setup", "--apply", "--confirm", "sha256:test", "--json"]),
      1_620 * 1_000_000_000
    )
    let tempRoot = try makeTempRoot()
    let stateRoot = tempRoot.appending(path: "state")
    let hostConfigURL = tempRoot.appending(path: "host-config.json")
    try writeHostConfig(aliasCount: 8, to: hostConfigURL)
    XCTAssertEqual(
      runner.resolvedTimeoutNanoseconds(for: [
        "service",
        "start",
        "--host-config",
        hostConfigURL.path,
        "--state-root",
        stateRoot.path,
      ]),
      1845 * 1_000_000_000
    )
    let leasesURL = stateRoot.appending(path: "leases")
    try FileManager.default.createDirectory(at: leasesURL, withIntermediateDirectories: true)
    try """
    {"leaseId":"stale-containment-1","runtime":{"commandPid":4242}}
    """.write(to: leasesURL.appending(path: "stale-containment-1.json"), atomically: true, encoding: .utf8)
    XCTAssertEqual(
      runner.resolvedTimeoutNanoseconds(for: [
        "service",
        "start",
        "--host-config",
        hostConfigURL.path,
        "--state-root",
        stateRoot.path,
      ]),
      1926 * 1_000_000_000
    )
    XCTAssertEqual(
      runner.resolvedTimeoutNanoseconds(for: [
        "lease",
        "release",
        "--host-config",
        hostConfigURL.path,
        "--state-root",
        stateRoot.path,
      ]),
      2227 * 1_000_000_000
    )
    XCTAssertEqual(
      ProcessBrokerLocalCommandRunner(timeoutNanoseconds: 500_000_000)
        .resolvedTimeoutNanoseconds(for: ["host", "init", "--bootstrap-config"]),
      500_000_000
    )
  }

  func testSetupFailureMessageIncludesServiceLogAndDoctorIssues() throws {
    let envelope = try JSONDecoder().decode(BrokerCLICommandEnvelope.self, from: Data("""
    {
      "ok": false,
      "error": "Broker health verification failed after setup.",
      "failedStage": "health",
      "completedStages": ["preflight", "confirmation", "host"],
      "logPath": "/tmp/simbroker-state/brokerd.log",
      "rollbackFailureCount": 1,
      "doctorIssues": [
        {
          "alias": "ui-1",
          "health": "repair-needed",
          "reasonCode": "alias-unhealthy",
          "remediationCommands": [
            "simbroker host status --host-config '/tmp/host.json'",
            "simbroker simulators repair --alias ui-1 --host-config '/tmp/host.json'"
          ]
        }
      ],
      "recoveryCommand": "simbroker setup --host-config '/tmp/host.json'"
    }
    """.utf8))

    let message = envelope.failureDisplayMessage()
    XCTAssertTrue(message.contains("Failed stage: health."))
    XCTAssertTrue(message.contains("Completed: preflight, confirmation, host."))
    XCTAssertTrue(message.contains("Rollback cleanup was incomplete for 1 Simulator operation(s)."))
    XCTAssertTrue(message.contains("Service log: /tmp/simbroker-state/brokerd.log."))
    XCTAssertTrue(message.contains("Doctor issues: ui-1 (repair-needed); repair: simbroker host status --host-config '/tmp/host.json'; simbroker simulators repair --alias ui-1 --host-config '/tmp/host.json'."))
    XCTAssertTrue(message.contains("Recovery: simbroker setup --host-config '/tmp/host.json'"))
  }

  private func makeTempRoot() throws -> URL {
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "simbroker-command-client-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock {
      try? FileManager.default.removeItem(at: url)
    }
    return url
  }

  private func writeLongRunningCommand(in tempRoot: URL) throws -> URL {
    let scriptURL = tempRoot.appending(path: "long-running-command.sh")
    try [
      "#!/bin/sh",
      "set -eu",
      "pid_path=\"$1\"",
      "marker_path=\"$2\"",
      "",
      "trap 'printf terminated > \"$marker_path\"; exit 0' TERM",
      "printf '%s\\n' \"$$\" > \"$pid_path\"",
      "while true; do",
      "  sleep 1",
      "done",
      "",
    ].joined(separator: "\n").write(to: scriptURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)
    return scriptURL
  }

  private func writeCommandThatSpawnsLongRunningChild(in tempRoot: URL) throws -> URL {
    let childURL = tempRoot.appending(path: "long-running-child.sh")
    try [
      "#!/bin/sh",
      "set -eu",
      "pid_path=\"$1\"",
      "marker_path=\"$2\"",
      "",
      "trap 'printf child-terminated > \"$marker_path\"; exit 0' TERM",
      "printf '%s\\n' \"$$\" > \"$pid_path\"",
      "while true; do",
      "  sleep 1",
      "done",
      "",
    ].joined(separator: "\n").write(to: childURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: childURL.path)

    let parentURL = tempRoot.appending(path: "spawns-long-running-child.sh")
    try [
      "#!/bin/sh",
      "set -eu",
      "child_script=\"$(dirname \"$0\")/long-running-child.sh\"",
      "\"$child_script\" \"$1\" \"$2\" &",
      "child_pid=\"$!\"",
      "trap 'wait \"$child_pid\"; exit 0' TERM",
      "printf '%s\\n' \"$$\" > \"$3\"",
      "while true; do",
      "  sleep 1",
      "done",
      "",
    ].joined(separator: "\n").write(to: parentURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: parentURL.path)
    return parentURL
  }

  private func writeHostConfig(aliasCount: Int, to url: URL) throws {
    let aliases = (1 ... aliasCount)
      .map { index in
        """
        {"alias":"ui-\(index)","simulatorId":"SIM-\(index)"}
        """
      }
      .joined(separator: ",")
    try """
    {"version":1,"aliases":[\(aliases)]}
    """.write(to: url, atomically: true, encoding: .utf8)
  }

  private func waitUntil(
    timeoutNanoseconds: UInt64 = 2_000_000_000,
    intervalNanoseconds: UInt64 = 25_000_000,
    predicate: () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(Double(timeoutNanoseconds) / 1_000_000_000)
    while predicate() == false {
      if Date() >= deadline {
        throw TimeoutError()
      }
      try await Task.sleep(nanoseconds: intervalNanoseconds)
    }
  }

  private func withTimeout<T: Sendable>(
    seconds: UInt64,
    operation: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask {
        try await operation()
      }
      group.addTask {
        try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
        throw TimeoutError()
      }
      guard let result = try await group.next() else {
        throw TimeoutError()
      }
      group.cancelAll()
      return result
    }
  }

  private struct TimeoutError: Error {}
}
