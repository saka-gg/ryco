import AppKit
import Darwin
import Foundation

// Ryco Computer Use: the app macOS gives Computer Use's privacy grants to. Ryco starts it through
// LaunchServices, so it is its own responsible process, and it starts the Cua driver and Ryco's
// Swift helpers as its children, so they use its grants. The design is in
// docs/superpowers/specs/2026-11-07-computer-use-helper-app.md.

/// Must equal COMPUTER_USE_HELPER_PROTOCOL in packages/shared/src/computerUseHelperApp.ts.
let helperProtocol = 1

final class BrokerSession {
    private let control: Int32
    private let brokerPath: String
    private let hostPid: pid_t
    private let policy: TargetPolicy
    private let writeLock = NSLock()
    private let childrenLock = NSLock()
    private var children: [String: ChildRecord] = [:]
    private var ending = false

    init(control: Int32, brokerPath: String, hostPid: pid_t, policy: TargetPolicy) {
        self.control = control
        self.brokerPath = brokerPath
        self.hostPid = hostPid
        self.policy = policy
    }

    func send(_ message: [String: Any]) {
        writeLock.lock()
        defer { writeLock.unlock() }
        UnixSocket.writeAll(control, jsonLine(message))
    }

    /// Serves Ryco's requests until the control connection closes, then ends every child.
    func run(reader: LineReader) {
        watchHost()
        while let line = reader.next() {
            guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
                  let type = message["type"] as? String else { continue }
            switch type {
            case "spawn":
                guard let request = SpawnRequest(message) else {
                    if let id = message["id"] as? String {
                        send(["type": "spawn-failed", "id": id, "message": "Invalid spawn request."])
                    }
                    continue
                }
                DispatchQueue.global(qos: .userInitiated).async { self.spawn(request) }
            case "kill":
                guard let id = message["id"] as? String, let signal = message["signal"] as? Int,
                      signal > 0, signal < 32 else { continue }
                childrenLock.lock()
                let child = children[id]
                childrenLock.unlock()
                child?.signal(Int32(signal))
            case "shutdown":
                end()
            default:
                continue
            }
        }
        end()
    }

    private func spawn(_ request: SpawnRequest) {
        do {
            let child = try ChildSpawner.spawn(request, policy: policy, brokerPath: brokerPath, hostPid: hostPid)
            childrenLock.lock()
            if ending {
                // Shutdown already took its snapshot: this child must not outlive the helper.
                childrenLock.unlock()
                child.signal(SIGKILL)
                child.proxy?.stop()
                return
            }
            children[child.id] = child
            childrenLock.unlock()
            send(["type": "spawned", "id": child.id, "pid": Int(child.pid)])
            let waiter = Thread { self.wait(for: child) }
            waiter.name = "ryco-computer-use.wait"
            waiter.start()
        } catch {
            send(["type": "spawn-failed", "id": request.id, "message": "\(error)"])
        }
    }

    private func wait(for child: ChildRecord) {
        var status: Int32 = 0
        var result: pid_t
        repeat { result = waitpid(child.pid, &status, 0) } while result < 0 && errno == EINTR
        child.markReaped()
        childrenLock.lock()
        children.removeValue(forKey: child.id)
        childrenLock.unlock()
        // WIFEXITED / WTERMSIG, spelled out: the C macros are not imported.
        let signal = status & 0x7f
        var message: [String: Any] = ["type": "exit", "id": child.id]
        if result == child.pid, signal == 0 {
            message["code"] = Int((status >> 8) & 0xff)
        } else {
            message["signal"] = Int(result == child.pid ? signal : SIGKILL)
        }
        send(message)
    }

