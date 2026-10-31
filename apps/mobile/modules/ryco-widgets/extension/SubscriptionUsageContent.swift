import Foundation

/// One timeline entry of the subscription usage widget, as the app wrote it
/// (`src/widgets/subscriptionUsageSnapshot.ts`). Percentages, reset times,
/// plans and account names that are not email-like; nothing else.
struct SubscriptionUsageContent: Decodable {
  static let kind = "subscription-usage"
  /// What a provider without a current read says (the app's `TAP_TO_REFRESH`). A tap opens
  /// Limits, which reads every provider again; opening Ryco from its icon reads only the hubs.
  static let tapToRefresh = "Tap to refresh"

  struct Row: Decodable {
    /// The account, when the view lists more than one.
    let account: String?
    let label: String
    /// `session`, `weekly` or `other`.
    let kind: String
    /// Whole percent left.
    let remaining: Int
    /// Epoch ms.
    let resetsAt: Double?

    var title: String { account.map { "\($0) · \(label)" } ?? label }
    var resetDate: Date? { resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
  }

  struct View: Decodable {
    let detail: String
    /// Tightest first.
    let rows: [Row]
    /// Rows before the app capped them.
    let total: Int
  }

  struct Provider: Decodable {
    let provider: String
    let name: String
    let fresh: Bool
    let pooled: View
    let accounts: View
  }

  /// What a tap opens.
  let url: String
  /// When the oldest number shown was read, epoch ms; 0 when none is.
  let observedAt: Double
  let providers: [Provider]
}

/// The widget's settings: which windows a provider shows, and whether hub accounts are pooled.
enum UsagePeriodChoice: String {
  case both
  case session
  case weekly
}

enum UsageAccountsChoice: String {
  case pooled
  case each
}

/// What one provider shows at one widget size.
struct UsageColumn {
  let name: String
  let detail: String
  let rows: [SubscriptionUsageContent.Row]
  /// How many more rows Ryco itself shows.
  let more: Int
}

extension SubscriptionUsageContent.Provider {
  /// `limit` rows at most. `single` (Lock Screen, simplified) shows only the
  /// tightest; `compact` (small) prefers one session and one weekly row.
  func column(
    period: UsagePeriodChoice, accounts choice: UsageAccountsChoice, limit: Int, compact: Bool,
    single: Bool
  ) -> UsageColumn {
    let view = choice == .each ? accounts : pooled
    let rows = fresh ? view.rows.filter { period == .both || $0.kind == period.rawValue } : []
    let tightest = rows.min { $0.remaining < $1.remaining }
    let session = rows.firstIndex { $0.kind == "session" }
    let weekly = rows.firstIndex { $0.kind == "weekly" }
    let pair = [session, weekly].compactMap { $0 }
    let shown: [SubscriptionUsageContent.Row]
    if single {
      shown = tightest.map { [$0] } ?? []
    } else if (compact || period == .both) && !pair.isEmpty {
      let rest = rows.indices.filter { !pair.contains($0) }
      shown = Array((pair + rest).prefix(limit).map { rows[$0] })
    } else {
      shown = Array(rows.prefix(limit))
    }
    let detail =
      fresh && period != .both && rows.isEmpty && !view.rows.isEmpty
      ? "No \(period.rawValue) limit reported" : view.detail
    let total = period == .both ? view.total : rows.count
    return UsageColumn(
      name: name, detail: detail, rows: shown, more: fresh ? max(0, total - shown.count) : 0)
  }
}
