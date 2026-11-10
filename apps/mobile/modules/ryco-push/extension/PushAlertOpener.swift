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
  /// The turn it is about.
  let turnId: String?
  /// An approval alert's approval (`rq`): Approve or Deny on the alert answers this one only.
  let requestId: String?
  /// Its actions (`src/notifications/notificationActionsModel.ts`).
  let categoryIdentifier: String
  /// Alerts stack per thread: `<environment>/<thread>`.
  let threadIdentifier: String
  /// The thread's deep link, when the app's scheme is known.
  let url: String?
  /// What the person is asked, when the node sent an excerpt: the alert's body line.
  let excerptLine: String?
  /// The excerpt as the app reads it (`AlertExcerptStore`): only its known keys, as JSON.
  let excerpt: Data?
  /// When the node sealed it, epoch ms.
  let sealedAt: Int64
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
  /// `PUSH_ALERT_REQUEST_ID_MAX_LENGTH`; a longer id is left out.
  private static let maxRequestIdLength = 160
  /// `PUSH_ALERT_EXCERPT_MAX_BYTES`; a larger excerpt is not one a node sends.
  private static let maxExcerptBytes = 1_024
  /// The approval card's words for each request kind (`PendingApprovalCard`).
  static let requestKindLabels: [String: String] = [
    "command": "Run command",
    "file-read": "Read file",
    "file-change": "Change file",
  ]

  /// One line per kind. Must equal `THREAD_ALERT_COPY` in
  /// `@ryco/client-runtime/state/settings`; `pushSealOpener.test.ts` checks it.
  /// The actions each kind offers. Must equal `notificationCategoryForKind` in
  /// `src/notifications/notificationActionsModel.ts`; the app registers them.
  static let kindCategories: [String: String] = [
    "approval": "ryco.approval",
    "input": "ryco.answer",
    "plan-ready": "ryco.answer",
    "completed": "ryco.result",
    "failed": "ryco.result",
    "stopped": "ryco.result",
  ]

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
      let category = kindCategories[kind],
      let threadTitle = payload["t"] as? String,
      payload["e"] as? String == envelope.environmentId,
      exactInteger(payload["q"]) == envelope.sequence,
      let threadId = nonEmptyString(payload["th"]),
      let sealedAt = exactInteger(payload["at"])
    else { return nil }
    let nowMilliseconds = Int64((now.timeIntervalSince1970 * 1000).rounded(.down))
    guard nowMilliseconds - sealedAt <= maxAgeMilliseconds else { return nil }
    let excerpt = Self.excerpt(kind: kind, value: payload["x"])

    return PushAlert(
      kind: kind,
      title: title,
      body: String(threadTitle.prefix(maxTitleLength)),
      environmentId: envelope.environmentId,
      threadId: threadId,
      turnId: nonEmptyString(payload["tu"]),
      requestId: kind == "approval"
        ? nonEmptyString(payload["rq"]).flatMap { $0.count <= maxRequestIdLength ? $0 : nil }
        : nil,
      categoryIdentifier: category,
      threadIdentifier: "\(envelope.environmentId)/\(threadId)",
      url: appScheme.flatMap { threadLink(scheme: $0, environmentId: envelope.environmentId, threadId: threadId) },
      excerptLine: excerpt?.line,
      excerpt: excerpt?.json,
      sealedAt: sealedAt
    )
  }

  /// An approval's or question's excerpt (`x`), checked key by key; anything else is ignored, so
  /// the alert shows as it did before excerpts. Older builds never read `x` at all.
  static func excerpt(kind: String, value: Any?) -> (line: String, json: Data)? {
    guard let value = value as? [String: Any] else { return nil }
    var clean: [String: Any]
    let line: String
    if kind == "approval", let approval = value["a"] as? [String: Any] {
      guard let requestKind = approval["k"] as? String, let label = requestKindLabels[requestKind]
      else { return nil }
      var fields: [String: Any] = ["k": requestKind]
      if let detail = approval["d"] { guard let text = detail as? String else { return nil }; fields["d"] = text }
      if let reason = approval["r"] { guard let text = reason as? String else { return nil }; fields["r"] = text }
      clean = ["a": fields]
      let detail = (fields["d"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      line = detail.isEmpty ? label : "\(label): \(detail)"
    } else if kind == "input", let input = value["u"] as? [String: Any] {
      guard let requestId = nonEmptyString(input["rq"]), let rawQuestions = input["qs"] as? [Any],
        !rawQuestions.isEmpty
      else { return nil }
      var questions: [[String: Any]] = []
      for raw in rawQuestions {
        guard let question = raw as? [String: Any], let id = nonEmptyString(question["id"]),
          let text = question["q"] as? String
        else { return nil }
        var fields: [String: Any] = ["id": id, "q": text]
        if let header = question["h"] { guard let text = header as? String else { return nil }; fields["h"] = text }
        if let options = question["o"] {
          guard let labels = options as? [String] else { return nil }
          fields["o"] = labels
        }
        if let multi = question["m"] {
          guard let flag = multi as? Bool, flag else { return nil }
          fields["m"] = true
        }
        questions.append(fields)
      }
      var fields: [String: Any] = ["rq": requestId, "qs": questions]
      if let event = input["ev"] { guard let text = nonEmptyString(event) else { return nil }; fields["ev"] = text }
      if let cut = input["c"] { guard let flag = cut as? Bool, flag else { return nil }; fields["c"] = true }
      clean = ["u": fields]
      line = (questions[0]["q"] as? String) ?? ""
    } else {
      return nil
    }
    guard
      let json = try? JSONSerialization.data(withJSONObject: clean, options: [.sortedKeys]),
      json.count <= maxExcerptBytes * 2
    else { return nil }
    return (line, json)
  }

  /// The record the app reads for the thread (`AlertExcerptStore`), or nil without an excerpt.
  static func excerptRecord(_ alert: PushAlert) -> Data? {
    guard let excerpt = alert.excerpt,
      let value = try? JSONSerialization.jsonObject(with: excerpt)
    else { return nil }
    var record: [String: Any] = [
      "v": 1, "e": alert.environmentId, "th": alert.threadId, "k": alert.kind,
      "at": NSNumber(value: alert.sealedAt), "x": value,
    ]
    if let turnId = alert.turnId { record["tu"] = turnId }
    if let requestId = alert.requestId { record["rq"] = requestId }
    return try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
  }

  /// The `userInfo` the app gets with the alert. expo-notifications hands a
  /// remote alert's `body` to the app as its data, where the app's own alerts
  /// keep the thread a tap opens, and the app checks it before it shows a
  /// banner in front. Only an opened alert may name a thread: on any failure,
  /// or when time runs out, the Hub's own `body` and `url` go too, so nothing
  /// the Hub alone wrote reaches a tap.
  static func userInfo(_ original: [AnyHashable: Any], alert: PushAlert?) -> [AnyHashable: Any] {
    var userInfo = original
    userInfo.removeValue(forKey: "ryco")
    userInfo.removeValue(forKey: "body")
    userInfo.removeValue(forKey: "url")
    guard let alert else { return userInfo }
    var body: [String: Any] = [
      "environmentId": alert.environmentId, "threadId": alert.threadId, "kind": alert.kind,
    ]
    if let turnId = alert.turnId { body["turnId"] = turnId }
    if let requestId = alert.requestId { body["requestId"] = requestId }
    userInfo["body"] = body
    if let url = alert.url { userInfo["url"] = url }
    return userInfo
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
