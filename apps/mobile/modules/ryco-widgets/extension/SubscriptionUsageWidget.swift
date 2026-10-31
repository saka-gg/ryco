import AppIntents
import SwiftUI
import WidgetKit

/// Home and Lock Screen widget: how much of each subscription's limits is left.
/// It renders the timeline the app wrote (`SubscriptionUsageContent`) and asks
/// for nothing itself; the app reloads it whenever the numbers change.
struct SubscriptionUsageWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: SubscriptionUsageContent.kind, intent: SubscriptionUsageIntent.self,
      provider: SubscriptionUsageTimelineProvider()
    ) { entry in
      SubscriptionUsageWidgetView(entry: entry)
    }
    .configurationDisplayName("Subscription usage")
    .description("How much of your Claude and Codex limits is left.")
    .supportedFamilies([
      .systemSmall, .systemMedium, .systemLarge, .systemExtraLarge, .accessoryRectangular,
    ])
  }
}

enum UsagePeriodOption: String, AppEnum {
  case both
  case session
  case weekly

  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Windows"
  static var caseDisplayRepresentations: [UsagePeriodOption: DisplayRepresentation] = [
    .both: "Session and weekly",
    .session: "Session",
    .weekly: "Weekly",
  ]

  var choice: UsagePeriodChoice { UsagePeriodChoice(rawValue: rawValue) ?? .both }
}

enum UsageAccountsOption: String, AppEnum {
  case pooled
  case each

  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Accounts"
  static var caseDisplayRepresentations: [UsageAccountsOption: DisplayRepresentation] = [
    .pooled: "Pooled",
    .each: "Each account",
  ]

  var choice: UsageAccountsChoice { UsageAccountsChoice(rawValue: rawValue) ?? .pooled }
}

struct SubscriptionUsageIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Subscription usage"
  static var description = IntentDescription("How much of your Claude and Codex limits is left.")

  @Parameter(title: "Claude", default: .both)
  var claudePeriod: UsagePeriodOption

  @Parameter(title: "Codex", default: .both)
  var codexPeriod: UsagePeriodOption

  @Parameter(title: "Accounts", default: .pooled)
  var accounts: UsageAccountsOption

  func period(for provider: String) -> UsagePeriodChoice {
    switch provider {
    case "claude": return claudePeriod.choice
    case "codex": return codexPeriod.choice
    default: return .both
    }
  }
}

struct SubscriptionUsageEntry: TimelineEntry {
  let date: Date
  /// Nil when the app wrote nothing: signed out, or never opened.
  let content: SubscriptionUsageContent?
  let configuration: SubscriptionUsageIntent
}

struct SubscriptionUsageTimelineProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> SubscriptionUsageEntry {
    SubscriptionUsageEntry(
      date: Date(), content: SubscriptionUsageContent.sample,
      configuration: SubscriptionUsageIntent())
  }

  func snapshot(for configuration: SubscriptionUsageIntent, in context: Context) async
    -> SubscriptionUsageEntry
  {
    let now = Date()
    if let current = Self.entries(configuration: configuration, now: now).first {
      return current
    }
    return SubscriptionUsageEntry(
      date: now, content: context.isPreview ? SubscriptionUsageContent.sample : nil,
      configuration: configuration)
  }

  func timeline(for configuration: SubscriptionUsageIntent, in context: Context) async -> Timeline<
    SubscriptionUsageEntry
  > {
    let now = Date()
    let entries = Self.entries(configuration: configuration, now: now)
    return Timeline(
      entries: entries.isEmpty
        ? [SubscriptionUsageEntry(date: now, content: nil, configuration: configuration)]
        : entries,
      policy: .never)
  }

  /// The app's entries from the one showing now on; it starts now.
  static func entries(configuration: SubscriptionUsageIntent, now: Date) -> [SubscriptionUsageEntry]
  {
    let written = WidgetTimelineStore.entries(
      kind: SubscriptionUsageContent.kind, as: SubscriptionUsageContent.self,
      store: WidgetGroupStore.fromMainBundle())
    guard !written.isEmpty else { return [] }
    let current = written.lastIndex { $0.date <= now } ?? 0
    return written[current...].enumerated().map { offset, entry in
      SubscriptionUsageEntry(
        date: offset == 0 ? min(entry.date, now) : entry.date, content: entry.content,
        configuration: configuration)
    }
  }
}

extension SubscriptionUsageContent {
  /// What the widget gallery shows before the app wrote anything.
  static let sample = SubscriptionUsageContent(
    url: "", observedAt: Date().timeIntervalSince1970 * 1000,
    providers: [
      Provider(
        provider: "claude", name: "Claude", fresh: true,
        pooled: View(
          detail: "Subscription remaining",
          rows: [
            Row(account: nil, label: "5h", kind: "session", remaining: 64, resetsAt: nil),
            Row(account: nil, label: "Weekly", kind: "weekly", remaining: 81, resetsAt: nil),
          ], total: 2),
        accounts: View(detail: "1 account", rows: [], total: 0)),
      Provider(
        provider: "codex", name: "Codex", fresh: true,
        pooled: View(
          detail: "Subscription remaining",
          rows: [
            Row(account: nil, label: "5h", kind: "session", remaining: 42, resetsAt: nil),
            Row(account: nil, label: "Weekly", kind: "weekly", remaining: 70, resetsAt: nil),
          ], total: 2),
        accounts: View(detail: "1 account", rows: [], total: 0)),
    ])
}

