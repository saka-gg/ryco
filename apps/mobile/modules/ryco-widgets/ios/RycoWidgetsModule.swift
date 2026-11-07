import ActivityKit
import ExpoModulesCore
import Foundation
import WidgetKit

/// Widget timelines (`src/widgets`) and the agent Live Activity (`src/liveActivity`).
///
/// JavaScript computes every timeline and hands it over as JSON; this module
/// writes it into the App Group and asks WidgetKit to reload that kind. The
/// widget extension renders what it finds there and never reaches a node.
///
/// The Live Activity is started, updated and ended from the app. Only when the
/// app asks for push updates (its Hub advertises them, `docs/live-activity-push.md`)
/// is it requested with `pushType: .token`; its update tokens then reach
/// JavaScript as `onAgentActivityPushToken`, and a push update carries counts
/// only. Otherwise (`pushType: nil`) nothing about it leaves the device.
public final class RycoWidgetsModule: Module {
  /// One observer per card: its update tokens, until it ends. Main actor only.
  @MainActor private var tokenObservers: [String: Task<Void, Never>] = [:]

  /// The extension the config plugin embeds; without it nothing would read a timeline.
  private static let extensionName = "RycoWidgets.appex"
  /// Far above any timeline the app writes; anything bigger is a bug, not a widget.
  private static let maxTimelineBytes = 256 * 1024

  public func definition() -> ModuleDefinition {
    Name("RycoWidgets")

    Events("onAgentActivityPushToken")

    /// The widget kinds on the person's Home and Lock Screens, so the app feeds only those.
    AsyncFunction("installedWidgetKinds") { () async -> [String] in
      await withCheckedContinuation { continuation in
        WidgetCenter.shared.getCurrentConfigurations { result in
          let kinds = (try? result.get())?.map(\.kind) ?? []
          continuation.resume(returning: Array(Set(kinds)).sorted())
        }
      }
    }

    Function("isAvailable") { () -> Bool in
      Self.store() != nil && Self.extensionEmbedded()
    }

    AsyncFunction("writeTimeline") { (kind: String, json: String) throws -> Void in
      let store = try Self.requireStore()
      let data = Data(json.utf8)
      guard data.count <= Self.maxTimelineBytes,
        (try? JSONSerialization.jsonObject(with: data)) is [String: Any]
      else { throw WidgetsModuleError.invalidTimeline }
      try store.write(kind: kind, data: data)
      WidgetCenter.shared.reloadTimelines(ofKind: kind)
    }

    AsyncFunction("clear") { (kind: String) throws -> Void in
      try Self.requireStore().remove(kind: kind)
      WidgetCenter.shared.reloadTimelines(ofKind: kind)
    }

    /// Whether this build can show the card and the person allows Live Activities for Ryco.
    Function("activitiesEnabled") { () -> Bool in
      Self.extensionEmbedded() && ActivityAuthorizationInfo().areActivitiesEnabled
    }

    AsyncFunction("startAgentActivity") {
      (stateJson: String, staleDateMs: Double, pushUpdates: Bool?) throws -> String in
      guard Self.extensionEmbedded() else { throw WidgetsModuleError.unavailable }
      let content = ActivityContent(
        state: try Self.decodeState(stateJson), staleDate: Self.date(staleDateMs))
      let attributes = AgentActivityAttributes(v: 1)
      if pushUpdates == true {
        // A build or device that cannot take push updates refuses the token; the card then
        // starts local only, as before.
        if let activity = try? Activity.request(
          attributes: attributes, content: content, pushType: .token)
        {
          Task { @MainActor in self.observePushTokens(activity) }
          return activity.id
        }
      }
      do {
        return try Activity.request(attributes: attributes, content: content, pushType: nil).id
      } catch {
        throw WidgetsModuleError.activityRefused
      }
    }

    /// Follows the update tokens of the cards still showing (one an earlier launch left).
    Function("observeAgentActivityPushTokens") { () -> Void in
      Task { @MainActor in
        for activity in Activity<AgentActivityAttributes>.activities
        where activity.activityState == .active || activity.activityState == .stale {
          self.observePushTokens(activity)
        }
      }
    }

    AsyncFunction("updateAgentActivity") {
      (id: String, stateJson: String, staleDateMs: Double, timestampMs: Double) async throws -> Void
      in
      guard let activity = Self.agentActivity(id) else { throw WidgetsModuleError.activityGone }
      let content = ActivityContent(
        state: try Self.decodeState(stateJson), staleDate: Self.date(staleDateMs))
      if #available(iOS 17.2, *) {
        await activity.update(content, alertConfiguration: nil, timestamp: Self.date(timestampMs))
      } else {
        await activity.update(content)
      }
    }

