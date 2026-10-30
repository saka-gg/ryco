import CryptoKit
import UserNotifications

/// The `RycoNotificationService` extension (`docs/push-alerts.md`).
///
/// The Hub sends every alert with the same generic text and a payload sealed
/// to this device's push key. This opens it with the key the app keeps in the
/// shared keychain group and shows the thread's title and what happened, the
/// way the app's own alerts do. On any failure, or when time runs out, the
/// generic text stays, without any data the Hub put beside it, and a tap just
/// opens the app.
final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var delivered: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let generic = Self.generic(request.content)
    delivered = generic
    finish(Self.opened(request.content) ?? generic)
  }

  override func serviceExtensionTimeWillExpire() {
    if let delivered { finish(delivered) }
  }

  private func finish(_ content: UNNotificationContent) {
    guard let handler = contentHandler else { return }
    contentHandler = nil
    handler(content)
  }

  /// The Hub's generic text with nothing the app would act on.
  private static func generic(_ content: UNNotificationContent) -> UNNotificationContent {
    let mutable =
      (content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    mutable.userInfo = PushAlertOpener.userInfo(content.userInfo, alert: nil)
    return mutable
  }

  private static func opened(_ content: UNNotificationContent) -> UNNotificationContent? {
    guard
      let store = PushKeyStore.fromMainBundle(),
      let record = try? store.read(),
      let privateKey = try? Curve25519.KeyAgreement.PrivateKey(
        rawRepresentation: record.privateKey),
      let alert = PushAlertOpener.alert(
        userInfo: content.userInfo,
        privateKey: privateKey,
        storedEnrollmentId: record.enrollmentId,
        now: Date(),
        appScheme: Bundle.main.object(forInfoDictionaryKey: "RycoAppScheme") as? String
      ),
      let mutable = content.mutableCopy() as? UNMutableNotificationContent
    else { return nil }
    mutable.title = alert.title
    mutable.body = alert.body
    mutable.threadIdentifier = alert.threadIdentifier
    if !record.sound { mutable.sound = nil }
    mutable.userInfo = PushAlertOpener.userInfo(content.userInfo, alert: alert)
    return mutable
  }
}
