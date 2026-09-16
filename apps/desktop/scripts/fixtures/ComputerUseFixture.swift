import AppKit

final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var otherWindow: NSWindow!
    var activeApps = Set<Int32>()
    var monitor: Timer?
    let field = NSTextField(frame: NSRect(x: 30, y: 130, width: 300, height: 28))
    let status = NSTextField(labelWithString: "Waiting")
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 460, height: 260), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Ryco automation fixture"
        field.placeholderString = "Sample name"
        field.setAccessibilityLabel("Sample name")
        window.contentView!.addSubview(field)
        let button = NSButton(title: "Save sample", target: self, action: #selector(save))
        button.frame = NSRect(x: 30, y: 78, width: 150, height: 34)
        window.contentView!.addSubview(button)
        status.frame = NSRect(x: 30, y: 30, width: 380, height: 24)
        window.contentView!.addSubview(status)
        otherWindow = NSWindow(contentRect: NSRect(x: 680, y: 180, width: 360, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        otherWindow.title = "Ryco alternate fixture"
        otherWindow.orderBack(nil)
        window.makeKey()
        window.makeFirstResponder(field)
        window.orderFront(nil)
        if CommandLine.arguments.count > 1 {
            let path = CommandLine.arguments[1]
            monitor = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [self] _ in
                if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier { activeApps.insert(pid) }
                let point = NSEvent.mouseLocation
                let report: [String: Any] = ["activeApps": Array(activeApps), "mouseX": point.x, "mouseY": point.y]
                if let data = try? JSONSerialization.data(withJSONObject: report) {
                    try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
                }
            }
        }
    }
    @objc func save() { status.stringValue = "Saved " + field.stringValue }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
let delegate = Fixture()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
