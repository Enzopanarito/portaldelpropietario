import XCTest
@testable import VLAConnectorCore

final class CoreTests: XCTestCase {
    func testSanitizeRemovesLineBreaksAndLimitsLength() {
        XCTAssertEqual(ConnectorSupport.sanitize("hola\nmundo", maximum: 20), "hola mundo")
        XCTAssertEqual(ConnectorSupport.sanitize(String(repeating: "a", count: 50), maximum: 10).count, 10)
    }

    func testAuthorizedEndpointIsFixed() {
        XCTAssertEqual(ConnectorSupport.authorizedEndpoint, "https://villalosapamates.netlify.app/.netlify/functions/messaging-connector")
    }
}
