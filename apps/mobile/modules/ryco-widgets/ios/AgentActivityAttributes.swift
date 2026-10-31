import ActivityKit
import Foundation

/// The Live Activity for running agents (`src/liveActivity`), compiled into
/// both the app's module and the widget extension.
///
/// The attributes carry only a version: whatever a card shows lives in its
/// content state, which every update replaces. Rows (titles, projects, links)
/// exist only in the app's own local updates; a state with counts alone opens
/// the Inbox. The app keeps the encoded state under ActivityKit's 4 KB limit.
struct AgentActivityAttributes: ActivityAttributes {
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

  struct ContentState: Codable, Hashable {
    let v: Int
    /// `local` (the app's own update) or `remote` (a later phase: counts only).
    let origin: String
    let counts: Counts
    let rows: [Row]?
    /// Opens the Inbox.
    let url: String
    /// When the app built this state, epoch ms.
    let updatedAt: Double
  }

  let v: Int
}
