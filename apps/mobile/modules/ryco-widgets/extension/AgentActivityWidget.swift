import ActivityKit
import SwiftUI
import WidgetKit

/// The Lock Screen card and Dynamic Island for running agents. It shows the
/// content state the app last set (`AgentActivityAttributes`); once that is
/// past its stale date, because Ryco was suspended, unfinished rows read
/// "Out of date" instead of guessing.
struct AgentActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: AgentActivityAttributes.self) { context in
      AgentActivityLockScreenView(state: context.state, stale: context.isStale)
        .widgetURL(URL(string: context.state.url))
    } dynamicIsland: { context in
      let state = context.state
      let stale = context.isStale
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          AgentActivityGlyph(phase: AgentActivitySummaryText.leadPhase(state), stale: stale)
            .font(.title3)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(AgentActivitySummaryText.count(state))
            .font(.title3.weight(.semibold))
            .monospacedDigit()
        }
        DynamicIslandExpandedRegion(.center) {
          Text(AgentActivitySummaryText.header(state, stale: stale))
            .font(.caption.weight(.semibold))
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          AgentActivityRows(state: state, stale: stale, limit: 3)
        }
      } compactLeading: {
        AgentActivityGlyph(phase: AgentActivitySummaryText.leadPhase(state), stale: stale)
      } compactTrailing: {
        Text(AgentActivitySummaryText.count(state))
          .monospacedDigit()
      } minimal: {
        if state.counts.needsYou > 0 || state.counts.failed > 0 {
          AgentActivityGlyph(phase: AgentActivitySummaryText.leadPhase(state), stale: stale)
        } else {
          Text(AgentActivitySummaryText.count(state))
            .monospacedDigit()
        }
      }
      .widgetURL(URL(string: state.url))
    }
  }
}

/// The words and the leading phase both surfaces share.
enum AgentActivitySummaryText {
  /// What the compact glyph stands for: attention, then failure, then running, then done.
  static func leadPhase(_ state: AgentActivityAttributes.ContentState) -> String {
    if state.counts.needsYou > 0 {
      return state.rows?.first { ["approval", "input", "plan"].contains($0.phase) }?.phase
        ?? "input"
    }
    if state.counts.failed > 0 { return "failed" }
    if state.counts.running > 0 { return "running" }
    return "done"
  }

  /// The number in the compact and minimal views: what waits on the person, else what runs.
  static func count(_ state: AgentActivityAttributes.ContentState) -> String {
    let counts = state.counts
    if counts.needsYou > 0 { return "\(counts.needsYou)" }
    if counts.running > 0 { return "\(counts.running)" }
    return "\(counts.failed + counts.done)"
  }

  static func header(_ state: AgentActivityAttributes.ContentState, stale: Bool) -> String {
    if stale { return "Agent status out of date · open Ryco" }
    let counts = state.counts
    var parts: [String] = []
    if counts.running > 0 { parts.append("\(counts.running) running") }
    if counts.needsYou > 0 { parts.append("\(counts.needsYou) need\(counts.needsYou == 1 ? "s" : "") you") }
    if parts.isEmpty {
      if counts.failed > 0 { parts.append("\(counts.failed) failed") }
      if counts.done > 0 { parts.append("\(counts.done) done") }
    }
    return parts.isEmpty ? "No agents running" : parts.joined(separator: " · ")
  }

  static func phaseLabel(_ phase: String, stale: Bool) -> String {
    let finished = phase == "failed" || phase == "done"
    if stale && !finished { return "Out of date" }
    switch phase {
    case "approval": return "Needs approval"
    case "input": return "Needs input"
    case "plan": return "Plan ready"
    case "running": return "Running"
    case "connecting": return "Connecting"
    case "failed": return "Failed"
    default: return "Done"
    }
  }
}

struct AgentActivityGlyph: View {
  let phase: String
  let stale: Bool

  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    Image(systemName: symbol)
      .foregroundStyle(renderingMode == .fullColor ? tint : .primary)
      .widgetAccentable()
  }

  private var symbol: String {
    if stale { return "clock.badge.questionmark" }
    switch phase {
    case "approval", "input", "plan": return "exclamationmark.bubble.fill"
    case "failed": return "xmark.octagon.fill"
    case "running", "connecting": return "circle.dotted.circle"
    default: return "checkmark.circle.fill"
    }
  }

  /// T3's phase tints: attention amber, failure red, work blue, done green.
  private var tint: Color {
    if stale { return .secondary }
    switch phase {
    case "approval", "input", "plan": return .orange
    case "failed": return .red
    case "running", "connecting": return .blue
    default: return .green
    }
  }
}

struct AgentActivityRows: View {
  let state: AgentActivityAttributes.ContentState
  let stale: Bool
  let limit: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array((state.rows ?? []).prefix(limit).enumerated()), id: \.offset) { _, row in
        if let url = URL(string: row.url) {
          Link(destination: url) { rowView(row) }
        } else {
          rowView(row)
        }
      }
    }
  }

  private func rowView(_ row: AgentActivityAttributes.Row) -> some View {
    HStack(spacing: 6) {
      AgentActivityGlyph(phase: row.phase, stale: stale)
        .font(.caption)
      VStack(alignment: .leading, spacing: 0) {
        Text(row.title)
          .font(.caption.weight(.semibold))
          .lineLimit(1)
        if let project = row.project {
          Text(project)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 4)
      Text(AgentActivitySummaryText.phaseLabel(row.phase, stale: stale))
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
  }
}

struct AgentActivityLockScreenView: View {
  let state: AgentActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        AgentActivityGlyph(phase: AgentActivitySummaryText.leadPhase(state), stale: stale)
        Text(AgentActivitySummaryText.header(state, stale: stale))
          .font(.subheadline.weight(.semibold))
          .lineLimit(1)
        Spacer(minLength: 0)
        Text("Ryco")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      AgentActivityRows(state: state, stale: stale, limit: 5)
    }
    .padding(14)
  }
}
