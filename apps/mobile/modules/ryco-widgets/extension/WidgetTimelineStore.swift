import Foundation

/// The timeline file the app writes for one widget kind
/// (`src/widgets/widgetTimeline.ts`): `{ "v": 1, "entries": [{ "at": <ms>, "content": … }] }`.
/// Each entry is shown from `at` on, until the next one starts.
struct WidgetTimelineFile<Content: Decodable>: Decodable {
  struct Entry: Decodable {
    let at: Double
    let content: Content

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
  }

  let v: Int
  let entries: [Entry]
}

enum WidgetTimelineStore {
  /// The file format this extension reads; the app writes the same number.
  static let version = 1

  /// The entries the app last wrote for `kind`, in time order. None when it
  /// wrote nothing, wrote another version, or the file does not decode: the
  /// widget then shows its "open Ryco" state instead of guessing.
  static func entries<Content: Decodable>(
    kind: String, as content: Content.Type, store: WidgetGroupStore?
  ) -> [WidgetTimelineFile<Content>.Entry] {
    guard let data = store?.read(kind: kind),
      let file = try? JSONDecoder().decode(WidgetTimelineFile<Content>.self, from: data),
      file.v == version
    else { return [] }
    return file.entries.sorted { $0.at < $1.at }
  }
}
