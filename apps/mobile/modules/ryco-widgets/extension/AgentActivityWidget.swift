import ActivityKit
import SwiftUI
import WidgetKit

/// The Lock Screen card and Dynamic Island for running agents. It shows the content state the
/// app last set (`AgentActivityAttributes`): a row per thread with its project, model, status and
/// how long it has been at it, what waits on the person first. The compact Island shows the most
/// urgent thread (`AgentGlance.lead`), and a tap opens it. Past its stale date, because Ryco was
/// suspended, unfinished rows read "Out of date" instead of guessing. A state with counts alone (a
/// push update, origin `remote`) shows the counts and opens the Inbox.
struct AgentActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: AgentActivityAttributes.self) { context in
      AgentActivityLockScreenView(state: context.state, stale: context.isStale)
        .widgetURL(AgentActivityLinks.lead(context.state))
    } dynamicIsland: { context in
      let state = context.state
      let stale = context.isStale
      let rows = state.rows ?? []
      let lead = AgentGlance.lead(rows)
      let leadPhase = AgentGlance.leadPhase(state.counts, rows: rows)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 6) {
            AgentGlanceGlyph(phase: leadPhase, stale: stale)
              .font(.title3)
            Text("\(AgentGlance.count(state.counts))")
              .font(.title3.weight(.semibold))
              .monospacedDigit()
              .foregroundStyle(AgentGlance.tint(leadPhase, stale: stale))
          }
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if let lead {
            AgentGlanceElapsed(row: lead, stale: stale)
              .font(.callout.weight(.medium))
              .multilineTextAlignment(.trailing)
              .frame(maxWidth: 76, alignment: .trailing)
              .padding(.trailing, 4)
          }
        }
        DynamicIslandExpandedRegion(.center) {
          Text(AgentGlance.header(state.counts, stale: stale))
            .font(.caption.weight(.semibold))
            .foregroundStyle(
              state.counts.needsYou > 0 && !stale ? Color.orange : Color.primary
            )
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(rows.prefix(3).enumerated()), id: \.offset) { _, row in
              AgentActivityLinkedRow(row: row) {
                AgentActivityCompactRow(row: row, stale: stale)
              }
            }
          }
          .padding(.horizontal, 4)
        }
      } compactLeading: {
        AgentGlanceGlyph(phase: leadPhase, stale: stale)
      } compactTrailing: {
        AgentActivityCompactTrailing(state: state, lead: lead, phase: leadPhase, stale: stale)
      } minimal: {
        AgentGlanceGlyph(phase: leadPhase, stale: stale)
      }
      .widgetURL(AgentActivityLinks.lead(state))
    }
  }
}

enum AgentActivityLinks {
  /// The most urgent thread, else the Inbox.
  static func lead(_ state: AgentActivityAttributes.ContentState) -> URL? {
    AgentGlance.url(AgentGlance.lead(state.rows ?? [])?.url) ?? AgentGlance.url(state.url)
  }
}

/// The compact Island's right side: the one word the person is asked for, a failure, or how long
/// the leading work has run.
struct AgentActivityCompactTrailing: View {
  let state: AgentActivityAttributes.ContentState
  let lead: AgentActivityAttributes.Row?
  let phase: String
  let stale: Bool

  var body: some View {
    Group {
      if stale {
        Image(systemName: "clock.badge.questionmark").foregroundStyle(.secondary)
      } else if AgentGlance.needsYou(phase) || phase == "failed" || lead == nil {
        Text(lead == nil ? "\(AgentGlance.count(state.counts))" : AgentGlance.shortLabel(phase))
          .font(.caption.weight(.semibold))
          .foregroundStyle(AgentGlance.tint(phase, stale: stale))
          .lineLimit(1)
          .minimumScaleFactor(0.7)
      } else if let lead {
        AgentGlanceElapsed(row: lead, stale: stale)
          .font(.caption.weight(.semibold))
          .foregroundStyle(AgentGlance.tint(phase, stale: stale))
          .multilineTextAlignment(.trailing)
          .frame(maxWidth: 52, alignment: .trailing)
      }
    }
    .padding(.trailing, 2)
  }
}

