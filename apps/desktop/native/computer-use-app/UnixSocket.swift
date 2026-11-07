import Darwin
import Foundation

struct HelperFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Blocking Unix-domain socket helpers. Every descriptor is close-on-exec and never raises SIGPIPE.
enum UnixSocket {
    // <sys/un.h>: getsockopt(SOL_LOCAL, LOCAL_PEERPID) answers the connected peer's pid.
    private static let solLocal: Int32 = 0
    private static let localPeerPid: Int32 = 0x002

    private static func address(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard !bytes.isEmpty, bytes.count < capacity else {
            throw HelperFailure("Socket path is too long.")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return address
    }

    private static func makeSocket() throws -> Int32 {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HelperFailure("socket() failed: \(errno)") }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        var one: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        return fd
    }

    static func connect(path: String) throws -> Int32 {
        var address = try address(path)
        let fd = try makeSocket()
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            let code = errno
            Darwin.close(fd)
            throw HelperFailure("connect() failed: \(code)")
        }
        return fd
    }

    /// Binds a listener readable and writable by this user only.
    static func listen(path: String) throws -> Int32 {
        var address = try address(path)
        let fd = try makeSocket()
        let previous = umask(0o077)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        umask(previous)
        guard bound == 0, Darwin.listen(fd, 64) == 0 else {
            let code = errno
            Darwin.close(fd)
            throw HelperFailure("Could not listen on the driver socket: \(code)")
        }
        _ = chmod(path, 0o600)
        return fd
    }

    static func accept(_ listener: Int32) -> Int32? {
        while true {
            let fd = Darwin.accept(listener, nil, nil)
            if fd >= 0 {
                _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
                var one: Int32 = 1
                _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
                return fd
            }
            if errno == EINTR || errno == ECONNABORTED { continue }
            return nil
        }
    }

    static func peerPid(_ fd: Int32) -> pid_t? {
        var pid: pid_t = 0
        var length = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(fd, solLocal, localPeerPid, &pid, &length) == 0, pid > 0 else { return nil }
        return pid
    }

    @discardableResult
    static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            guard var pointer = raw.baseAddress else { return true }
            var remaining = raw.count
            while remaining > 0 {
                let written = Darwin.write(fd, pointer, remaining)
                if written < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                remaining -= written
                pointer = pointer.advanced(by: written)
            }
            return true
        }
    }

    static func setReceiveTimeout(_ fd: Int32, seconds: Int) {
        var timeout = timeval(tv_sec: seconds, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    }
}

/// Reads newline-delimited JSON objects from a blocking descriptor.
final class LineReader {
    private let fd: Int32
    private var buffer = Data()
    private let limit: Int

    init(fd: Int32, limit: Int = 8 * 1024 * 1024) {
        self.fd = fd
        self.limit = limit
    }

    /// The next line, or nil at end of stream, on a read error, or when a line exceeds the limit.
    func next() -> Data? {
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            if let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<newline)
                buffer.removeSubrange(buffer.startIndex...newline)
                return line
            }
            if buffer.count > limit { return nil }
            let count = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count < 0, errno == EINTR { continue }
            if count <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<count])
        }
    }
}

func jsonLine(_ object: [String: Any]) -> Data {
    var data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    data.append(0x0A)
    return data
}
