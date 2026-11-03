// The harness `widgetExtension.test.ts` compiles this with
// `ios/AgentActivityContentState.swift` for the Mac. It reads Live Activity
// states the app's TypeScript encoded, and prints their size as Swift encodes
// them and what `fitted()` keeps, as JSON for the test to check.
import Foundation

let states = try JSONDecoder().decode(
  [String].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let results = try states.map { json -> [String: Any] in
  let state = try JSONDecoder().decode(AgentActivityContentState.self, from: Data(json.utf8))
  let fitted = state.fitted()
  return [
    "rows": state.rows?.count ?? 0,
    "swiftBytes": state.encodedBytes ?? -1,
    "fittedRows": fitted.map { $0.rows?.count ?? 0 } ?? -1,
    "fittedBytes": fitted?.encodedBytes ?? -1,
    "fittedRunning": fitted?.counts.running ?? -1,
  ]
}
let json = try JSONSerialization.data(
  withJSONObject: ["maxBytes": AgentActivityContentState.maxEncodedBytes, "states": results],
  options: [.sortedKeys])
print(String(decoding: json, as: UTF8.self))
