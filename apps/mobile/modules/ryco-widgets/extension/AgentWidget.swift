import SwiftUI
import WidgetKit

/// What the app writes for the agent widget (`src/widgets/agentWidgetTimeline.ts`): the Live
/// Activity's own state, and whether this entry is past its stale date.
struct AgentWidgetContent: Decodable {
  static let kind = "agent-activity"

  let state: AgentActivityContentState
  let stale: Bool

  static let sample = AgentWidgetContent(
    state: AgentActivityContentState(
      v: 1, origin: "local",
      counts: .init(running: 2, needsYou: 1, failed: 0, done: 0),
      rows: [
        .init(
          title: "Fix the login race", project: "web", model: "Opus 5.5", phase: "approval",
          status: "Needs approval", since: Date().addingTimeInterval(-95).timeIntervalSince1970 * 1000,
          url: ""),
        .init(
          title: "Migrate the queue", project: "server", model: "GPT-5.6", phase: "running",
          status: "Working", since: Date().addingTimeInterval(-640).timeIntervalSince1970 * 1000,
          url: ""),
        .init(
          title: "Docs pass", project: "docs", model: nil, phase: "running", status: "Working",
          since: Date().addingTimeInterval(-60).timeIntervalSince1970 * 1000, url: ""),
      ],
      url: "", updatedAt: Date().timeIntervalSince1970 * 1000),
    stale: false)
}

/// Home Screen (small, medium) and Lock Screen (rectangular, inline) widget: the threads that
/// run and those that need you, what waits on you first. It renders the timeline the app wrote
/// and asks for nothing itself. Thread titles are privacy sensitive: a locked phone that hides
/// widget data shows them redacted.
struct AgentWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: AgentWidgetContent.kind, provider: AgentWidgetTimelineProvider()) {
      entry in
      AgentWidgetView(entry: entry)
    }
    .configurationDisplayName("Agents")
    .description("Running tasks and the ones that need you.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
  }
}

struct AgentWidgetEntry: TimelineEntry {
  let date: Date
  /// Nil when the app wrote nothing: signed out, or never opened since the widget was added.
  let content: AgentWidgetContent?
}

struct AgentWidgetTimelineProvider: TimelineProvider {
  func placeholder(in context: Context) -> AgentWidgetEntry {
    AgentWidgetEntry(date: Date(), content: .sample)
  }

  func getSnapshot(in context: Context, completion: @escaping (AgentWidgetEntry) -> Void) {
    let now = Date()
    completion(
      Self.entries(now: now).first
        ?? AgentWidgetEntry(date: now, content: context.isPreview ? .sample : nil))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<AgentWidgetEntry>) -> Void) {
    let now = Date()
    let entries = Self.entries(now: now)
    completion(
      Timeline(
        entries: entries.isEmpty ? [AgentWidgetEntry(date: now, content: nil)] : entries,
        policy: .never))
  }

  /// The app's entries from the one showing now on; it starts now.
  static func entries(now: Date) -> [AgentWidgetEntry] {
    let written = WidgetTimelineStore.entries(
      kind: AgentWidgetContent.kind, as: AgentWidgetContent.self,
      store: WidgetGroupStore.fromMainBundle())
    guard !written.isEmpty else { return [] }
    let current = written.lastIndex { $0.date <= now } ?? 0
    return written[current...].enumerated().map { offset, entry in
      AgentWidgetEntry(date: offset == 0 ? now : entry.date, content: entry.content)
    }
  }
}

struct AgentWidgetView: View {
  let entry: AgentWidgetEntry

  @Environment(\.widgetFamily) private var family

  var body: some View {
    content
      .widgetURL(entry.content.flatMap { AgentActivityLinks.lead($0.state) })
      .containerBackground(for: .widget) { Color.clear }
  }

  @ViewBuilder private var content: some View {
    if let content = entry.content {
      switch family {
      case .accessoryInline: AgentWidgetInline(content: content)
      case .accessoryRectangular: AgentWidgetRectangular(content: content)
      case .systemMedium: AgentWidgetMedium(content: content)
      default: AgentWidgetSmall(content: content)
      }
    } else {
      AgentWidgetEmpty(family: family)
    }
  }
}

/// Before the app wrote anything (or after sign-out).
struct AgentWidgetEmpty: View {
  let family: WidgetFamily

