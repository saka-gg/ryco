import Darwin
import Foundation
import Security

/// Proves the broker this helper connected to is Ryco. The launch token only proves the helper to
/// Ryco; without this check any process of this user could start the helper with its own broker
/// and borrow its grants. The peer must be validly signed code at Ryco's exact path.
enum HostVerification {
    // <sys/un.h>: getsockopt(SOL_LOCAL, LOCAL_PEERTOKEN) answers the peer's audit token.
    private static let solLocal: Int32 = 0
    private static let localPeerToken: Int32 = 0x006

    /// Packaged: the app whose `Contents/Helpers` holds this helper. Unpackaged builds name the
    /// host in their signed Info.plist.
    static func expectedHostPath(bundle: Bundle = .main) -> String? {
        if let explicit = bundle.object(forInfoDictionaryKey: "RycoComputerUseHostPath") as? String,
           explicit.hasPrefix("/") {
            return URL(fileURLWithPath: explicit).resolvingSymlinksInPath().standardizedFileURL.path
        }
        let helpers = bundle.bundleURL.standardizedFileURL.deletingLastPathComponent()
        let contents = helpers.deletingLastPathComponent()
        guard helpers.lastPathComponent == "Helpers", contents.lastPathComponent == "Contents" else {
            return nil
        }
        return contents.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// True when the process listening on the other end of `fd` is valid code at `expectedPath`.
    static func peerIsHost(_ fd: Int32, expectedPath: String) -> Bool {
        var token = audit_token_t()
        var length = socklen_t(MemoryLayout<audit_token_t>.size)
        guard getsockopt(fd, solLocal, localPeerToken, &token, &length) == 0 else { return false }
        let tokenData = withUnsafeBytes(of: &token) { Data($0) } as CFData
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(
            nil, [kSecGuestAttributeAudit: tokenData] as CFDictionary, [], &code
        ) == errSecSuccess, let code,
            SecCodeCheckValidity(code, [], nil) == errSecSuccess else { return false }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
            return false
        }
        var url: CFURL?
        guard SecCodeCopyPath(staticCode, [], &url) == errSecSuccess, let url else { return false }
        let path = (url as URL).resolvingSymlinksInPath().standardizedFileURL.path
        return path == expectedPath
    }
}
