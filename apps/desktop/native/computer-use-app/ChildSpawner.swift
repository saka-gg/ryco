import Darwin
import Foundation

// <spawn.h>: only descriptors named by file actions reach the child.
private let posixSpawnCloexecDefault: Int16 = 0x4000

/// Which programs this helper starts. Its grants must never run code Ryco did not ship, so the
/// allowlist comes from the helper's own bundle, not from the request.
struct TargetPolicy {
    static let allowedTargets = ["ryco-computer-ui-helper", "cua-driver/cua-driver"]
    let resourcesDirectory: URL?

    static func forMainBundle() -> TargetPolicy {
        let bundle = Bundle.main
        if let explicit = bundle.object(forInfoDictionaryKey: "RycoComputerUseResourcesDirectory") as? String,
           explicit.hasPrefix("/") {
            return TargetPolicy(resourcesDirectory: URL(fileURLWithPath: explicit, isDirectory: true))
        }
        return TargetPolicy(bundleURL: bundle.bundleURL)
    }

    /// A packaged helper lives in `<Ryco>.app/Contents/Helpers`; Ryco's programs are in
    /// `Contents/Resources` beside it.
    init(bundleURL: URL) {
        let helpers = bundleURL.standardizedFileURL.deletingLastPathComponent()
        let contents = helpers.deletingLastPathComponent()
        resourcesDirectory = helpers.lastPathComponent == "Helpers" && contents.lastPathComponent == "Contents"
            ? contents.appendingPathComponent("Resources", isDirectory: true)
            : nil
    }

    init(resourcesDirectory: URL?) {
        self.resourcesDirectory = resourcesDirectory
    }

    /// The resolved executable to start, or nil when the path is not one of Ryco's programs.
    func resolve(_ path: String) -> String? {
        guard let resourcesDirectory, path.hasPrefix("/") else { return nil }
        let requested = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        for target in TargetPolicy.allowedTargets {
            let allowed = resourcesDirectory.appendingPathComponent(target).resolvingSymlinksInPath().path
            if requested == allowed, FileManager.default.isExecutableFile(atPath: allowed) {
                return allowed
            }
        }
        return nil
    }
}

struct SpawnRequest {
    let id: String
    let path: String
    let args: [String]
    let env: [String: String]
    let cwd: String?
    /// "pipe" or "ignore" for fds 0, 1 and 2.
    let stdio: [String]
    let streamToken: String
    let proxySocket: String?

    init?(_ message: [String: Any]) {
        guard let id = message["id"] as? String, !id.isEmpty, id.count <= 64,
              let path = message["path"] as? String,
              let args = message["args"] as? [String],
              let env = message["env"] as? [String: String],
              let stdio = message["stdio"] as? [String], stdio.count == 3,
              stdio.allSatisfy({ $0 == "pipe" || $0 == "ignore" }),
              let streamToken = message["streamToken"] as? String, !streamToken.isEmpty else {
            return nil
        }
        self.id = id
        self.path = path
        self.args = args
        self.env = env
        self.cwd = message["cwd"] as? String
        self.stdio = stdio
        self.streamToken = streamToken
        self.proxySocket = message["proxySocket"] as? String
    }
}

final class ChildRecord {
    let id: String
    let pid: pid_t
    let proxy: SocketProxy?
    private let lock = NSLock()
    private var reaped = false

    init(id: String, pid: pid_t, proxy: SocketProxy?) {
        self.id = id
        self.pid = pid
        self.proxy = proxy
    }

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !reaped
    }

    /// Signals only a child this helper has not reaped yet, so a recycled pid is never hit.
    func signal(_ signal: Int32) {
        lock.lock()
        defer { lock.unlock() }
        if !reaped { _ = Darwin.kill(pid, signal) }
    }

    func markReaped() {
        lock.lock()
        reaped = true
        lock.unlock()
        proxy?.stop()
    }
}

enum ChildSpawner {
    /// Starts one child whose stdio are fresh connections to Ryco's broker socket.
    static func spawn(
        _ request: SpawnRequest,
        policy: TargetPolicy,
        brokerPath: String,
        hostPid: pid_t
    ) throws -> ChildRecord {
        guard let executable = policy.resolve(request.path) else {
            throw HelperFailure("Ryco Computer Use only starts Ryco's own helpers.")
        }
        var proxy: SocketProxy?
        var args = request.args
        if let publicPath = request.proxySocket {
            guard let index = args.firstIndex(of: publicPath) else {
                throw HelperFailure("The driver socket is not among the arguments.")
            }
            let created = SocketProxy(publicPath: publicPath, hostPid: hostPid)
            args[index] = created.privatePath
            try created.start()
            proxy = created
        }
        var descriptors: [Int32] = []
        defer { for fd in descriptors where fd >= 0 { Darwin.close(fd) } }
        do {
            for (fd, mode) in request.stdio.enumerated() {
                if mode == "ignore" {
                    let null = open("/dev/null", fd == 0 ? O_RDONLY : O_WRONLY)
                    guard null >= 0 else { throw HelperFailure("Could not open /dev/null.") }
                    descriptors.append(null)
                    continue
                }
                let stream = try UnixSocket.connect(path: brokerPath)
                descriptors.append(stream)
                let hello: [String: Any] = ["type": "stream", "id": request.id, "fd": fd, "token": request.streamToken]
                guard UnixSocket.writeAll(stream, jsonLine(hello)) else {
                    throw HelperFailure("Ryco closed the stream connection.")
                }
            }
            let pid = try launch(executable: executable, args: args, request: request, stdio: descriptors)
            return ChildRecord(id: request.id, pid: pid, proxy: proxy)
        } catch {
            proxy?.stop()
            throw error
        }
    }

    private static func launch(
        executable: String,
        args: [String],
        request: SpawnRequest,
        stdio: [Int32]
    ) throws -> pid_t {
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        for (target, source) in stdio.enumerated() {
            posix_spawn_file_actions_adddup2(&actions, source, Int32(target))
        }
        if let cwd = request.cwd, cwd.hasPrefix("/") {
            posix_spawn_file_actions_addchdir_np(&actions, cwd)
        }
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // Children start with default signal handling and an empty mask, like a Node spawn:
        // this process ignores SIGPIPE, the driver and helpers must not inherit that.
        var defaults = sigset_t()
        sigfillset(&defaults)
        posix_spawnattr_setsigdefault(&attributes, &defaults)
        var mask = sigset_t()
        sigemptyset(&mask)
        posix_spawnattr_setsigmask(&attributes, &mask)
        posix_spawnattr_setflags(
            &attributes,
            posixSpawnCloexecDefault | Int16(POSIX_SPAWN_SETSIGDEF) | Int16(POSIX_SPAWN_SETSIGMASK)
        )
        let argv = ([executable] + args).map { strdup($0) }
        // No dynamic-loader overrides: they would run foreign code under this app's grants.
        let envp = request.env
            .filter { !$0.key.hasPrefix("DYLD_") }
            .map { strdup("\($0.key)=\($0.value)") }
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var argvPointers = argv + [nil]
        var envPointers = envp + [nil]
        var pid: pid_t = 0
        let status = posix_spawn(&pid, executable, &actions, &attributes, &argvPointers, &envPointers)
        guard status == 0 else {
            throw HelperFailure("Could not start \((executable as NSString).lastPathComponent): \(String(cString: strerror(status)))")
        }
        return pid
    }
}
