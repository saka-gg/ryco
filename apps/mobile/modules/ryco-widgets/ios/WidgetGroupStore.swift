import Foundation

/// The folder in the App Group the app shares with its widget extension
/// (`plugins/withIosWidgetExtension.cjs`). The app writes one timeline file
/// per widget kind; the extension only reads them. Compiled into both.
///
/// The files hold only what a widget shows on a locked phone: no credentials,
/// emails, Hub addresses or node data. They are readable after the first
/// unlock (`completeUntilFirstUserAuthentication`), which a Lock Screen widget
/// needs.
struct WidgetGroupStore {
  /// The Info.plist key, in the app's and the extension's, that names the group.
  static let appGroupInfoKey = "RycoWidgetsAppGroup"

  let directory: URL

  /// The store this bundle's Info.plist names, or nil in a build without the
  /// widget extension (Personal Team) or when the group container is missing.
  static func fromMainBundle() -> WidgetGroupStore? {
    guard
      let group = Bundle.main.object(forInfoDictionaryKey: appGroupInfoKey) as? String,
      !group.isEmpty,
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: group)
    else { return nil }
    return WidgetGroupStore(
      directory: container.appendingPathComponent("widgets", isDirectory: true))
  }

  /// A kind names a file, so it is a short lowercase slug and never a path.
  static func isValidKind(_ kind: String) -> Bool {
    guard !kind.isEmpty, kind.utf8.count <= 64 else { return false }
    return kind.unicodeScalars.allSatisfy { scalar in
      ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) || scalar == "-"
    }
  }

  func fileURL(kind: String) -> URL? {
    guard Self.isValidKind(kind) else { return nil }
    return directory.appendingPathComponent("\(kind).json", isDirectory: false)
  }

  /// What the app last wrote for `kind`; nil when it wrote nothing.
  func read(kind: String) -> Data? {
    guard let url = fileURL(kind: kind) else { return nil }
    return try? Data(contentsOf: url)
  }

  /// Replaces `kind`'s file in one step, so the extension never reads half of one.
  func write(kind: String, data: Data) throws {
    guard let url = fileURL(kind: kind) else { throw WidgetGroupStoreError.invalidKind }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    #if os(iOS)
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
      try data.write(to: url, options: [.atomic])
    #endif
  }

  func remove(kind: String) throws {
    guard let url = fileURL(kind: kind) else { throw WidgetGroupStoreError.invalidKind }
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    try FileManager.default.removeItem(at: url)
  }
}

/// Fixed messages: no path or container detail reaches JavaScript.
enum WidgetGroupStoreError: Error, LocalizedError {
  case invalidKind

  var errorDescription: String? {
    switch self {
    case .invalidKind:
      return "A widget kind is a short lowercase name."
    }
  }
}
