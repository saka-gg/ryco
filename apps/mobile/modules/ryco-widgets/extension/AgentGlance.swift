import SwiftUI
import WidgetKit

/// What the agent Live Activity and the agent widget share: the words, glyphs and tints of a
/// phase, which thread leads, and the elapsed time. Rows come from the app
/// (`src/liveActivity/agentActivityModel.ts`); a state with counts alone (a push update, origin
/// `remote`) has none and still reads right.
enum AgentGlance {
  static let needsYouPhases: Set<String> = ["approval", "input", "plan"]

  static func needsYou(_ phase: String) -> Bool { needsYouPhases.contains(phase) }

  static func finished(_ phase: String) -> Bool { phase == "failed" || phase == "done" }

  /// Which row leads the compact views: what waits on the person, then a failure, then work,
  /// then a result. Rows arrive in the Inbox's order, so the first of each kind wins.
  static func lead(_ rows: [AgentActivityContentState.Row]) -> AgentActivityContentState.Row? {
    rows.first { needsYou($0.phase) }
      ?? rows.first { $0.phase == "failed" }
      ?? rows.first { $0.phase == "running" || $0.phase == "connecting" }
      ?? rows.first
  }

  /// The phase the compact glyph stands for, also from counts alone.
  static func leadPhase(_ counts: AgentActivityContentState.Counts, rows: [AgentActivityContentState.Row]) -> String {
    if let lead = lead(rows) { return lead.phase }
    if counts.needsYou > 0 { return "input" }
    if counts.failed > 0 { return "failed" }
    if counts.running > 0 { return "running" }
    return "done"
  }

  /// The header: what waits on the person first, then what runs; results once nothing does.
  static func header(_ counts: AgentActivityContentState.Counts, stale: Bool) -> String {
    if stale { return "Agent status out of date · open Ryco" }
    var parts: [String] = []
    if counts.needsYou > 0 { parts.append("\(counts.needsYou) need\(counts.needsYou == 1 ? "s" : "") you") }
    if counts.running > 0 { parts.append("\(counts.running) running") }
    if parts.isEmpty {
      if counts.failed > 0 { parts.append("\(counts.failed) failed") }
      if counts.done > 0 { parts.append("\(counts.done) done") }
    }
    return parts.isEmpty ? "No agents running" : parts.joined(separator: " · ")
  }

  /// The number beside the glyph: what waits on the person, else what runs, else results.
  static func count(_ counts: AgentActivityContentState.Counts) -> Int {
    if counts.needsYou > 0 { return counts.needsYou }
    if counts.running > 0 { return counts.running }
    return counts.failed + counts.done
  }

  /// A row's words. The app sends them; a state from an earlier app version falls back to these.
  static func status(_ row: AgentActivityContentState.Row, stale: Bool) -> String {
    if stale && !finished(row.phase) { return "Out of date" }
    if let status = row.status, !status.isEmpty { return status }
    return phaseLabel(row.phase)
  }

  static func phaseLabel(_ phase: String) -> String {
    switch phase {
    case "approval": return "Needs approval"
    case "input": return "Needs your answer"
    case "plan": return "Plan ready"
    case "running": return "Working"
    case "connecting": return "Connecting"
    case "failed": return "Failed"
    default: return "Done"
    }
  }

  /// One word for the compact Dynamic Island: what the person is asked to do.
  static func shortLabel(_ phase: String) -> String {
    switch phase {
    case "approval": return "Approve"
    case "input": return "Answer"
    case "plan": return "Plan"
    case "failed": return "Failed"
    case "done": return "Done"
    default: return "Working"
    }
  }

  static func symbol(_ phase: String, stale: Bool) -> String {
    if stale && !finished(phase) { return "clock.badge.questionmark" }
    switch phase {
    case "approval": return "exclamationmark.shield.fill"
    case "input": return "questionmark.bubble.fill"
    case "plan": return "list.bullet.clipboard.fill"
    case "failed": return "xmark.octagon.fill"
    case "running", "connecting": return "circle.dotted.circle"
    default: return "checkmark.circle.fill"
    }
  }

  /// T3's phase tints: attention amber, failure red, work blue, done green.
  static func tint(_ phase: String, stale: Bool) -> Color {
    if stale && !finished(phase) { return .secondary }
    switch phase {
    case "approval", "input", "plan": return .orange
    case "failed": return .red
    case "running", "connecting": return .blue
    default: return .green
    }
  }

  /// The project and the model, the row's second line.
  static func detail(_ row: AgentActivityContentState.Row) -> String? {
    let parts = [row.project, row.model].compactMap { value -> String? in
      guard let value, !value.isEmpty else { return nil }
      return value
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  static func since(_ row: AgentActivityContentState.Row) -> Date? {
    guard let since = row.since, since > 0 else { return nil }
    return Date(timeIntervalSince1970: since / 1000)
  }

  static func url(_ text: String?) -> URL? { text.flatMap(URL.init(string:)) }
}

/// A phase's glyph, tinted in full color and plain where iOS renders it accented or vibrant.
struct AgentGlanceGlyph: View {
  let phase: String
  let stale: Bool

  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    Image(systemName: AgentGlance.symbol(phase, stale: stale))
      .foregroundStyle(
        renderingMode == .fullColor ? AnyShapeStyle(AgentGlance.tint(phase, stale: stale))
          : AnyShapeStyle(.primary)
      )
      .widgetAccentable()
  }
}

/// How long a row has been in its phase: a running count for work and for what waits on the
/// person, the time a result came. Nothing while the card is out of date or the time unknown.
struct AgentGlanceElapsed: View {
  let row: AgentActivityContentState.Row
  let stale: Bool

  var body: some View {
    if let since = AgentGlance.since(row), !(stale && !AgentGlance.finished(row.phase)) {
      if AgentGlance.finished(row.phase) {
        Text(since, style: .time)
      } else {
        // Counts up from `since`, and keeps counting while Ryco is suspended.
        Text(timerInterval: since...Date.distantFuture, countsDown: false, showsHours: true)
          .monospacedDigit()
      }
    }
  }
}
