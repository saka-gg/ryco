const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const SCENE_DELEGATE = `

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else {
      return
    }

    let appWindow: UIWindow
    if let existingWindow = appDelegate.window {
      appWindow = existingWindow
    } else {
      appWindow = UIWindow(windowScene: windowScene)
      appDelegate.window = appWindow
      appDelegate.reactNativeFactory?.startReactNative(
        withModuleName: "main",
        in: appWindow,
        launchOptions: nil)
    }

    window = appWindow
    appWindow.windowScene = windowScene
    appWindow.makeKeyAndVisible()

    if let url = connectionOptions.urlContexts.first?.url {
      _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
    }

    if let userActivity = connectionOptions.userActivities.first {
      _ = appDelegate.application(
        UIApplication.shared,
        continue: userActivity,
        restorationHandler: { _ in })
    }

    // A home-screen quick action that launched the app opens like a deep link.
    if let shortcutItem = connectionOptions.shortcutItem, let url = Self.shortcutURL(shortcutItem) {
      _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
    }
  }

  // With a scene delegate, iOS hands quick actions to the scene, never to the app delegate.
  func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard
      let url = Self.shortcutURL(shortcutItem),
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else {
      completionHandler(false)
      return
    }
    completionHandler(appDelegate.application(UIApplication.shared, open: url, options: [:]))
  }

  /// The app path a quick action carries (src/features/shortcuts/appShortcuts.ts), as a URL
  /// in this app's own scheme. Only today's destinations: New task and a thread.
  static func shortcutURL(_ item: UIApplicationShortcutItem) -> URL? {
    guard let path = item.userInfo?["path"] as? String else { return nil }
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    let allowed =
      path == "tasks/new" || (parts.count == 3 && parts[0] == "threads" && !parts[1].isEmpty && !parts[2].isEmpty)
    guard
      allowed,
      let urlTypes = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]],
      let scheme = urlTypes.lazy.compactMap({ ($0["CFBundleURLSchemes"] as? [String])?.first }).first
    else {
      return nil
    }
    return URL(string: "\(scheme)://\(path)")
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard
      let url = URLContexts.first?.url,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else {
      return
    }

    _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }

    _ = appDelegate.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in })
  }
}`;

module.exports = function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (nextConfig) => {
    nextConfig.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };

    return nextConfig;
  });

  return withAppDelegate(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "swift") {
      throw new Error("The iOS scene lifecycle plugin requires a Swift AppDelegate.");
    }

    if (!nextConfig.modResults.contents.includes("class SceneDelegate:")) {
      nextConfig.modResults.contents += SCENE_DELEGATE;
    }

    return nextConfig;
  });
};
