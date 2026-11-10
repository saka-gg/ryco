import CryptoKit
import Foundation

/// What a background alert asked of the person (`docs/push-alerts.md`): the notification service
/// extension writes the opened excerpt of an approval or question alert here, one small file per
/// thread in the App Group the app shares, and the app reads it when that thread opens, so its
/// card shows before any connection is up. Compiled into both the extension and the app's module.
///
/// A file holds one thread's latest excerpt only: the thread's ids, the kind, the request and the
/// excerpt as the node sealed it. Files are readable after the first unlock, which an extension
/// running on a locked phone needs, are replaced by a newer alert for the thread, expire with the
/// alert (`PushAlertOpener.maxAgeMilliseconds`), and all go with the push key.
struct AlertExcerptStore {
  /// The Info.plist key, in the app's and the extension's, that names the shared group.
  static let appGroupInfoKey = "RycoAppGroup"
  /// Far above any record the extension writes; anything bigger is not one of them.
  static let maxRecordBytes = 16 * 1024

  let directory: URL

  /// The store this bundle's Info.plist names, or nil without the group (Personal Team builds).
  static func fromMainBundle() -> AlertExcerptStore? {
    guard
      let group = Bundle.main.object(forInfoDictionaryKey: appGroupInfoKey) as? String,
      !group.isEmpty,
      !group.contains("$("),
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: group)
    else { return nil }
    return AlertExcerptStore(
      directory: container.appendingPathComponent("alert-excerpts", isDirectory: true))
  }

  /// One file per thread, named by a hash so no id ever becomes a path.
  static func fileName(environmentId: String, threadId: String) -> String {
    let digest = SHA256.hash(data: Data("\(environmentId)\n\(threadId)".utf8))
    return digest.prefix(16).map { String(format: "%02x", $0) }.joined() + ".json"
  }

  private func fileURL(environmentId: String, threadId: String) -> URL {
    directory.appendingPathComponent(
      Self.fileName(environmentId: environmentId, threadId: threadId), isDirectory: false)
  }

  /// Replaces the thread's record in one step, so the app never reads half of one.
  func write(_ record: Data, environmentId: String, threadId: String) throws {
    guard record.count <= Self.maxRecordBytes else { return }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = fileURL(environmentId: environmentId, threadId: threadId)
    #if os(iOS)
      try record.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
      try record.write(to: url, options: [.atomic])
    #endif
  }

  func read(environmentId: String, threadId: String) -> Data? {
    let url = fileURL(environmentId: environmentId, threadId: threadId)
    guard let data = try? Data(contentsOf: url), data.count <= Self.maxRecordBytes else {
      return nil
    }
    return data
  }

  func remove(environmentId: String, threadId: String) {
    try? FileManager.default.removeItem(at: fileURL(environmentId: environmentId, threadId: threadId))
  }

  func removeAll() {
    try? FileManager.default.removeItem(at: directory)
  }
}
