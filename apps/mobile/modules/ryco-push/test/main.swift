// The harness `pushSealOpener.test.ts` compiles with `PushSealOpener.swift` and
// `PushAlertOpener.swift`. It opens every vector of
// `packages/shared/src/pushSeal.vectors.json` the way the notification service
// extension does, and prints what it found as JSON for the test to check.
import CryptoKit
import Foundation

func hexBytes(_ hex: String) -> Data {
  var data = Data()
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    data.append(UInt8(hex[index..<next], radix: 16)!)
    index = next
  }
  return data
}

func hex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

func base64Url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

func base64UrlDecode(_ text: String) -> Data {
  var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
  return Data(base64Encoded: base64)!
}

/// An APNs payload as the Hub sends it.
func apnsPayload(
  environmentId: String,
  sequence: Any,
  sealed: String,
  enrollmentId: String?
) -> [AnyHashable: Any] {
  var ryco: [String: Any] = ["v": 1, "e": environmentId, "q": sequence, "s": sealed]
  if let enrollmentId { ryco["n"] = enrollmentId }
  return ["aps": ["mutable-content": 1], "ryco": ryco]
}

/// What the app would get as `userInfo` for this payload, with the Hub's own
/// `body` and `url` beside `ryco`, as a Hub could send them.
func userInfoReport(_ payload: [AnyHashable: Any], alert: PushAlert?) -> [String: Any] {
  var hubPayload = payload
  hubPayload["body"] = ["environmentId": "env_hub", "threadId": "thread_hub"]
  hubPayload["url"] = "ryco-dev://threads/env_hub/thread_hub"
  let userInfo = PushAlertOpener.userInfo(hubPayload, alert: alert)
  var report: [String: Any] = ["keys": userInfo.keys.map { "\($0)" }.sorted()]
  if let body = userInfo["body"] { report["body"] = body }
  if let url = userInfo["url"] { report["url"] = url }
  return report
}

let vectorsPath = CommandLine.arguments[1]
let document =
  try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: vectorsPath)))
  as! [String: Any]
var report: [[String: Any]] = []

