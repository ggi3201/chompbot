import XCTest
@testable import Chomp

final class PhotosToolsTests: XCTestCase {
    func testScalesTheLongestSideDown() {
        XCTAssertEqual(PhotosTools.fittedSize(width: 4032, height: 3024, maxDimension: 1568), CGSize(width: 1568, height: 1176))
        XCTAssertEqual(PhotosTools.fittedSize(width: 3024, height: 4032, maxDimension: 1568), CGSize(width: 1176, height: 1568))
    }

    func testNeverUpscales() {
        XCTAssertEqual(PhotosTools.fittedSize(width: 800, height: 600, maxDimension: 1568), CGSize(width: 800, height: 600))
    }
}
