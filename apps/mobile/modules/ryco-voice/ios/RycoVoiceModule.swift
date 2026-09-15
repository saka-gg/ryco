import AVFoundation
import ExpoModulesCore

public class RycoVoiceModule: Module {
  private let lock = NSLock()
  private var engine: AVAudioEngine?
  private var owner: String?
  private var pcm = Data()
  private var timer: Timer?
  private var interruption: NSObjectProtocol?
  private let limit = 1_920_000

  public func definition() -> ModuleDefinition {
    Name("RycoVoice")
    Events("interrupted")
    AsyncFunction("permission") { (promise: Promise) in
      AVAudioSession.sharedInstance().requestRecordPermission { granted in promise.resolve(granted) }
    }
    AsyncFunction("start") { (id: String) in try self.start(id) }.runOnQueue(.main)
    AsyncFunction("stop") { (id: String) -> String in
      guard self.owner == id else { throw NSError(domain: "RycoVoice", code: 1) }
      self.stopEngine()
      self.lock.lock(); defer { self.lock.unlock() }
      let result = self.pcm.base64EncodedString()
      self.pcm.resetBytes(in: 0..<self.pcm.count); self.pcm.removeAll()
      self.owner = nil
      return result
    }.runOnQueue(.main)
    AsyncFunction("cancel") { (id: String) in self.cancel(id) }.runOnQueue(.main)
    OnAppEntersBackground { if let id = self.owner { self.cancel(id) } }
    OnDestroy { if let id = self.owner { self.cancel(id) } }
  }

  private func start(_ id: String) throws {
    guard owner == nil else { throw NSError(domain: "RycoVoiceBusy", code: 2) }
    let session = AVAudioSession.sharedInstance()
    guard session.recordPermission == .granted else { throw NSError(domain: "RycoVoicePermission", code: 3) }
    try session.setCategory(.record, mode: .measurement)
    try session.setActive(true)
    let graph = AVAudioEngine()
    let input = graph.inputNode
    let source = input.outputFormat(forBus: 0)
    guard source.sampleRate > 0,
      let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
      let converter = AVAudioConverter(from: source, to: target) else {
      try? session.setActive(false); throw NSError(domain: "RycoVoiceFormat", code: 4)
    }
    owner = id; engine = graph; pcm.removeAll()
    interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] _ in
      guard let self, self.owner == id else { return }
      self.cancel(id); self.sendEvent("interrupted", ["id": id])
    }
    input.installTap(onBus: 0, bufferSize: 2048, format: source) { [weak self] buffer, _ in
      guard let self else { return }
      let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / source.sampleRate) + 32)
      guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
      var consumed = false
      var error: NSError?
      converter.convert(to: output, error: &error) { _, status in
        if consumed { status.pointee = .noDataNow; return nil }
        consumed = true; status.pointee = .haveData; return buffer
      }
      guard error == nil, let samples = output.floatChannelData?[0] else { return }
      self.lock.lock(); defer { self.lock.unlock() }
      guard self.owner == id else { return }
      for i in 0..<Int(output.frameLength) {
        if self.pcm.count >= self.limit { break }
        let value = samples[i].isFinite ? max(-1, min(1, samples[i])) : 0
        var sample = Int16((value * (value < 0 ? 32768 : 32767)).rounded()).littleEndian
        withUnsafeBytes(of: &sample) { self.pcm.append(contentsOf: $0) }
      }
    }
    do { try graph.start() }
    catch { cancel(id); throw error }
    timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
      guard self?.owner == id else { return }; self?.stopEngine()
    }
  }
  private func stopEngine() {
    timer?.invalidate(); timer = nil
    if let observer = interruption { NotificationCenter.default.removeObserver(observer) }; interruption = nil
    if let graph = engine { graph.stop(); graph.inputNode.removeTap(onBus: 0) }
    engine = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
  private func cancel(_ id: String) {
    guard owner == id else { return }
    stopEngine()
    lock.lock(); defer { lock.unlock() }
    pcm.resetBytes(in: 0..<pcm.count); pcm.removeAll(); owner = nil
  }
}
