// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "QuantumWatcherMenubar",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "QuantumWatcherMenubar", targets: ["QuantumWatcherMenubar"])
    ],
    targets: [
        .executableTarget(
            name: "QuantumWatcherMenubar",
            path: "Sources/QuantumWatcherMenubar",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency")
            ]
        ),
        .testTarget(
            name: "QuantumWatcherMenubarTests",
            dependencies: ["QuantumWatcherMenubar"],
            path: "Tests/QuantumWatcherMenubarTests"
        )
    ]
)