    /// The control socket closes when Ryco exits, even on SIGKILL. The pid check is a backstop.
    private func watchHost() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [hostPid] in
            if Darwin.kill(hostPid, 0) != 0, errno == ESRCH { self.end() }
        }
        timer.resume()
        hostWatch = timer
    }

    private var hostWatch: DispatchSourceTimer?

    /// SIGTERM every child, SIGKILL whatever is left after a second, then exit.
    func end() {
        childrenLock.lock()
        if ending {
            childrenLock.unlock()
            return
        }
        ending = true
        let live = Array(children.values)
        childrenLock.unlock()
        for child in live { child.signal(SIGTERM) }
        let deadline = Date().addingTimeInterval(1)
        while Date() < deadline, live.contains(where: { $0.isRunning }) { usleep(20_000) }
        for child in live where child.isRunning {
            child.signal(SIGKILL)
            child.proxy?.stop()
        }
        exit(EXIT_SUCCESS)
    }
}

/// Reads the one-time token Ryco left for this launch and deletes it. Only a regular file owned by
/// this user and private to it is accepted.
func takeToken(directory: String) -> String? {
    let path = (directory as NSString).appendingPathComponent("token")
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer {
        Darwin.close(fd)
        unlink(path)
    }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
          (info.st_mode & 0o077) == 0, info.st_size > 0, info.st_size <= 512 else { return nil }
    var buffer = [UInt8](repeating: 0, count: Int(info.st_size))
    let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
    guard count == Int(info.st_size) else { return nil }
    let token = String(decoding: buffer, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return token.isEmpty ? nil : token
}

func connectToBroker(directory: String) -> BrokerSession? {
    guard let token = takeToken(directory: directory) else { return nil }
    let brokerPath = (directory as NSString).appendingPathComponent("broker.sock")
    var control: Int32 = -1
    let deadline = Date().addingTimeInterval(10)
    while control < 0, Date() < deadline {
        if let fd = try? UnixSocket.connect(path: brokerPath) { control = fd } else { usleep(50_000) }
    }
    guard control >= 0 else { return nil }
    // Ryco, not just anyone with a socket and a token file, must be on the other end.
    guard let hostPath = HostVerification.expectedHostPath(),
          HostVerification.peerIsHost(control, expectedPath: hostPath),
          let peerPid = UnixSocket.peerPid(control) else {
        Darwin.close(control)
        return nil
    }
    let info = Bundle.main.infoDictionary ?? [:]
    let hello: [String: Any] = [
        "type": "hello",
        "protocol": helperProtocol,
        "token": token,
        "pid": Int(getpid()),
        "version": info["CFBundleShortVersionString"] as? String ?? "",
        "bundlePath": Bundle.main.bundlePath,
    ]
    guard UnixSocket.writeAll(control, jsonLine(hello)) else { return nil }
    UnixSocket.setReceiveTimeout(control, seconds: 10)
    let reader = LineReader(fd: control)
    guard let line = reader.next(),
          let welcome = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
          welcome["type"] as? String == "welcome",
          let hostPid = welcome["hostPid"] as? Int, hostPid == Int(peerPid) else { return nil }
    UnixSocket.setReceiveTimeout(control, seconds: 0)
    let session = BrokerSession(
        control: control,
        brokerPath: brokerPath,
        hostPid: pid_t(hostPid),
        policy: TargetPolicy.forMainBundle()
    )
    let thread = Thread { session.run(reader: reader) }
    thread.name = "ryco-computer-use.control"
    thread.start()
    return session
}

final class HelperAppDelegate: NSObject, NSApplicationDelegate {
    var session: BrokerSession?

    func applicationWillTerminate(_ notification: Notification) {
        session?.end()
    }
}

signal(SIGPIPE, SIG_IGN)
let arguments = CommandLine.arguments
guard let brokerIndex = arguments.firstIndex(of: "--broker"), brokerIndex + 1 < arguments.count,
      arguments[brokerIndex + 1].hasPrefix("/") else {
    // Opened by hand (Finder, Spotlight): there is nothing to do without Ryco.
    exit(EXIT_SUCCESS)
}
guard let session = connectToBroker(directory: arguments[brokerIndex + 1]) else {
    exit(EXIT_FAILURE)
}
let application = NSApplication.shared
let delegate = HelperAppDelegate()
delegate.session = session
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
