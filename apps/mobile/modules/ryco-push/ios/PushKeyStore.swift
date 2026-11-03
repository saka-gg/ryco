import CryptoKit
import Foundation
import Security

/// The installation's push key (`docs/push-alerts.md`): one X25519 key in a
/// keychain group the app shares with its notification service extension.
///
/// This file is compiled into both the app's `RycoPush` module and the
/// `RycoNotificationService` extension (the config plugin copies it there), so
/// both read the same item the same way. The app creates and deletes the key
/// and hands only its public half to JavaScript; the extension reads the key to
/// open alerts. It is readable after the first unlock, because the extension
/// runs while the phone is locked, and never leaves this device.
struct PushKeyRecord: Codable {
  /// The raw 32-byte X25519 private key.
  let privateKey: Data
  /// The device's Hub enrollment, which every sealed alert is bound to.
  var enrollmentId: String?
  /// Whether alerts play a sound; the node's payload does not say.
  var sound: Bool
}

enum PushKeyStoreError: Error {
  case keychain(OSStatus)
  case corrupt
}

struct PushKeyStore {
  /// The app's and the extension's Info.plist name the shared group here; the
  /// config plugin writes `$(AppIdentifierPrefix)<bundle id>.push`.
  static let accessGroupInfoKey = "RycoPushKeychainGroup"
  private static let service = "dev.ryco.push"
  private static let account = "push-key-v1"

  let accessGroup: String

  /// The store of this process's bundle, or nil when the build has no shared
  /// group: a Personal Team build, which cannot sign the extension.
  static func fromMainBundle() -> PushKeyStore? {
    guard
      let group = Bundle.main.object(forInfoDictionaryKey: accessGroupInfoKey) as? String,
      !group.isEmpty,
      !group.contains("$(")
    else { return nil }
    return PushKeyStore(accessGroup: group)
  }

  private func query() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: Self.account,
      kSecAttrAccessGroup as String: accessGroup,
      kSecUseDataProtectionKeychain as String: true,
    ]
  }

  func read() throws -> PushKeyRecord? {
    var query = query()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw PushKeyStoreError.keychain(status) }
    guard
      let data = item as? Data,
      let record = try? JSONDecoder().decode(PushKeyRecord.self, from: data),
      record.privateKey.count == 32
    else { throw PushKeyStoreError.corrupt }
    return record
  }

  func write(_ record: PushKeyRecord) throws {
    let data = try JSONEncoder().encode(record)
    let update: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query() as CFDictionary, update as CFDictionary)
    if status == errSecSuccess { return }
    guard status == errSecItemNotFound else { throw PushKeyStoreError.keychain(status) }
    var add = query()
    add.merge(update) { _, new in new }
    let added = SecItemAdd(add as CFDictionary, nil)
    guard added == errSecSuccess else { throw PushKeyStoreError.keychain(added) }
  }

  /// The existing key, or a new one. A corrupt item is replaced: it could
  /// never open an alert, and the app registers the new key with every node.
  func ensure() throws -> PushKeyRecord {
    do {
      if let existing = try read() { return existing }
    } catch PushKeyStoreError.corrupt {
      try delete()
    }
    let record = PushKeyRecord(
      privateKey: Curve25519.KeyAgreement.PrivateKey().rawRepresentation,
      enrollmentId: nil,
      sound: false
    )
    try write(record)
    return record
  }

  func delete() throws {
    let status = SecItemDelete(query() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw PushKeyStoreError.keychain(status)
    }
  }
}
