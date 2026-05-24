class SubStreamAudioProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const ch0 = input && input[0];
    if (!ch0) return true;

    const ch1 = input[1] || ch0;
    const mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) {
      mono[i] = (ch0[i] + ch1[i]) * 0.5;
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor('substream-audio-processor', SubStreamAudioProcessor);
