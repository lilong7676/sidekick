// swift-tools-version:5.9
import PackageDescription

// No .xcodeproj on purpose: `swift build` works headless with the Command Line Tools,
// and the .app bundle is assembled by the Makefile.
let package = Package(
    name: "SidekickBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "SidekickBar",
            path: "Sources/SidekickBar",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("UserNotifications"),
                .linkedFramework("ServiceManagement"),
            ]
        )
    ]
)
