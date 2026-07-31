import Foundation

public enum ConnectorSupport {
    public static let productName = "Villas Los Apamates/WhatsApp Connector"
    public static let protocolVersion = 1
    public static let connectorVersion = "1.0.0"
    public static let authorizedEndpoint = "https://villalosapamates.netlify.app/.netlify/functions/messaging-connector"

    public static var rootDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
            .appendingPathComponent(productName, isDirectory: true)
    }
    public static var logsDirectory: URL { rootDirectory.appendingPathComponent("Logs", isDirectory: true) }
    public static var stateURL: URL { rootDirectory.appendingPathComponent("state.json") }
    public static var deviceIDURL: URL { rootDirectory.appendingPathComponent("device-id") }
    public static var logURL: URL { logsDirectory.appendingPathComponent("connector.log") }

    public static func prepareDirectories() throws {
        try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    }

    public static func deviceID() throws -> String {
        try prepareDirectories()
        if let value = try? String(contentsOf: deviceIDURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           value.range(of: #"^[A-Za-z0-9._-]{3,100}$"#, options: .regularExpression) != nil {
            return value
        }
        let value = "mac-" + UUID().uuidString.lowercased()
        try value.write(to: deviceIDURL, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: deviceIDURL.path)
        return value
    }

    public static func writeState(_ state: [String: Any]) {
        do {
            try prepareDirectories()
            guard JSONSerialization.isValidJSONObject(state) else { return }
            let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: stateURL, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
        } catch { }
    }

    public static func log(_ event: String, details: [String: Any] = [:]) {
        do {
            try prepareDirectories()
            let safeDetails = details.reduce(into: [String: String]()) { output, pair in
                let key = sanitize(pair.key, maximum: 60)
                guard !key.isEmpty else { return }
                output[key] = sanitize(String(describing: pair.value), maximum: 300)
            }
            let encoded = (try? JSONSerialization.data(withJSONObject: safeDetails, options: [.sortedKeys]))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            let line = "\(ISO8601DateFormatter().string(from: Date())) \(sanitize(event, maximum: 80)) \(encoded)\n"
            let data = Data(line.utf8)
            if FileManager.default.fileExists(atPath: logURL.path) {
                let handle = try FileHandle(forWritingTo: logURL)
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
                try handle.close()
            } else {
                try data.write(to: logURL, options: .atomic)
            }
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
        } catch { }
    }

    public static func sanitize(_ value: String, maximum: Int) -> String {
        let scalars = value.unicodeScalars.filter { scalar in
            scalar.value == 10 || scalar.value >= 32
        }
        return String(String.UnicodeScalarView(scalars)).replacingOccurrences(of: "\n", with: " ").prefix(maximum).description
    }
}
