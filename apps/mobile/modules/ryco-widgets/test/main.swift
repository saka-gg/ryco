// The harness `widgetExtension.test.ts` compiles with `WidgetGroupStore.swift`,
// `WidgetTimelineStore.swift` and `SubscriptionUsageContent.swift` for the Mac.
// It reads timelines the app's TypeScript encoded the way the widget extension
// does, and prints what it found as JSON for the test to check.
import Foundation

struct Label: Decodable {
  let label: String
}

let arguments = CommandLine.arguments
let directory = URL(fileURLWithPath: arguments[1], isDirectory: true)
let timeline = try Data(contentsOf: URL(fileURLWithPath: arguments[2]))
let store = WidgetGroupStore(directory: directory)

func labels(_ kind: String) -> [[String: Any]] {
  WidgetTimelineStore.entries(kind: kind, as: Label.self, store: store).map { entry in
    ["at": entry.at, "seconds": entry.date.timeIntervalSince1970, "label": entry.content.label]
  }
}

var output: [String: Any] = [:]
output["beforeWrite"] = labels("test-kind")
try store.write(kind: "test-kind", data: timeline)
output["written"] = labels("test-kind")
output["file"] = store.fileURL(kind: "test-kind")?.lastPathComponent ?? NSNull()

let rejectedKinds = ["", "../test-kind", "a/b", "Test", "test.json", String(repeating: "x", count: 65)]
output["rejectedKinds"] = rejectedKinds.map { kind -> Bool in
  guard !WidgetGroupStore.isValidKind(kind), store.fileURL(kind: kind) == nil else { return false }
  do {
    try store.write(kind: kind, data: timeline)
    return false
  } catch {
    return true
  }
}

try store.write(kind: "other-version", data: Data(#"{"v":2,"entries":[{"at":1,"content":{"label":"x"}}]}"#.utf8))
output["otherVersion"] = labels("other-version")
try store.write(kind: "not-json", data: Data("{".utf8))
output["notJson"] = labels("not-json")

try store.remove(kind: "test-kind")
try store.remove(kind: "test-kind")
output["afterRemove"] = labels("test-kind")

// The subscription usage timeline, and what its first entry shows per setting.
try store.write(
  kind: SubscriptionUsageContent.kind, data: try Data(contentsOf: URL(fileURLWithPath: arguments[3])))
let usage = WidgetTimelineStore.entries(
  kind: SubscriptionUsageContent.kind, as: SubscriptionUsageContent.self, store: store)
output["usageEntries"] = usage.map { entry in
  ["at": entry.at, "fresh": entry.content.providers.map { $0.fresh }] as [String: Any]
}
let settings: [(String, UsagePeriodChoice, UsageAccountsChoice, Int, Bool, Bool)] = [
  ("medium", .both, .pooled, 2, false, false),
  ("large", .both, .pooled, 4, false, false),
  ("small", .both, .pooled, 2, true, false),
  ("lockScreen", .both, .pooled, 2, true, true),
  ("weeklyOnly", .weekly, .pooled, 4, false, false),
  ("eachAccount", .both, .each, 4, false, false),
]
var columns: [String: Any] = [:]
for (name, period, accounts, limit, compact, single) in settings {
  columns[name] = usage.first?.content.providers.map { provider -> [String: Any] in
    let column = provider.column(
      period: period, accounts: accounts, limit: limit, compact: compact, single: single)
    return [
      "name": column.name, "detail": column.detail, "rows": column.rows.map { $0.title },
      "more": column.more,
    ]
  }
}
output["usageColumns"] = columns
output["usageAfterExpiry"] = usage.last.map { entry in
  entry.content.providers.map { provider -> [String: Any] in
    let column = provider.column(
      period: .both, accounts: .pooled, limit: 4, compact: false, single: false)
    return ["detail": column.detail, "rows": column.rows.count, "more": column.more]
  }
}

output["tapToRefresh"] = SubscriptionUsageContent.tapToRefresh

let json = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: json, as: UTF8.self))
