// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VLAWhatsAppConnector",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "VLAConnectorCore", targets: ["VLAConnectorCore"]),
        .executable(name: "VLAWhatsAppHost", targets: ["VLAWhatsAppHost"]),
        .executable(name: "VLAWhatsAppMenu", targets: ["VLAWhatsAppMenu"])
    ],
    targets: [
        .target(name: "VLAConnectorCore"),
        .executableTarget(name: "VLAWhatsAppHost", dependencies: ["VLAConnectorCore"]),
        .executableTarget(name: "VLAWhatsAppMenu", dependencies: ["VLAConnectorCore"]),
        .testTarget(name: "VLAConnectorCoreTests", dependencies: ["VLAConnectorCore"])
    ]
)
