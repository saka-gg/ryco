import CryptoKit
import ExpoModulesCore
import Foundation
import UserNotifications

/// The push key for background alerts (`docs/push-alerts.md`).
///
/// JavaScript can create the key, read its public half, record which Hub
/// enrollment and sound setting alerts are opened with, and delete it. There is
/// no path that returns the private key: only this module and the notification
/// service extension, which share `PushKeyStore`, ever hold it.
public final class RycoPushModule: Module {
  /// The extension the config plugin embeds; without it nobody could open an alert.
  private static let extensionName = "RycoNotificationService.appex"

  public func definition() -> ModuleDefinition {
    Name("RycoPush")

    Function("isAvailable") { () -> Bool in
      Self.store() != nil && Self.extensionEmbedded()
    }

    AsyncFunction("ensureKey") { () -> [String: Any] in
      try Self.describe(Self.requireStore().ensure())
    }

    AsyncFunction("readKey") { () -> [String: Any]? in
      guard let record = try Self.requireStore().read() else { return nil }
      return try Self.describe(record)
    }

    AsyncFunction("setRegistration") { (enrollmentId: String, sound: Bool) -> Void in
      let store = try Self.requireStore()
      guard var record = try store.read() else { throw PushKeyError.keyMissing }
      record.enrollmentId = enrollmentId
      record.sound = sound
      try store.write(record)
    }

    AsyncFunction("deleteKey") { () -> Void in
      try Self.requireStore().delete()
      // What the extension saved from alerts goes with the key that opened them.
      AlertExcerptStore.fromMainBundle()?.removeAll()
    }

    /// The excerpt record the extension saved for a thread's latest approval or question alert
    /// (`AlertExcerptStore`), as JSON, or nil. The app checks its age and shape.
    AsyncFunction("readAlertExcerpt") { (environmentId: String, threadId: String) -> String? in
      guard
        let data = AlertExcerptStore.fromMainBundle()?.read(
          environmentId: environmentId, threadId: threadId)
      else { return nil }
      return String(data: data, encoding: .utf8)
    }

    /// Forgets a thread's excerpt once the thread's own detail shows its requests.
    AsyncFunction("removeAlertExcerpt") { (environmentId: String, threadId: String) -> Void in
      AlertExcerptStore.fromMainBundle()?.remove(environmentId: environmentId, threadId: threadId)
    }

    // The app icon badge: each machine's "needs you" count, the ones the app sees live written
    // over those alerts brought (`PushBadgeStore`); a machine no longer listed is dropped.
    // Returns the sum, which the badge now shows.
    AsyncFunction("setBadgeCounts") {
      (live: [String: Int], listed: [String]) async throws -> Int in
      guard let store = PushBadgeStore.fromMainBundle() else { throw PushKeyError.unavailable }
      let keep = Set(listed)
      var counts = store.read().filter { keep.contains($0.key) }
      for (environmentId, count) in live { counts[environmentId] = Int64(max(0, count)) }
      try store.write(counts)
      let total = Int(counts.values.reduce(0, +))
      try await UNUserNotificationCenter.current().setBadgeCount(total)
      return total
    }

    // Sign-out: no machine's count stays, and the badge goes.
    AsyncFunction("clearBadge") { () async throws -> Void in
      try PushBadgeStore.fromMainBundle()?.delete()
      try await UNUserNotificationCenter.current().setBadgeCount(0)
    }
  }

  private static func store() -> PushKeyStore? {
    PushKeyStore.fromMainBundle()
  }

  private static func requireStore() throws -> PushKeyStore {
    guard let store = store(), extensionEmbedded() else { throw PushKeyError.unavailable }
    return store
  }

  private static func extensionEmbedded() -> Bool {
    guard let plugins = Bundle.main.builtInPlugInsURL else { return false }
    return FileManager.default.fileExists(
      atPath: plugins.appendingPathComponent(extensionName).path)
  }

  /// The raw 32-byte public key, base64url without padding, and the recorded
  /// enrollment. Never the private key.
  private static func describe(_ record: PushKeyRecord) throws -> [String: Any] {
    guard let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: record.privateKey)
    else { throw PushKeyError.corrupt }
    let publicKey = key.publicKey.rawRepresentation.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    return ["publicKey": publicKey, "enrollmentId": record.enrollmentId as Any]
  }
}

/// Fixed messages: no key material or keychain detail reaches JavaScript.
private enum PushKeyError: Error, LocalizedError {
  case unavailable
  case keyMissing
  case corrupt

  var errorDescription: String? {
    switch self {
    case .unavailable:
      return "This build cannot receive background alerts."
    case .keyMissing:
      return "No push key exists."
    case .corrupt:
      return "The push key could not be read."
    }
  }
}
