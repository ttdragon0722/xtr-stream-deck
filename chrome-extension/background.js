/**
 * XTR Stream Deck Bridge - Background Service Worker
 *
 * 為何放在 background：HTTPS 頁面（如 youtube.com）的 content script
 * 受 Chrome Private Network Access 限制，無法直接連線 ws://localhost。
 * Service Worker 不在頁面脈絡下，因此可以連線本地 Stream Deck 外掛。
 *
 * 流程：
 *   ws://localhost:9999  ←收指令→  background.js
 *                                      │ chrome.tabs.sendMessage
 *                                      ▼
 *                                 content.js (在使用者作用中的 tab)
 */

const BRIDGE_URL = "ws://localhost:9999";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const MIC_PERMISSION_PAGE = "mic-permission.html";
let ws = null;
let retryTimer = null;
let creatingOffscreen = null;
let micDesired = false;

function connectWs() {
  if (ws && ws.readyState <= 1) return; // CONNECTING / OPEN

  ws = new WebSocket(BRIDGE_URL);

  ws.onopen = () => {
    console.log("[XTR BG] WebSocket 已連線");
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    if (msg.type === "mic-control") {
      await handleMicControl(msg);
      return;
    }

    await handlePageAction(msg);
  };

  ws.onclose = () => {
    micDesired = false;
    stopMicOffscreen();
    retryTimer = setTimeout(connectWs, 3000);
  };

  ws.onerror = () => ws.close();
}

function sendResult(id, result) {
  if (id && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id, result }));
  }
}

function sendBridgePayload(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function handlePageAction(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return sendResult(msg.id, "NO_ACTIVE_TAB");

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "XTR_ACTION", ...msg });
    sendResult(msg.id, res?.result || "NO_RESPONSE");
  } catch (_) {
    sendResult(msg.id, "CONTENT_SCRIPT_ERROR");
  }
}

async function handleMicControl(msg) {
  if (msg.command === "start") {
    micDesired = true;
    const result = await startMicOffscreen();
    sendResult(msg.id, result);
    return;
  }

  if (msg.command === "stop") {
    micDesired = false;
    await stopMicOffscreen();
    sendResult(msg.id, "MIC_STOPPED");
  }
}

async function startMicOffscreen() {
  if (!chrome.offscreen?.createDocument) {
    sendMicStatus("unsupported");
    return "MIC_UNSUPPORTED";
  }

  try {
    await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
    const res = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "MIC_START",
    });

    const result = res?.result || "MIC_ERROR";
    if (result === "MIC_STARTED") {
      sendMicStatus("started");
      return result;
    }

    if (result === "MIC_PERMISSION") {
      sendMicStatus("permission-needed");
      await openMicPermissionPage();
      return result;
    }

    sendMicStatus("error", res?.error || result);
    return result;
  } catch (error) {
    sendMicStatus("error", error?.message || String(error));
    return "MIC_ERROR";
  }
}

async function stopMicOffscreen() {
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "MIC_STOP" });
  } catch (_) {}

  try {
    if (await hasOffscreenDocument(OFFSCREEN_DOCUMENT_PATH)) {
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {}

  sendMicStatus("stopped");
}

async function setupOffscreenDocument(path) {
  if (await hasOffscreenDocument(path)) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: path,
    reasons: ["USER_MEDIA"],
    justification: "Analyze microphone level for the Stream Deck live waveform button.",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function hasOffscreenDocument(path) {
  const offscreenUrl = chrome.runtime.getURL(path);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }

  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

async function openMicPermissionPage() {
  const url = chrome.runtime.getURL(MIC_PERMISSION_PAGE);
  const tabs = await chrome.tabs.query({ url });
  if (tabs[0]?.id) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

function sendMicStatus(status, detail = "") {
  sendBridgePayload({ type: "mic-status", status, detail });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.source === "offscreen" && msg.type === "MIC_LEVEL") {
    sendBridgePayload({
      type: "mic-level",
      level: msg.level,
      peak: msg.peak,
      ts: Date.now(),
    });
    return false;
  }

  if (msg?.source === "offscreen" && msg.type === "MIC_STATUS") {
    sendMicStatus(msg.status, msg.detail || "");
    return false;
  }

  if (msg?.source === "content" && msg.type === "VOICE_STATUS") {
    sendBridgePayload({
      type: "voice-status",
      state: msg.state || "idle",
      ttsEnabled: msg.ttsEnabled,
      handsFree: msg.handsFree,
      ts: Date.now(),
    });
    return false;
  }

  if (msg?.source === "content" && msg.type === "TTS_AUDIO_LEVEL") {
    sendBridgePayload({
      type: "tts-audio-level",
      level: msg.level,
      peak: msg.peak,
      active: msg.active,
      ts: Date.now(),
    });
    return false;
  }

  if (msg?.type === "MIC_PERMISSION_GRANTED") {
    if (micDesired) {
      startMicOffscreen();
    }
    sendResponse({ result: "OK" });
    return true;
  }

  return false;
});

chrome.action.onClicked.addListener(() => {
  openMicPermissionPage();
});

connectWs();

// Service Worker 會被瀏覽器休眠，用 alarms 喚醒並重新連線
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 }); // ~24 秒
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive" && (!ws || ws.readyState > 1)) {
    connectWs();
  }
});
