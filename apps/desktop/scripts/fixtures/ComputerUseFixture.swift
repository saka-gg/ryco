import AppKit

final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
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
        window.orderFront(nil)
    }
    @objc func save() { status.stringValue = "Saved " + field.stringValue }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
let delegate = Fixture()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
