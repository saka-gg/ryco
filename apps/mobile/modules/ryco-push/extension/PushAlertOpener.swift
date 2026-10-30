import CryptoKit
import Foundation

/// What a thread alert shows once its sealed payload opened.
struct PushAlert: Equatable {
  let kind: String
  /// The kind's line, the same words the app's own alerts use.
  let title: String
  /// The thread's title.
  let body: String
  let environmentId: String
  let threadId: String
  /// Alerts stack per thread: `<environment>/<thread>`.
  let threadIdentifier: String
  /// The thread's deep link, when the app's scheme is known.
  let url: String?
}

/// Reads the `ryco` part of an APNs payload, opens its sealed blob and checks
/// it (`docs/push-alerts.md`):
///
/// ```json
/// { "ryco": { "v": 1, "e": "env_…", "q": 1793234112000, "n": "enr_…", "s": "<sealed>" } }
/// ```
///
/// Any failure answers nil, and the extension leaves the Hub's generic text.
/// Foundation and CryptoKit only, so `pushSealOpener.test.ts` can run it.
enum PushAlertOpener {
  /// A payload sealed longer ago than this is stale: the thread moved on.
  static let maxAgeMilliseconds: Int64 = 2 * 60 * 60 * 1000
  private static let maxTitleLength = 120

  /// One line per kind. Must equal `THREAD_ALERT_COPY` in
  /// `@ryco/client-runtime/state/settings`; `pushSealOpener.test.ts` checks it.
  static let kindTitles: [String: String] = [
    "approval": "Needs approval",
    "input": "Needs your answer",
    "plan-ready": "Plan ready",
    "completed": "Finished",
    "failed": "Failed",
    "stopped": "Stopped",
  ]

  struct Envelope {
    let environmentId: String
    let sequence: Int64
    /// The enrollment the Hub routed this to; absent from older Hubs.
    let enrollmentId: String?
    let sealed: Data
  }

  static func envelope(userInfo: [AnyHashable: Any]) -> Envelope? {
    guard
      let ryco = userInfo["ryco"] as? [String: Any],
      exactInteger(ryco["v"]) == 1,
      let environmentId = nonEmptyString(ryco["e"]),
      let sequence = exactInteger(ryco["q"]),
      let sealedText = nonEmptyString(ryco["s"]),
      let sealed = base64UrlDecode(sealedText)
    else { return nil }
    let enrollmentId: String?
    if let value = ryco["n"] {
      guard let text = nonEmptyString(value) else { return nil }
      enrollmentId = text
    } else {
      enrollmentId = nil
    }
    return Envelope(
      environmentId: environmentId, sequence: sequence, enrollmentId: enrollmentId, sealed: sealed)
  }

  static func alert(
    userInfo: [AnyHashable: Any],
    privateKey: Curve25519.KeyAgreement.PrivateKey,
    storedEnrollmentId: String?,
    now: Date,
    appScheme: String?
  ) -> PushAlert? {
    guard let envelope = envelope(userInfo: userInfo) else { return nil }
    // The device's own enrollment, as the app recorded it, binds the blob; a
    // Hub naming another one is refused.
    if let stored = storedEnrollmentId, let routed = envelope.enrollmentId, stored != routed {
      return nil
    }
    guard
      let enrollmentId = storedEnrollmentId ?? envelope.enrollmentId,
      let plaintext = PushSealOpener.open(
        sealed: envelope.sealed,
        privateKey: privateKey,
        associatedData: PushSealOpener.associatedData(
          environmentId: envelope.environmentId,
          sequence: envelope.sequence,
          enrollmentId: enrollmentId
        )
      ),
      let payload = (try? JSONSerialization.jsonObject(with: plaintext)) as? [String: Any],
      exactInteger(payload["v"]) == 1,
      let kind = payload["k"] as? String,
      let title = kindTitles[kind],
      let threadTitle = payload["t"] as? String,
      payload["e"] as? String == envelope.environmentId,
      exactInteger(payload["q"]) == envelope.sequence,
      let threadId = nonEmptyString(payload["th"]),
      let sealedAt = exactInteger(payload["at"])
    else { return nil }
    let nowMilliseconds = Int64((now.timeIntervalSince1970 * 1000).rounded(.down))
    guard nowMilliseconds - sealedAt <= maxAgeMilliseconds else { return nil }

    return PushAlert(
      kind: kind,
      title: title,
      body: String(threadTitle.prefix(maxTitleLength)),
      environmentId: envelope.environmentId,
      threadId: threadId,
      threadIdentifier: "\(envelope.environmentId)/\(threadId)",
      url: appScheme.flatMap { threadLink(scheme: $0, environmentId: envelope.environmentId, threadId: threadId) }
    )
  }

  /// The app's thread route, `threads/:environmentId/:threadId`.
  static func threadLink(scheme: String, environmentId: String, threadId: String) -> String? {
    guard
      !scheme.isEmpty,
      let environment = environmentId.addingPercentEncoding(withAllowedCharacters: unreserved),
      let thread = threadId.addingPercentEncoding(withAllowedCharacters: unreserved)
    else { return nil }
    return "\(scheme)://threads/\(environment)/\(thread)"
  }

  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  private static func nonEmptyString(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty else { return nil }
    return text
  }

  /// A JSON integer, never a boolean or a fraction.
  private static func exactInteger(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return nil
    }
    let integer = number.int64Value
    guard Double(integer) == number.doubleValue, integer >= 0 else { return nil }
    return integer
  }

  private static func base64UrlDecode(_ text: String) -> Data? {
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard !base64.contains("=") else { return nil }
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
  }
}