    AsyncFunction("endAgentActivity") {
      (id: String, stateJson: String?, dismissAtMs: Double?) async throws -> Void in
      guard let activity = Self.agentActivity(id) else { return }
      let content = try stateJson.map {
        ActivityContent(state: try Self.decodeState($0), staleDate: nil)
      }
      let policy: ActivityUIDismissalPolicy = dismissAtMs.map { .after(Self.date($0)) } ?? .immediate
      await activity.end(content, dismissalPolicy: policy)
    }

    /// Ends cards at once, off the Lock Screen and the Dynamic Island: every
    /// card (sign-out, the switch going off), or only those that already ended
    /// and still show their results for a while (before a new card starts, so
    /// there is never a second one).
    AsyncFunction("dismissAgentActivities") { (endedOnly: Bool) async -> Void in
      for activity in Activity<AgentActivityAttributes>.activities
      where activity.activityState != .dismissed
        && (!endedOnly || activity.activityState == .ended)
      {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }

    /// The cards still showing work (active or stale), with when each was last updated.
    AsyncFunction("listAgentActivities") { () -> [[String: Any]] in
      Activity<AgentActivityAttributes>.activities
        .filter { $0.activityState == .active || $0.activityState == .stale }
        .map { activity in
          var card: [String: Any] = [
            "id": activity.id, "updatedAt": activity.content.state.updatedAt,
          ]
          if let staleDate = activity.content.staleDate {
            card["staleAt"] = staleDate.timeIntervalSince1970 * 1000
          }
          return card
        }
    }
  }

  /// Sends each update token of `activity` (hex) to JavaScript, the current one first, and an
  /// empty one once the card ends: its token is then worthless.
  @MainActor private func observePushTokens(_ activity: Activity<AgentActivityAttributes>) {
    let id = activity.id
    guard tokenObservers[id] == nil else { return }
    tokenObservers[id] = Task { [weak self] in
      await withTaskGroup(of: Void.self) { group in
        group.addTask { [weak self] in
          for await token in activity.pushTokenUpdates {
            self?.sendEvent(
              "onAgentActivityPushToken", ["id": id, "token": Self.hex(token)])
          }
        }
        group.addTask { [weak self] in
          for await state in activity.activityStateUpdates
          where state == .ended || state == .dismissed {
            self?.sendEvent("onAgentActivityPushToken", ["id": id, "token": ""])
            break
          }
        }
        // The card's end finishes the state stream; the token stream goes with it.
        await group.next()
        group.cancelAll()
      }
      await MainActor.run { self?.tokenObservers[id] = nil }
    }
  }

  private static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }

  private static func agentActivity(_ id: String) -> Activity<AgentActivityAttributes>? {
    Activity<AgentActivityAttributes>.activities.first { $0.id == id }
  }

  /// The app's state, trimmed to ActivityKit's limit as Swift encodes it.
  private static func decodeState(_ json: String) throws -> AgentActivityAttributes.ContentState {
    let state: AgentActivityAttributes.ContentState
    do {
      state = try JSONDecoder().decode(
        AgentActivityAttributes.ContentState.self, from: Data(json.utf8))
    } catch {
      throw WidgetsModuleError.invalidActivityState
    }
    guard let fitted = state.fitted() else { throw WidgetsModuleError.invalidActivityState }
    return fitted
  }

  private static func date(_ epochMs: Double) -> Date {
    Date(timeIntervalSince1970: epochMs / 1000)
  }

  private static func store() -> WidgetGroupStore? {
    WidgetGroupStore.fromMainBundle()
  }

  private static func requireStore() throws -> WidgetGroupStore {
    guard let store = store(), extensionEmbedded() else { throw WidgetsModuleError.unavailable }
    return store
  }

  private static func extensionEmbedded() -> Bool {
    guard let plugins = Bundle.main.builtInPlugInsURL else { return false }
    return FileManager.default.fileExists(
      atPath: plugins.appendingPathComponent(extensionName).path)
  }
}

/// Fixed messages: no path or container detail reaches JavaScript.
private enum WidgetsModuleError: Error, LocalizedError {
  case unavailable
  case invalidTimeline
  case invalidActivityState
  case activityRefused
  case activityGone

  var errorDescription: String? {
    switch self {
    case .unavailable:
      return "This build has no widgets."
    case .invalidTimeline:
      return "The widget timeline is not a JSON object of a sensible size."
    case .invalidActivityState:
      return "The Live Activity state could not be read."
    case .activityRefused:
      return "iOS did not start the Live Activity."
    case .activityGone:
      return "The Live Activity has ended."
    }
  }
}