  var body: some View {
    switch family {
    case .accessoryInline:
      Label("Open Ryco", systemImage: "circle.dotted.circle")
    case .accessoryRectangular:
      VStack(alignment: .leading, spacing: 2) {
        Label("Agents", systemImage: "circle.dotted.circle").font(.headline)
        Text("Open Ryco to see your tasks.").font(.caption)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    default:
      VStack(alignment: .leading, spacing: 6) {
        Image(systemName: "circle.dotted.circle").font(.title2).foregroundStyle(.secondary)
        Spacer(minLength: 0)
        Text("Agents").font(.headline)
        Text("Open Ryco to see your tasks.").font(.caption).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
  }
}

/// The header both Home Screen sizes share: the lead glyph, the count, and what it counts.
struct AgentWidgetHeader: View {
  let content: AgentWidgetContent

  var body: some View {
    let state = content.state
    let phase = AgentGlance.leadPhase(state.counts, rows: state.rows ?? [])
    HStack(alignment: .firstTextBaseline, spacing: 5) {
      AgentGlanceGlyph(phase: phase, stale: content.stale)
        .font(.footnote)
      Text(AgentGlance.header(state.counts, stale: content.stale))
        .font(.caption.weight(.semibold))
        .foregroundStyle(
          state.counts.needsYou > 0 && !content.stale ? Color.orange : Color.secondary
        )
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
  }
}

/// Small: the most urgent thread, large, with its status and time.
struct AgentWidgetSmall: View {
  let content: AgentWidgetContent

  var body: some View {
    let rows = content.state.rows ?? []
    VStack(alignment: .leading, spacing: 4) {
      AgentWidgetHeader(content: content)
      Spacer(minLength: 0)
      if let lead = AgentGlance.lead(rows) {
        Text(lead.title)
          .font(.subheadline.weight(.semibold))
          .lineLimit(3)
          .privacySensitive()
        if let detail = AgentGlance.detail(lead) {
          Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        HStack(spacing: 4) {
          Text(AgentGlance.status(lead, stale: content.stale))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(AgentGlance.tint(lead.phase, stale: content.stale))
            .lineLimit(1)
          Spacer(minLength: 2)
          AgentGlanceElapsed(row: lead, stale: content.stale)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 52, alignment: .trailing)
        }
      } else {
        Text(content.state.counts.running + content.state.counts.needsYou > 0
          ? "Open Ryco for details" : "All quiet")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

/// Medium: up to three threads, each opening its own.
struct AgentWidgetMedium: View {
  let content: AgentWidgetContent

  var body: some View {
    let rows = content.state.rows ?? []
    VStack(alignment: .leading, spacing: 6) {
      AgentWidgetHeader(content: content)
      if rows.isEmpty {
        Spacer(minLength: 0)
        Text(content.state.counts.running + content.state.counts.needsYou > 0
          ? "Open Ryco for details" : "All quiet")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.secondary)
        Spacer(minLength: 0)
      } else {
        ForEach(Array(rows.prefix(3).enumerated()), id: \.offset) { _, row in
          AgentActivityLinkedRow(row: row) {
            AgentActivityLockScreenRow(row: row, stale: content.stale)
              .privacySensitive()
          }
        }
        Spacer(minLength: 0)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

/// Lock Screen rectangle: the count line, the most urgent thread, its status and time.
struct AgentWidgetRectangular: View {
  let content: AgentWidgetContent

  var body: some View {
    let state = content.state
    let rows = state.rows ?? []
    let phase = AgentGlance.leadPhase(state.counts, rows: rows)
    VStack(alignment: .leading, spacing: 1) {
      HStack(spacing: 4) {
        AgentGlanceGlyph(phase: phase, stale: content.stale)
        Text(AgentGlance.header(state.counts, stale: content.stale))
          .font(.headline)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
      }
      if let lead = AgentGlance.lead(rows) {
        Text(lead.title)
          .font(.caption)
          .lineLimit(1)
          .privacySensitive()
        HStack(spacing: 4) {
          Text(AgentGlance.status(lead, stale: content.stale))
          AgentGlanceElapsed(row: lead, stale: content.stale)
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Lock Screen line above the clock: the glyph and the count line.
struct AgentWidgetInline: View {
  let content: AgentWidgetContent

  var body: some View {
    let state = content.state
    Label(
      AgentGlance.header(state.counts, stale: content.stale),
      systemImage: AgentGlance.symbol(
        AgentGlance.leadPhase(state.counts, rows: state.rows ?? []), stale: content.stale))
  }
}
