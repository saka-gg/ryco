import CryptoKit
import ExpoModulesCore
import Foundation

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