for vector in document["vectors"] as! [[String: Any]] {
  let privateKey = try Curve25519.KeyAgreement.PrivateKey(
    rawRepresentation: hexBytes(vector["recipientSecretKey"] as! String))
  let environmentId = vector["environmentId"] as! String
  let sequenceNumber = vector["sequence"] as! NSNumber
  let sequence = sequenceNumber.int64Value
  let enrollmentId = vector["enrollmentId"] as! String
  let sealedText = vector["sealed"] as! String
  let sealed = base64UrlDecode(sealedText)
  let associatedData = PushSealOpener.associatedData(
    environmentId: environmentId, sequence: sequence, enrollmentId: enrollmentId)

  func opens(_ blob: Data, _ aad: Data) -> Bool {
    PushSealOpener.open(sealed: blob, privateKey: privateKey, associatedData: aad) != nil
  }
  func binding(environment: String = environmentId, sequence: Int64 = sequence, enrollment: String = enrollmentId) -> Data {
    PushSealOpener.associatedData(environmentId: environment, sequence: sequence, enrollmentId: enrollment)
  }
  var tamperedCiphertext = sealed
  tamperedCiphertext[40] ^= 0x01
  var tamperedTag = sealed
  tamperedTag[tamperedTag.count - 1] ^= 0x80
  var tamperedKey = sealed
  tamperedKey[5] ^= 0x01
  var wrongVersion = sealed
  wrongVersion[0] = 0x02
  let lowOrderKey = Data([0x01]) + Data(count: 32) + sealed.suffix(from: 33)

  let plaintext =
    try JSONSerialization.jsonObject(with: Data((vector["plaintext"] as! String).utf8))
    as! [String: Any]
  let sealedAt = (plaintext["at"] as! NSNumber).int64Value
  let fresh = Date(timeIntervalSince1970: Double(sealedAt) / 1000 + 60)
  let stale = Date(
    timeIntervalSince1970: Double(sealedAt + PushAlertOpener.maxAgeMilliseconds + 1_000) / 1000)

  func alert(
    environment: String = environmentId,
    sequence: Any = sequenceNumber,
    sealed: String = sealedText,
    routed: String?,
    stored: String?,
    now: Date = fresh
  ) -> PushAlert? {
    PushAlertOpener.alert(
      userInfo: apnsPayload(
        environmentId: environment, sequence: sequence, sealed: sealed, enrollmentId: routed),
      privateKey: privateKey,
      storedEnrollmentId: stored,
      now: now,
      appScheme: "ryco-dev"
    )
  }
  let opened = alert(routed: enrollmentId, stored: enrollmentId)

  report.append([
    "name": vector["name"] as! String,
    "publicKey": hex(privateKey.publicKey.rawRepresentation),
    "associatedData": hex(associatedData),
    "plaintext": PushSealOpener.open(
      sealed: sealed, privateKey: privateKey, associatedData: associatedData
    ).map { String(decoding: $0, as: UTF8.self) } as Any,
    "rejects": [
      "ciphertext": !opens(tamperedCiphertext, associatedData),
      "tag": !opens(tamperedTag, associatedData),
      "ephemeralKey": !opens(tamperedKey, associatedData),
      "version": !opens(wrongVersion, associatedData),
      "lowOrderKey": !opens(lowOrderKey, associatedData),
      "truncated": !opens(sealed.prefix(48), associatedData),
      "otherEnrollment": !opens(sealed, binding(enrollment: enrollmentId + "x")),
      "otherSequence": !opens(sealed, binding(sequence: sequence - 1)),
      "otherEnvironment": !opens(sealed, binding(environment: environmentId + "x")),
      "otherKey": PushSealOpener.open(
        sealed: sealed, privateKey: Curve25519.KeyAgreement.PrivateKey(),
        associatedData: associatedData) == nil,
    ],
    "alert": opened.map {
      [
        "kind": $0.kind,
        "title": $0.title,
        "body": $0.body,
        "environmentId": $0.environmentId,
        "threadId": $0.threadId,
        "threadIdentifier": $0.threadIdentifier,
        "url": $0.url as Any,
      ]
    } as Any,
    "alertRejects": [
      "stale": alert(routed: enrollmentId, stored: enrollmentId, now: stale) == nil,
      "routedToOtherEnrollment": alert(routed: enrollmentId + "x", stored: enrollmentId) == nil,
      "sequenceMismatch": alert(
        sequence: NSNumber(value: sequence - 1), routed: enrollmentId, stored: enrollmentId) == nil,
      "sequenceAsString": alert(
        sequence: String(sequence), routed: enrollmentId, stored: enrollmentId) == nil,
      "environmentMismatch": alert(
        environment: environmentId + "x", routed: enrollmentId, stored: enrollmentId) == nil,
      "tampered": alert(
        sealed: base64Url(tamperedCiphertext), routed: enrollmentId, stored: enrollmentId) == nil,
      "noEnrollment": alert(routed: nil, stored: nil) == nil,
    ],
    "userInfo": userInfoReport(
      apnsPayload(
        environmentId: environmentId, sequence: sequenceNumber, sealed: sealedText,
        enrollmentId: enrollmentId),
      alert: opened),
    "userInfoWhenUnopened": userInfoReport(
      apnsPayload(
        environmentId: environmentId, sequence: sequenceNumber, sealed: sealedText,
        enrollmentId: enrollmentId),
      alert: nil),
    "opensWithStoredEnrollmentOnly": alert(routed: nil, stored: enrollmentId) == opened,
    "opensWithRoutedEnrollmentOnly": alert(routed: enrollmentId, stored: nil) == opened,
  ])
}

let output: [String: Any] = ["vectors": report, "kindTitles": PushAlertOpener.kindTitles]
print(
  String(
    decoding: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]),
    as: UTF8.self))
