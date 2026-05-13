(() => {
  if (window.__xtrStreamDeckTtsMeterInstalled) return;
  window.__xtrStreamDeckTtsMeterInstalled = true;

  const meters = new WeakMap();
  const originalPlay = HTMLMediaElement.prototype.play;

  function publish(level, peak, active) {
    window.dispatchEvent(new CustomEvent("xtr-streamdeck-tts-level", {
      detail: { level, peak, active },
    }));
  }

  async function ensureMeter(media) {
    let meter = meters.get(media);
    if (meter) return meter;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return null;

    try {
      const ctx = new AudioContextCtor();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      const samples = new Uint8Array(analyser.fftSize);
      const source = ctx.createMediaElementSource(media);
      source.connect(analyser);
      analyser.connect(ctx.destination);
      meter = { ctx, analyser, samples, frame: 0, level: 0 };
      meters.set(media, meter);
      return meter;
    } catch (_) {
      return null;
    }
  }

  function stopMeter(media) {
    const meter = meters.get(media);
    if (!meter) return;
    if (meter.frame) cancelAnimationFrame(meter.frame);
    meter.frame = 0;
    meter.level = 0;
    publish(0, 0, false);
  }

  async function startMeter(media) {
    const meter = await ensureMeter(media);
    if (!meter) return;
    if (meter.ctx.state === "suspended") {
      try { await meter.ctx.resume(); } catch (_) {}
    }
    if (meter.frame) return;

    const tick = () => {
      if (media.paused || media.ended) {
        stopMeter(media);
        return;
      }

      meter.analyser.getByteTimeDomainData(meter.samples);
      let sumSquares = 0;
      let peak = 0;
      for (const sample of meter.samples) {
        const value = (sample - 128) / 128;
        sumSquares += value * value;
        peak = Math.max(peak, Math.abs(value));
      }

      const rms = Math.sqrt(sumSquares / meter.samples.length);
      const amplified = rms < 0.01 ? 0 : Math.min(0.8, Math.pow(rms, 0.7) * 1.9);
      meter.level = meter.level * 0.58 + amplified * 0.42;
      publish(meter.level, Math.min(0.8, peak), true);
      meter.frame = requestAnimationFrame(tick);
    };

    tick();
  }

  HTMLMediaElement.prototype.play = function patchedPlay(...args) {
    const result = originalPlay.apply(this, args);
    Promise.resolve(result).then(() => startMeter(this)).catch(() => {});
    return result;
  };

  document.addEventListener("pause", (event) => {
    if (event.target instanceof HTMLMediaElement) stopMeter(event.target);
  }, true);
  document.addEventListener("ended", (event) => {
    if (event.target instanceof HTMLMediaElement) stopMeter(event.target);
  }, true);
})();
