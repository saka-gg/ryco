import CryptoKit
import UserNotifications

/// The `RycoNotificationService` extension (`docs/push-alerts.md`).
///
/// The Hub sends every alert with the same generic text and a payload sealed
/// to this device's push key. This opens it with the key the app keeps in the
/// shared keychain group and shows the thread's title and what happened, the
/// way the app's own alerts do. On any failure, or when time runs out, the
/// generic text stays and a tap just opens the app.
final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var delivered: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    delivered = request.content
    finish(Self.opened(request.content) ?? request.content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let delivered { finish(delivered) }
  }

  private func finish(_ content: UNNotificationContent) {
    guard let handler = contentHandler else { return }
    contentHandler = nil
    handler(content)
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
    var userInfo = mutable.userInfo
    userInfo.removeValue(forKey: "ryco")
    // expo-notifications hands a remote alert's `body` to the app as its data,
    // which is where the app's own alerts keep the thread a tap opens.
    userInfo["body"] = ["environmentId": alert.environmentId, "threadId": alert.threadId]
    if let url = alert.url { userInfo["url"] = url }
    mutable.userInfo = userInfo
    return mutable
  }
}
