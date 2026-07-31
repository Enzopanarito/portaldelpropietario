import Foundation
import VLAConnectorCore

@main
struct VLAWhatsAppHost {
    static func main() async {
        let messenger = NativeMessenger()
        do {
            let deviceID = try ConnectorSupport.deviceID()
            ConnectorSupport.writeState(["status":"Disponible","deviceId":deviceID,"version":ConnectorSupport.connectorVersion,"updatedAt":ISO8601DateFormatter().string(from:Date())])
            guard let command = try messenger.readMessage() else { return }
            let type = command["type"] as? String ?? ""
            if type == "health" {
                try messenger.writeMessage(ConnectorRunner(messenger: messenger, deviceID: deviceID).healthResponse())
                return
            }
            guard type == "dispatch" else {
                try messenger.writeMessage(["type":"dispatch_error","error":"Orden nativa no reconocida."])
                return
            }
            try await ConnectorRunner(messenger: messenger, deviceID: deviceID).runDispatch(command)
        } catch {
            let detail = ConnectorSupport.sanitize(error.localizedDescription, maximum: 500)
            ConnectorSupport.log("host_error", details: ["error":detail])
            ConnectorSupport.writeState(["status":"Error","error":detail,"updatedAt":ISO8601DateFormatter().string(from:Date())])
            try? messenger.writeMessage(["type":"dispatch_error","error":detail])
        }
    }
}
