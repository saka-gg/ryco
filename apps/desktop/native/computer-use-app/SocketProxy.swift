import Darwin
import Foundation

/// Relays connections from Ryco to the Cua driver it started. The driver trusts host-only requests
/// only from its parent process, which is this helper; the proxy admits only Ryco's pid.
final class SocketProxy {
    let publicPath: String
    let privatePath: String
    private let hostPid: pid_t
    private let lock = NSLock()
    private var stopped = false

    init(publicPath: String, hostPid: pid_t) {
        self.publicPath = publicPath
        self.hostPid = hostPid
        let directory = (publicPath as NSString).deletingLastPathComponent
        let suffix = String(format: "%08x", arc4random())
        privatePath = (directory as NSString).appendingPathComponent("h-\(suffix).sock")
    }

    func start() throws {
        let fd = try UnixSocket.listen(path: publicPath)
        let thread = Thread { self.acceptLoop(fd) }
        thread.name = "ryco-computer-use.proxy"
        thread.start()
    }

    private var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    /// The accept thread owns the listener: it polls so `stop()` never closes a descriptor another
    /// thread is blocked on.
    private func acceptLoop(_ listener: Int32) {
        defer { Darwin.close(listener) }
        while !isStopped {
            var descriptor = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, 250)
            if ready < 0, errno != EINTR { return }
            guard ready > 0, !isStopped, let client = UnixSocket.accept(listener) else { continue }
            guard UnixSocket.peerPid(client) == hostPid,
                  let driver = try? UnixSocket.connect(path: privatePath) else {
                Darwin.close(client)
                continue
            }
            relay(client, driver)
        }
    }

    private func relay(_ client: Int32, _ driver: Int32) {
        let group = DispatchGroup()
        for (source, target) in [(client, driver), (driver, client)] {
            group.enter()
            let thread = Thread {
                SocketProxy.pump(from: source, to: target)
                group.leave()
            }
            thread.name = "ryco-computer-use.relay"
            thread.start()
        }
        group.notify(queue: .global()) {
            Darwin.close(client)
            Darwin.close(driver)
        }
    }

    /// Copies until end of stream, then half-closes the other side so request/response framing and
    /// the driver's EOF-based teardown both survive the relay.
    private static func pump(from source: Int32, to target: Int32) {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(source, $0.baseAddress, $0.count) }
            if count < 0, errno == EINTR { continue }
            if count <= 0 { break }
            if !UnixSocket.writeAll(target, Data(buffer[0..<count])) {
                _ = Darwin.shutdown(source, SHUT_RD)
                break
            }
        }
        _ = Darwin.shutdown(target, SHUT_WR)
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        stopped = true
        unlink(publicPath)
        unlink(privatePath)
    }
}
