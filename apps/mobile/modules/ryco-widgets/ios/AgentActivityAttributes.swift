import ActivityKit
import Foundation

/// The Live Activity for running agents (`src/liveActivity`), compiled into
/// both the app's module and the widget extension.
///
/// The attributes carry only a version: whatever a card shows lives in its
/// content state (`AgentActivityContentState`), which every update replaces.
/// Rows (titles, projects, links) exist only in the app's own local updates; a
/// state with counts alone opens the Inbox. The app keeps the encoded state
/// under ActivityKit's 4 KB limit, and the module trims it again as Swift
/// encodes it.
struct AgentActivityAttributes: ActivityAttributes {
  typealias ContentState = AgentActivityContentState
  typealias Counts = AgentActivityContentState.Counts
  typealias Row = AgentActivityContentState.Row

  let v: Int
}
