import Foundation

public enum NativeMessagingError: Error, LocalizedError {
    case invalidLength
    case invalidJSON
    case messageTooLarge
    case unexpectedEOF

    public var errorDescription: String? {
        switch self {
        case .invalidLength: return "Longitud de mensaje nativo inválida."
        case .invalidJSON: return "JSON nativo inválido."
        case .messageTooLarge: return "Mensaje nativo demasiado grande."
        case .unexpectedEOF: return "El canal nativo se cerró inesperadamente."
        }
    }
}

public final class NativeMessenger: @unchecked Sendable {
    public static let maximumMessageBytes = 1_048_576
    private let input: FileHandle
    private let output: FileHandle
    private let writeLock = NSLock()

    public init(input: FileHandle = .standardInput, output: FileHandle = .standardOutput) {
        self.input = input
        self.output = output
    }

    public func readMessage() throws -> [String: Any]? {
        guard let header = try readExactly(4, allowCleanEOF: true) else { return nil }
        let length = header.withUnsafeBytes { raw -> UInt32 in
            raw.loadUnaligned(as: UInt32.self).littleEndian
        }
        guard length > 0 else { throw NativeMessagingError.invalidLength }
        guard length <= Self.maximumMessageBytes else { throw NativeMessagingError.messageTooLarge }
        guard let payload = try readExactly(Int(length), allowCleanEOF: false) else { throw NativeMessagingError.unexpectedEOF }
        let object = try JSONSerialization.jsonObject(with: payload)
        guard let dictionary = object as? [String: Any] else { throw NativeMessagingError.invalidJSON }
        return dictionary
    }

    public func writeMessage(_ message: [String: Any]) throws {
        guard JSONSerialization.isValidJSONObject(message) else { throw NativeMessagingError.invalidJSON }
        let payload = try JSONSerialization.data(withJSONObject: message, options: [])
        guard payload.count <= Self.maximumMessageBytes else { throw NativeMessagingError.messageTooLarge }
        var length = UInt32(payload.count).littleEndian
        let header = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
        writeLock.lock()
        defer { writeLock.unlock() }
        try output.write(contentsOf: header)
        try output.write(contentsOf: payload)
    }

    private func readExactly(_ count: Int, allowCleanEOF: Bool) throws -> Data? {
        var data = Data()
        while data.count < count {
            let chunk = try input.read(upToCount: count - data.count) ?? Data()
            if chunk.isEmpty {
                if data.isEmpty && allowCleanEOF { return nil }
                throw NativeMessagingError.unexpectedEOF
            }
            data.append(chunk)
        }
        return data
    }
}
