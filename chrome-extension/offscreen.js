let stream = null;
let audioContext = null;
let analyser = null;
let source = null;
let samples = null;
let levelTimer = null;
let lastVolume = 0;

const VOLUME_THRESHOLD = 0.45;
const VOLUME_MAX_LIMIT = 0.8;
const VOLUME_AMPLIFICATION = 1.5;
const VOLUME_SENSITIVITY_CURVE = 0.7;
const MIC_FFT_SIZE = 512;
const MIC_SMOOTHING = 0.3;
const MIC_VOICE_RANGE_END = 50;
const MIC_SMOOTH_FACTOR_OLD = 0.6;
const MIC_SMOOTH_FACTOR_NEW = 0.4;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  if (msg.type === "MIC_START") {
    startMic()
      .then((result) => sendResponse({ result }))
      .catch((error) => sendResponse(normalizeMicError(error)));
    return true;
  }

  if (msg.type === "MIC_STOP") {
    stopMic();
    sendResponse({ result: "MIC_STOPPED" });
    return false;
  }

  return false;
});

async function startMic() {
  if (stream && audioContext && analyser) return "MIC_STARTED";

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  audioContext = new AudioContext();
  await audioContext.resume();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = MIC_FFT_SIZE;
  analyser.smoothingTimeConstant = MIC_SMOOTHING;
  samples = new Uint8Array(analyser.frequencyBinCount);
  lastVolume = 0;

  source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);
  startLevelLoop();

  chrome.runtime.sendMessage({ source: "offscreen", type: "MIC_STATUS", status: "started" });
  return "MIC_STARTED";
}

function startLevelLoop() {
  if (levelTimer) return;

  const tick = () => {
    if (!analyser || !samples) return;

    analyser.getByteFrequencyData(samples);
    let sum = 0;
    let peak = 0;
    const voiceRangeLength = Math.min(MIC_VOICE_RANGE_END, samples.length);

    for (let i = 0; i < voiceRangeLength; i++) {
      const value = samples[i];
      sum += value;
      peak = Math.max(peak, value / 255);
    }

    const average = sum / voiceRangeLength;
    const normalizedVolume = average / 255;
    const sensitivityCurve = Math.pow(normalizedVolume, VOLUME_SENSITIVITY_CURVE);
    let amplifiedVolume = Math.min(VOLUME_MAX_LIMIT, sensitivityCurve * VOLUME_AMPLIFICATION);

    if (amplifiedVolume < VOLUME_THRESHOLD) {
      amplifiedVolume = 0;
    }

    lastVolume = lastVolume * MIC_SMOOTH_FACTOR_OLD + amplifiedVolume * MIC_SMOOTH_FACTOR_NEW;

    chrome.runtime.sendMessage({
      source: "offscreen",
      type: "MIC_LEVEL",
      level: lastVolume,
      peak: Math.min(VOLUME_MAX_LIMIT, peak),
    });
  };

  levelTimer = setInterval(tick, 40);
}

function stopMic() {
  if (levelTimer) {
    clearInterval(levelTimer);
    levelTimer = null;
  }

  if (source) {
    try { source.disconnect(); } catch (_) {}
    source = null;
  }

  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  analyser = null;
  samples = null;
  lastVolume = 0;
  chrome.runtime.sendMessage({ source: "offscreen", type: "MIC_STATUS", status: "stopped" });
}

function normalizeMicError(error) {
  stopMic();
  const name = error?.name || "";
  const message = error?.message || String(error);

  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return { result: "MIC_PERMISSION", error: message };
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return { result: "MIC_ERROR", error: "No microphone input device was found." };
  }

  return { result: "MIC_ERROR", error: message };
}
