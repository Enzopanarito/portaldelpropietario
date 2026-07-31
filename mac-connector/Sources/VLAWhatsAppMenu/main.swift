#if canImport(AppKit)
import AppKit
import Foundation
import VLAConnectorCore

final class MenuDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "VLA ✓"
        rebuildMenu()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refreshState() }
        refreshState()
    }

    private func rebuildMenu(state: String = "Disponible") {
        let menu = NSMenu()
        let status = NSMenuItem(title: "Estado: \(state)", action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Abrir Portal Administrativo", action: #selector(openPortal), keyEquivalent: "p").target = self
        menu.addItem(withTitle: "Abrir WhatsApp Web", action: #selector(openWhatsApp), keyEquivalent: "w").target = self
        menu.addItem(withTitle: "Ver registro", action: #selector(openLogs), keyEquivalent: "l").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Salir", action: #selector(quit), keyEquivalent: "q").target = self
        statusItem.menu = menu
    }

    private func refreshState() {
        guard let data = try? Data(contentsOf: ConnectorSupport.stateURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            statusItem.button?.title = "VLA ?"
            rebuildMenu(state: "Sin estado")
            return
        }
        let state = object["status"] as? String ?? "Desconocido"
        statusItem.button?.title = state == "Disponible" ? "VLA ✓" : state == "Ocupado" ? "VLA …" : "VLA !"
        rebuildMenu(state: state)
    }

    @objc private func openPortal() { NSWorkspace.shared.open(URL(string: "https://villalosapamates.netlify.app/admin.html")!) }
    @objc private func openWhatsApp() { NSWorkspace.shared.open(URL(string: "https://web.whatsapp.com")!) }
    @objc private func openLogs() {
        try? ConnectorSupport.prepareDirectories()
        NSWorkspace.shared.activateFileViewerSelecting([ConnectorSupport.logURL])
    }
    @objc private func quit() { NSApplication.shared.terminate(nil) }
}

let application = NSApplication.shared
let delegate = MenuDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
#else
import Foundation
print("VLAWhatsAppMenu requiere macOS.")
#endif
