import ExpoModulesCore
import Foundation
import WidgetKit

/// Widget timelines (`src/widgets`).
///
/// JavaScript computes every timeline and hands it over as JSON; this module
/// writes it into the App Group and asks WidgetKit to reload that kind. The
/// widget extension renders what it finds there and never reaches a node.
public final class RycoWidgetsModule: Module {
  /// The extension the config plugin embeds; without it nothing would read a timeline.
  private static let extensionName = "RycoWidgets.appex"
  /// Far above any timeline the app writes; anything bigger is a bug, not a widget.
  private static let maxTimelineBytes = 256 * 1024

  public func definition() -> ModuleDefinition {
    Name("RycoWidgets")

    Function("isAvailable") { () -> Bool in
      Self.store() != nil && Self.extensionEmbedded()
    }

    AsyncFunction("writeTimeline") { (kind: String, json: String) throws -> Void in
      let store = try Self.requireStore()
      let data = Data(json.utf8)
      guard data.count <= Self.maxTimelineBytes,
        (try? JSONSerialization.jsonObject(with: data)) is [String: Any]
      else { throw WidgetsModuleError.invalidTimeline }
      try store.write(kind: kind, data: data)
      WidgetCenter.shared.reloadTimelines(ofKind: kind)
    }

    AsyncFunction("clear") { (kind: String) throws -> Void in
      try Self.requireStore().remove(kind: kind)
      WidgetCenter.shared.reloadTimelines(ofKind: kind)
    }
  }

  private static func store() -> WidgetGroupStore? {
    WidgetGroupStore.fromMainBundle()
  }

  private static func requireStore() throws -> WidgetGroupStore {
    guard let store = store(), extensionEmbedded() else { throw WidgetsModuleError.unavailable }
    return store
  }

  private static func extensionEmbedded() -> Bool {
    guard let plugins = Bundle.main.builtInPlugInsURL else { return false }
    return FileManager.default.fileExists(
      atPath: plugins.appendingPathComponent(extensionName).path)
  }
}

/// Fixed messages: no path or container detail reaches JavaScript.
private enum WidgetsModuleError: Error, LocalizedError {
  case unavailable
  case invalidTimeline

  var errorDescription: String? {
    switch self {
    case .unavailable:
      return "This build has no widgets."
    case .invalidTimeline:
      return "The widget timeline is not a JSON object of a sensible size."
    }
  }
}
