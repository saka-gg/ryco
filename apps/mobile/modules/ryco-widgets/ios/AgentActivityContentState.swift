import Foundation

/// What the agent Live Activity shows (`src/liveActivity/agentActivityModel.ts`):
/// `AgentActivityAttributes.ContentState`. Foundation only, so the Mac test
/// harness can check its encoded size.
struct AgentActivityContentState: Codable, Hashable {
  /// ActivityKit refuses a content state whose encoding is over 4 KB.
  static let maxEncodedBytes = 4096

  struct Counts: Codable, Hashable {
    let running: Int
    let needsYou: Int
    let failed: Int
    let done: Int
  }

  struct Row: Codable, Hashable {
    let title: String
    let project: String?
    /// `approval`, `input`, `plan`, `running`, `connecting`, `failed` or `done`.
    let phase: String
    /// Opens the thread.
    let url: String
  }

  let v: Int
  /// `local` (the app's own update) or `remote` (a later phase: counts only).
  let origin: String
  let counts: Counts
  let rows: [Row]?
  /// Opens the Inbox.
  let url: String
  /// When the app built this state, epoch ms.
  let updatedAt: Double

  /// Its size as Swift encodes it, which is not JavaScript's: `JSONEncoder`
  /// escapes every slash, and every link has several.
  var encodedBytes: Int? { try? JSONEncoder().encode(self).count }

  /// This state within ActivityKit's limit: rows go from the end, the counts
  /// stay. Nil when even no rows would fit.
  func fitted() -> AgentActivityContentState? {
    var kept = rows
    while true {
      let state = AgentActivityContentState(
        v: v, origin: origin, counts: counts, rows: kept, url: url, updatedAt: updatedAt)
      if let size = state.encodedBytes, size <= Self.maxEncodedBytes { return state }
      guard let current = kept, !current.isEmpty else { return nil }
      kept = Array(current.dropLast())
    }
  }
}
