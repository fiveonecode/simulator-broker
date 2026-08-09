import XCTest
@testable import SimulatorBrokerApp

final class BrokerReadModelTests: XCTestCase {
  func testEventDecodesActorIdFromPayload() throws {
    let event = try JSONDecoder().decode(BrokerEvent.self, from: Data("""
    {
      "actorType": "agent",
      "alias": "ui-1",
      "eventId": "event-actor",
      "jobId": null,
      "leaseId": "lease-1",
      "payload": {
        "actorId": "agent-alpha"
      },
      "projectId": "sample-project",
      "purposeId": "agent-ui-session",
      "timestamp": "2026-04-09T10:01:00Z",
      "type": "lease.acquired"
    }
    """.utf8))

    XCTAssertEqual(event.actorType, "agent")
    XCTAssertEqual(event.actorId, "agent-alpha")
  }

  func testBusySnapshotFilteringByHealthProjectAndSearch() throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let readModel = BrokerDashboardReadModel(snapshot: snapshot)

    let filtered = readModel.filteredSimulators(
      using: BrokerSimulatorFilters(
        actorType: BrokerDashboardReadModel.allSelection,
        health: .unhealthy,
        projectId: "sample-project",
        purposeId: BrokerDashboardReadModel.allSelection,
        searchText: "ui"
      )
    )

    XCTAssertEqual(filtered.map(\.alias), ["ui-2"])
    XCTAssertEqual(readModel.lease(for: "ui-1")?.actorId, "agent-local")
  }

  func testProjectSummaryCarriesPurposeCountsFromSnapshot() throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let readModel = BrokerDashboardReadModel(snapshot: snapshot)

    let project = try XCTUnwrap(readModel.project(projectId: "sample-project"))
    XCTAssertEqual(readModel.leaseReadyAliasCount, 0)
    XCTAssertEqual(project.activeLeaseCount, 2)
    XCTAssertEqual(project.pinnedAliasCount, 1)
    XCTAssertEqual(project.projectFilePath, "/tmp/sample-project/.simulator-broker/project.json")
    XCTAssertEqual(project.purposes.first?.displayName, "Agent UI Session")
  }

  func testEligiblePinPurposesRespectCapabilityAndRequires() throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let readModel = BrokerDashboardReadModel(snapshot: snapshot)
    let simulator = try XCTUnwrap(readModel.simulator(alias: "ui-1"))

    let purposes = readModel.eligiblePinPurposes(for: simulator, projectId: "sample-project")

    XCTAssertEqual(purposes.map(\.purposeId), ["agent-ui-session"])
  }

  func testSearchAndActorFiltersIncludePinnedAndDriftMetadata() throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let readModel = BrokerDashboardReadModel(snapshot: snapshot)

    let driftMatches = readModel.filteredSimulators(
      using: BrokerSimulatorFilters(
        actorType: BrokerDashboardReadModel.allSelection,
        health: .all,
        projectId: BrokerDashboardReadModel.allSelection,
        purposeId: BrokerDashboardReadModel.allSelection,
        searchText: "runtime mismatch"
      )
    )
    XCTAssertEqual(driftMatches.map(\.alias), ["ui-2"])

    let pinnedHumanMatches = readModel.filteredSimulators(
      using: BrokerSimulatorFilters(
        actorType: "human",
        health: .all,
        projectId: BrokerDashboardReadModel.allSelection,
        purposeId: BrokerDashboardReadModel.allSelection,
        searchText: ""
      )
    )
    XCTAssertEqual(pinnedHumanMatches.map(\.alias), ["manual-1"])
  }

  private func loadFixture(named name: String) throws -> BrokerAppSnapshot {
    let fixturesRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appending(path: "Fixtures")
    let data = try Data(contentsOf: fixturesRoot.appending(path: "\(name).json"))
    return try JSONDecoder().decode(BrokerAppSnapshot.self, from: data)
  }
}
