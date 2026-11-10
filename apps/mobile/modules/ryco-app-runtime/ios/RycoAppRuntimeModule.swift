import ExpoModulesCore
import Foundation
import UIKit

/// App runtime helpers for the hosted connection lifecycle.
///
/// - A background stay (findings F1): a short `UIApplication` background task
///   that lets JavaScript keep its Hub connections through an app switch. The
///   connection policy itself lives in `@ryco/client-runtime`
///   (`bindConnectivityRecovery`); this only asks iOS for the time and says
///   when iOS takes it back.
/// - Relay payload inflation (findings F8) on a background queue instead of the
///   JavaScript thread that also draws.
public final class RycoAppRuntimeModule: Module {
  private static let expiringEvent = "onBackgroundStayExpiring"

  private let lock = NSLock()
  private var stays: [Int: UIBackgroundTaskIdentifier] = [:]
  private var expired: Set<Int> = []
  private var nextStayId = 1

  public func definition() -> ModuleDefinition {
    Name("RycoAppRuntime")

    Events(Self.expiringEvent)

    // `beginBackgroundTask` and `endBackgroundTask` may be called from any thread.
    Function("beginBackgroundStay") { (name: String) -> Int in
      self.lock.lock()
      let stayId = self.nextStayId
      self.nextStayId += 1
      self.lock.unlock()
      let task = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
        // iOS takes the time back: tell JavaScript, and give the task back at
        // once, as iOS requires, so the app is suspended rather than killed.
        self?.expire(stayId)
      }
      if task == .invalid { return 0 }
      self.lock.lock()
      self.stays[stayId] = task
      self.lock.unlock()
      return stayId
    }

    Function("endBackgroundStay") { (stayId: Int) in
      self.end(stayId)
    }

    /// Whether iOS took the stay back before JavaScript ended it. Read before ending.
    Function("backgroundStayExpired") { (stayId: Int) -> Bool in
      self.lock.lock()
      defer { self.lock.unlock() }
      return self.expired.contains(stayId)
    }

    // Runs on the module's background queue, off the JavaScript thread.
    AsyncFunction("inflateRaw") { (body: Data, maxOutputBytes: Int) throws -> Data in
      do {
        return try RelayInflate.inflateRaw(body, maxOutputBytes: maxOutputBytes)
      } catch let error as RelayInflateError {
        throw Exception(name: "RelayInflateError", description: error.message)
      }
    }
  }

  private func expire(_ stayId: Int) {
    lock.lock()
    let known = stays[stayId] != nil
    if known { expired.insert(stayId) }
    lock.unlock()
    guard known else { return }
    sendEvent(Self.expiringEvent, ["stayId": stayId])
    end(stayId, keepExpired: true)
  }

  private func end(_ stayId: Int, keepExpired: Bool = false) {
    lock.lock()
    let task = stays.removeValue(forKey: stayId)
    if !keepExpired { expired.remove(stayId) }
    lock.unlock()
    if let task { UIApplication.shared.endBackgroundTask(task) }
  }
}
