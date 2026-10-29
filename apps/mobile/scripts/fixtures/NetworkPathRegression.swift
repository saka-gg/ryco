import Foundation

// Stand-ins for Network.framework: the test delivers path updates itself,
// also after the query cancelled its monitor, as the real monitor may.
final class NWPath {
  let id: Int
  init(id: Int) { self.id = id }
}

final class NWPathMonitor {
  static var script: (NWPathMonitor) -> Void = { _ in }
  var pathUpdateHandler: ((NWPath) -> Void)?
  private var queue: DispatchQueue?

  func start(queue: DispatchQueue) {
    self.queue = queue
    NWPathMonitor.script(self)
  }

  func cancel() {}

  func deliver(_ path: NWPath, afterMilliseconds delay: Int = 0) {
    let handler = pathUpdateHandler
    queue?.asyncAfter(deadline: .now() + .milliseconds(delay)) { handler?(path) }
  }
}

let scenario = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
switch scenario {
case "first":
  NWPathMonitor.script = { monitor in
    for id in 1...3 { monitor.deliver(NWPath(id: id)) }
  }
  for _ in 0..<50 {
    let path = NetworkModule().query()
    guard path?.id == 1 else {
      print("failed: got path \(String(describing: path?.id)) instead of the first")
      exit(1)
    }
  }
  print("passed")
case "concurrent":
  NWPathMonitor.script = { monitor in
    monitor.deliver(NWPath(id: 1))
    monitor.deliver(NWPath(id: 2), afterMilliseconds: 1)
    monitor.deliver(NWPath(id: 3), afterMilliseconds: 2)
  }
  DispatchQueue.concurrentPerform(iterations: 100) { _ in
    _ = NetworkModule().query()
  }
  // Let the late updates land while their queries' paths are being read.
  Thread.sleep(forTimeInterval: 0.05)
  print("passed")
default:
  print("unknown scenario \(scenario)")
  exit(2)
}
