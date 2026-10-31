import SwiftUI
import WidgetKit

/// Everything Ryco's widget extension renders. Each widget reads only the
/// timeline the app wrote for it into the shared App Group
/// (`WidgetTimelineStore`); none of them reaches a node or the Hub.
@main
struct RycoWidgetsBundle: WidgetBundle {
  var body: some Widget {
  }
}