struct SubscriptionUsageWidgetView: View {
  let entry: SubscriptionUsageEntry

  @Environment(\.widgetFamily) private var family
  @Environment(\.widgetRenderingMode) private var renderingMode
  @Environment(\.colorScheme) private var colorScheme

  private var accessory: Bool { family == .accessoryRectangular }
  private var compact: Bool { family == .systemSmall || accessory }
  private var dense: Bool { family == .systemSmall || family == .systemMedium }
  private var limit: Int {
    switch family {
    case .systemExtraLarge: return 6
    case .systemLarge: return 4
    default: return 2
    }
  }
  private var providerLimit: Int { family == .systemExtraLarge ? 3 : 2 }
  private var monochrome: Bool { renderingMode != .fullColor }

  var body: some View {
    VStack(alignment: .leading, spacing: accessory || dense ? 2 : 6) {
      if let content = entry.content, !content.providers.isEmpty {
        let columns = content.providers.prefix(providerLimit).map { provider in
          provider.column(
            period: entry.configuration.period(for: provider.provider),
            accounts: entry.configuration.accounts.choice, limit: limit, compact: compact,
            single: accessory)
        }
        if compact {
          VStack(alignment: .leading, spacing: accessory || dense ? 4 : 8) {
            ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
              columnView(column)
            }
          }
        } else {
          HStack(alignment: .top, spacing: 16) {
            ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
              columnView(column)
            }
          }
        }
        if !accessory {
          Spacer(minLength: 0)
          footer(content)
        }
      } else {
        Text(
          entry.content == nil
            ? "Open Ryco to see your subscription limits." : "No subscription limits yet."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        if !accessory { Spacer(minLength: 0) }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
    .widgetURL(entry.content.flatMap { URL(string: $0.url) })
  }

  @ViewBuilder
  private func columnView(_ column: UsageColumn) -> some View {
    if accessory {
      VStack(alignment: .leading, spacing: 2) {
        let row = column.rows.first
        HStack(spacing: 4) {
          Text(row.map { "\(column.name) · \($0.title)" } ?? column.name)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
          Spacer(minLength: 2)
          Text(row.map { "\($0.remaining)% left" } ?? "Open Ryco")
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .layoutPriority(1)
        }
        if let row {
          ProgressView(value: Double(row.remaining), total: 100)
            .progressViewStyle(.linear)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(accessibilityText(column, row: column.rows.first))
    } else {
      VStack(alignment: .leading, spacing: dense ? 1 : compact ? 2 : 4) {
        Text(column.name)
          .font(compact ? .caption.weight(.bold) : .headline)
          .lineLimit(1)
        if !compact || column.rows.isEmpty {
          Text(column.detail)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        ForEach(Array(column.rows.enumerated()), id: \.offset) { _, row in
          rowView(row)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText(column, row: row))
        }
        if !compact && column.more > 0 {
          Text("\(column.more) more in Ryco")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func rowView(_ row: SubscriptionUsageContent.Row) -> some View {
    VStack(alignment: .leading, spacing: dense ? 1 : 2) {
      HStack(spacing: 4) {
        Text(row.title)
          .font(compact || dense ? .caption2 : .caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Spacer(minLength: 2)
        Text("\(row.remaining)% left")
          .font((compact || dense ? Font.caption2 : Font.caption).weight(.semibold))
          .foregroundStyle(remainingColor(row.remaining))
          .lineLimit(1)
          .layoutPriority(1)
      }
      ProgressView(value: Double(row.remaining), total: 100)
        .progressViewStyle(.linear)
        .tint(monochrome ? nil : barColor(row.remaining))
      if !compact, let reset = row.resetDate {
        Text("Resets \(reset.formatted(.dateTime.weekday(.abbreviated).hour().minute()))")
          .font(.system(size: 10))
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
  }

  private func footer(_ content: SubscriptionUsageContent) -> some View {
    Group {
      if content.observedAt > 0 {
        Text(
          "As of \(Date(timeIntervalSince1970: content.observedAt / 1000).formatted(date: .omitted, time: .shortened))"
        )
      } else {
        Text("Open Ryco to refresh")
      }
    }
    .font(.caption2)
    .foregroundStyle(.secondary)
    .lineLimit(1)
  }

  /// The phone's Limits thresholds: red at 10 % or less, amber at 25 % or less.
  private func remainingColor(_ remaining: Int) -> Color {
    guard !monochrome else { return .primary }
    if remaining <= 10 { return colorScheme == .dark ? Color(red: 0.99, green: 0.65, blue: 0.65) : .red }
    if remaining <= 25 { return colorScheme == .dark ? Color(red: 0.99, green: 0.83, blue: 0.30) : .orange }
    return .primary
  }

  private func barColor(_ remaining: Int) -> Color {
    if remaining <= 10 { return Color(red: 0.94, green: 0.27, blue: 0.27) }
    if remaining <= 25 { return Color(red: 0.96, green: 0.62, blue: 0.04) }
    return Color(red: 0.13, green: 0.77, blue: 0.37)
  }

  private func accessibilityText(_ column: UsageColumn, row: SubscriptionUsageContent.Row?) -> String {
    guard let row else { return "\(column.name). \(column.detail)." }
    return "\(column.name), \(row.title), \(row.remaining) percent left. \(column.detail)."
  }
}
