import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct ConnectorAPIError: Error, LocalizedError {
    public let statusCode: Int
    public let message: String
    public var errorDescription: String? { message }
}

public final class ConnectorAPI: @unchecked Sendable {
    private let endpoint: URL
    private let token: String
    private let session: URLSession

    public init(endpoint: URL, token: String, session: URLSession? = nil) throws {
        guard endpoint.absoluteString == ConnectorSupport.authorizedEndpoint else {
            throw ConnectorAPIError(statusCode: 0, message: "Endpoint no autorizado.")
        }
        guard token.count >= 80 && token.count <= 4096 && !token.contains("\n") else {
            throw ConnectorAPIError(statusCode: 0, message: "Token de despacho inválido.")
        }
        self.endpoint = endpoint
        self.token = token
        if let session { self.session = session }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 30
            configuration.timeoutIntervalForResource = 45
            configuration.httpCookieStorage = nil
            configuration.urlCache = nil
            self.session = URLSession(configuration: configuration)
        }
    }

    public func post(_ body: [String: Any]) async throws -> [String: Any] {
        guard JSONSerialization.isValidJSONObject(body) else {
            throw ConnectorAPIError(statusCode: 0, message: "Solicitud JSON inválida.")
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ConnectorAPIError(statusCode: 0, message: "Respuesta HTTP inválida.")
        }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(http.statusCode) else {
            let detail = object["detail"] as? String ?? object["message"] as? String ?? "El servidor respondió \(http.statusCode)."
            throw ConnectorAPIError(statusCode: http.statusCode, message: ConnectorSupport.sanitize(detail, maximum: 500))
        }
        return object
    }
}