/// A row that opens its thread, where iOS lets a part of the card be its own link.
struct AgentActivityLinkedRow<Content: View>: View {
  let row: AgentActivityAttributes.Row
  @ViewBuilder let content: () -> Content

  var body: some View {
    if let url = AgentGlance.url(row.url) {
      Link(destination: url) { content() }
    } else {
      content()
    }
  }
}

/// One line per thread, for the expanded Island.
struct AgentActivityCompactRow: View {
  let row: AgentActivityAttributes.Row
  let stale: Bool

  var body: some View {
    HStack(spacing: 6) {
      AgentGlanceGlyph(phase: row.phase, stale: stale)
        .font(.caption)
      Text(row.title)
        .font(.caption.weight(.semibold))
        .lineLimit(1)
      if let model = row.model {
        Text(model)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 6)
      Text(AgentGlance.status(row, stale: stale))
        .font(.caption2.weight(.semibold))
        .foregroundStyle(AgentGlance.tint(row.phase, stale: stale))
        .lineLimit(1)
        .layoutPriority(1)
    }
  }
}

/// Two lines per thread for the Lock Screen: title and status, then project · model and time.
/// A thread that waits on the person sits on an amber tint, so it reads before the rest.
struct AgentActivityLockScreenRow: View {
  let row: AgentActivityAttributes.Row
  let stale: Bool

  var body: some View {
    let attention = AgentGlance.needsYou(row.phase) && !stale
    HStack(spacing: 8) {
      AgentGlanceGlyph(phase: row.phase, stale: stale)
        .font(.footnote)
      VStack(alignment: .leading, spacing: 1) {
        Text(row.title)
          .font(.footnote.weight(.semibold))
          .lineLimit(1)
        if let detail = AgentGlance.detail(row) {
          Text(detail)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 6)
      VStack(alignment: .trailing, spacing: 1) {
        Text(AgentGlance.status(row, stale: stale))
          .font(.caption2.weight(.semibold))
          .foregroundStyle(AgentGlance.tint(row.phase, stale: stale))
          .lineLimit(1)
        AgentGlanceElapsed(row: row, stale: stale)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.trailing)
          .frame(maxWidth: 64, alignment: .trailing)
      }
      .layoutPriority(1)
    }
    .padding(.vertical, attention ? 4 : 0)
    .padding(.horizontal, attention ? 6 : 0)
    .background {
      if attention {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Color.orange.opacity(0.16))
      }
    }
  }
}

struct AgentActivityLockScreenView: View {
  let state: AgentActivityAttributes.ContentState
  let stale: Bool

  /// The Lock Screen gives a Live Activity 160 points: three two-line rows and the header.
  private static let maxRows = 3

  var body: some View {
    let rows = state.rows ?? []
    let shown = Array(rows.prefix(Self.maxRows))
    let total = state.counts.running + state.counts.needsYou + state.counts.failed
      + state.counts.done
    let hidden = max(0, total - shown.count)
    let leadPhase = AgentGlance.leadPhase(state.counts, rows: rows)
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        AgentGlanceGlyph(phase: leadPhase, stale: stale)
          .font(.subheadline)
        Text(AgentGlance.header(state.counts, stale: stale))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(state.counts.needsYou > 0 && !stale ? Color.orange : Color.primary)
          .lineLimit(1)
        Spacer(minLength: 0)
        Text(hidden > 0 && !shown.isEmpty ? "+\(hidden) more" : "Ryco")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      ForEach(Array(shown.enumerated()), id: \.offset) { _, row in
        AgentActivityLinkedRow(row: row) {
          AgentActivityLockScreenRow(row: row, stale: stale)
        }
      }
    }
    .padding(12)
  }
}
