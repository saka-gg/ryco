/* AudioWorklet runs off the UI thread. The AudioContext converts hardware input to 16 kHz. */
class RycoPcm extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const pcm = new ArrayBuffer(channels[0].length * 2);
    const view = new DataView(pcm);
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      view.setInt16(i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
    }
    this.port.postMessage(pcm, [pcm]);
    return true;
  }
}
registerProcessor("ryco-pcm", RycoPcm);
