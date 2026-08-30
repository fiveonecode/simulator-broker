import XCTest
@testable import SimulatorBrokerApp

@MainActor
final class SharedViewsTests: XCTestCase {
  func testTimestampDisplayAcceptsFractionalAndNonFractionalISO8601Values() throws {
    let nonFractional = try XCTUnwrap(timestampDisplay("2026-04-09T10:15:00Z"))
    let fractional = try XCTUnwrap(timestampDisplay("2026-04-09T10:15:00.000Z"))

    XCTAssertEqual(fractional, nonFractional)
  }

  func testTimestampDisplayReturnsNilForNilInput() {
    XCTAssertNil(timestampDisplay(nil))
  }

  func testTimestampDisplayPreservesMalformedInput() {
    XCTAssertEqual(timestampDisplay("not-a-timestamp"), "not-a-timestamp")
  }

  func testAutomaticShutdownValidInputGuidanceExplainsLeaseReleaseTiming() {
    XCTAssertEqual(
      AutomaticShutdownSection.validInputGuidance,
      "This grace period starts when a lease is released. Eligible automated simulators are shut down when it expires."
    )
  }
}
