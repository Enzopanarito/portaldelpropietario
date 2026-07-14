import Foundation

public final class ConnectorRunner {
    private let messenger: NativeMessenger
    private let deviceID: String
    private var cancelled = false

    public init(messenger: NativeMessenger, deviceID: String) {
        self.messenger = messenger
        self.deviceID = deviceID
    }

    public func healthResponse() -> [String: Any] {
        [
            "type": "health_result",
            "ok": true,
            "protocol": ConnectorSupport.protocolVersion,
            "version": ConnectorSupport.connectorVersion,
            "deviceId": deviceID,
            "platform": "macOS"
        ]
    }

    public func runDispatch(_ command: [String: Any]) async throws {
        guard (command["protocol"] as? NSNumber)?.intValue == ConnectorSupport.protocolVersion else {
            throw ConnectorAPIError(statusCode: 0, message: "Versión de protocolo incompatible.")
        }
        guard let endpointText = command["endpoint"] as? String,
              let endpoint = URL(string: endpointText),
              let jobID = command["jobId"] as? String,
              let token = command["dispatchToken"] as? String,
              let mode = command["mode"] as? String,
              ["Simulación", "Envío real"].contains(mode) else {
            throw ConnectorAPIError(statusCode: 0, message: "Orden de despacho incompleta.")
        }
        let api = try ConnectorAPI(endpoint: endpoint, token: token)
        ConnectorSupport.log("dispatch_started", details: ["jobId": jobID, "mode": mode, "deviceId": deviceID])
        ConnectorSupport.writeState(["status":"Ocupado","jobId":jobID,"mode":mode,"updatedAt":ISO8601DateFormatter().string(from:Date())])

        _ = try await api.post(["action":"health","jobId":jobID])
        let claim = try await api.post(["action":"claim","jobId":jobID,"deviceId":deviceID])
        guard let leaseToken = claim["leaseToken"] as? String else {
            throw ConnectorAPIError(statusCode: 0, message: "El servidor no entregó una reserva.")
        }
        try sendProgress(["stage":"claimed"])

        while !cancelled {
            let next = try await api.post(["action":"next","jobId":jobID,"deviceId":deviceID,"leaseToken":leaseToken])
            guard let message = next["message"] as? [String: Any] else { break }
            guard let messageID = message["messageId"] as? String,
                  let attemptID = message["attemptId"] as? String,
                  let house = (message["house"] as? NSNumber)?.intValue,
                  let phone = message["phone"] as? String,
                  let text = message["text"] as? String,
                  let messageHash = message["messageHash"] as? String else {
                throw ConnectorAPIError(statusCode: 0, message: "El servidor entregó un mensaje incompleto.")
            }
            try sendProgress(["stage":"preparing","house":house])

            if mode == "Simulación" {
                _ = try await transition(api: api, jobID: jobID, leaseToken: leaseToken, messageID: messageID, attemptID: attemptID, outcome: "sending")
                _ = try await transition(api: api, jobID: jobID, leaseToken: leaseToken, messageID: messageID, attemptID: attemptID, outcome: "sent", evidence: ["simulated":true])
                try sendProgress(["stage":"simulated","house":house])
                continue
            }

            let prepareResult = try requestExtension(type: "prepare_message", payload: [
                "attemptId":attemptID,"house":house,"phone":phone,"text":text,"messageHash":messageHash
            ])
            guard prepareResult["ok"] as? Bool == true else {
                let detail = prepareResult["error"] as? String ?? "WhatsApp no pudo preparar el mensaje."
                _ = try await transition(api: api, jobID: jobID, leaseToken: leaseToken, messageID: messageID, attemptID: attemptID, outcome: "failed", errorCode: "PREPARE_FAILED", errorDetail: detail)
                try sendProgress(["stage":"failed","house":house])
                continue
            }

            _ = try await transition(api: api, jobID: jobID, leaseToken: leaseToken, messageID: messageID, attemptID: attemptID, outcome: "sending")
            let commitResult = try requestExtension(type: "commit_message", payload: ["attemptId":attemptID,"house":house])
            let browserResult = commitResult["result"] as? [String: Any] ?? [:]
            if commitResult["ok"] as? Bool == true, browserResult["status"] as? String == "sent" {
                let evidence = browserResult["evidence"] as? [String: Any] ?? [:]
                _ = try await transition(api: api, jobID: jobID, leaseToken: leaseToken, messageID: messageID, attemptID: attemptID, outcome: "sent", evidence: evidence)
                try sendProgress(["stage":"sent","house":house])
            } else {
                let evidence = browserResult["evidence"] as? [String: Any] ?? [:]
                let code = browserResult["errorCode"] as? String ?? "SEND_CONFIRMATION_UNCERTAIN"
                let detail = browserResult["error"] as? String ?? commitResult["error"] as? String ?? "No fue posible confirmar el resultado."
                _ = try await transition(api: api, jobID: jobID, leaseToken: leaseToken, messageID: messageID, attemptID: attemptID, outcome: "verify", evidence: evidence, errorCode: code, errorDetail: detail)
                try sendProgress(["stage":"verify","house":house])
            }
        }

        if !cancelled {
            _ = try await api.post(["action":"release","jobId":jobID,"deviceId":deviceID,"leaseToken":leaseToken])
        }
        let result: [String: Any] = ["cancelled":cancelled,"jobId":jobID]
        try messenger.writeMessage(["type":"dispatch_complete","result":result])
        ConnectorSupport.log("dispatch_finished", details: ["jobId":jobID,"cancelled":cancelled])
        ConnectorSupport.writeState(["status":cancelled ? "Cancelado localmente" : "Disponible","jobId":jobID,"updatedAt":ISO8601DateFormatter().string(from:Date())])
    }

    private func transition(api: ConnectorAPI, jobID: String, leaseToken: String, messageID: String, attemptID: String, outcome: String, evidence: [String: Any] = [:], errorCode: String? = nil, errorDetail: String? = nil) async throws -> [String: Any] {
        var body: [String: Any] = ["action":"transition","jobId":jobID,"deviceId":deviceID,"leaseToken":leaseToken,"messageId":messageID,"attemptId":attemptID,"outcome":outcome,"evidence":evidence]
        if let errorCode { body["errorCode"] = errorCode }
        if let errorDetail { body["errorDetail"] = ConnectorSupport.sanitize(errorDetail, maximum: 500) }
        return try await api.post(body)
    }

    private func requestExtension(type: String, payload: [String: Any]) throws -> [String: Any] {
        let requestID = UUID().uuidString.lowercased()
        var request = payload
        request["type"] = type
        request["requestId"] = requestID
        try messenger.writeMessage(request)
        while let response = try messenger.readMessage() {
            if response["type"] as? String == "cancel_local" {
                cancelled = true
                continue
            }
            if response["requestId"] as? String == requestID { return response }
        }
        throw NativeMessagingError.unexpectedEOF
    }

    private func sendProgress(_ payload: [String: Any]) throws {
        try messenger.writeMessage(["type":"progress","payload":payload])
    }
}
