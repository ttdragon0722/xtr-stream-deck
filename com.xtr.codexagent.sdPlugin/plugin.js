#!/usr/bin/env node

/**
 * XTR Stream Deck 外掛
 *
 * 對外開放兩個 WebSocket：
 *   1. ws://127.0.0.1:<sdPort>   ← Stream Deck 軟體（CLI 啟動時注入）
 *   2. ws://localhost:9999       ← Chrome 外掛 background.js
 *
 * Actions:
 *   - com.xtr.codexagent.runscript  → 在 Codex 開啟 XTR workspace
 *   - com.xtr.codexagent.sysinfo    → 顯示 CPU / 記憶體
 *   - com.xtr.codexagent.openapp    → 開啟 Codex app
 *   - com.xtr.codexagent.webclick   → 透過 Chrome 外掛點擊網頁元素
 *   - com.xtr.codexagent.customclick → 透過自訂 selector 點擊網頁元素
 *   - com.xtr.codexagent.ubikextr   → 在 XTR Host 輸入 ubike xtr 指派前綴
 *   - com.xtr.codexagent.micwave    → 在按鍵上顯示麥克風即時聲波
 */

const { exec, execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

// ═══════════════════════════════════════════════════════════
// Bridge Server: 與 Chrome 外掛 background.js 對接
// ═══════════════════════════════════════════════════════════
const BRIDGE_PORT = Number.parseInt(process.env.XTR_BRIDGE_PORT || "9999", 10) || 9999;
const bridgeClients = new Set();
const pendingCallbacks = new Map(); // msgId → { context, timer, label }
const micWave = {
  activeContexts: new Map(),
  latestLevel: 0,
  latestPeak: 0,
  visualLevel: 0,
  phase: 0,
  bars: [],
  ripples: [],
  smoothedVolume: 0,
  frameIndex: 0,
  variantIndex: 0,
  monitorRunning: false,
  frameTimer: null,
};
const xtrUi = {
  contexts: new Map(),
  layer: "intro",
  selectedDeviceId: null,
  longPressTimers: new Map(),
  longPressFired: new Set(),
  homePressStartedAt: 0,
  homePressAnimTimer: null,
  voicePressedContexts: new Set(),
  voiceFrameTimer: null,
  voicePhase: 0,
  voiceWave: {
    latestLevel: 0,
    latestPeak: 0,
    visualLevel: 0,
    smoothedVolume: 0,
    ripples: [],
    frameIndex: 0,
  },
  voiceStatus: {
    state: "idle",
    ttsEnabled: true,
    handsFree: false,
    ttsAudioLevel: 0,
    ttsAudioPeak: 0,
    ttsAudioActive: false,
    ttsAudioUpdatedAt: 0,
    updatedAt: 0,
    pttButtonOpacity: 1,
  },
  introFrameTimer: null,
  introPhase: 0,
  introStartedAt: 0,
  hiddenLongPressTimers: new Map(),
  hiddenLongPressFired: new Set(),
};

const MIC_VISUAL_MAX_LEVEL = 0.8;
const MIC_VOLUME_THRESHOLD = 0.45;
const MIC_VISUAL_BRIGHTNESS_BASE = 0.9;
const MIC_VISUAL_BRIGHTNESS_RANGE = 0.8;
const MIC_WAVE_VARIANT_COUNT = 15;
const MIC_WAVE_FULL_COLS = 5;
const MIC_WAVE_FULL_ROWS = 3;
const MIC_RENDER_INTERVAL_MS = 90;
const UI_RENDER_INTERVAL_MS = 120;
const INTRO_TEXT_CHARACTER_DELAY_MS = 80;
const INTRO_TEXT_LINE_1_DELAY_MS = 500;
const INTRO_TEXT_LINE_2_DELAY_MS = 1300;
const INTRO_TEXT_GLITCH_DURATION_MS = 2000;
const INTRO_TEXT_GLITCH_INTERVAL_MS = 3000;
const REPO_ROOT = findRepoRoot(__dirname);
const INTRO_LOGO_PATH = resolveIntroLogoPath();
const INTRO_LOGO_DATA_URI = loadImageDataUri(INTRO_LOGO_PATH, "image/png");
const MIC_REFERENCE_WIDTH = 2500;
const MIC_REFERENCE_HEIGHT = 1500;
const MIC_RIPPLE_RANGE_MULTIPLIER = 1.65;
const MIC_RIPPLE_ALPHA_DECAY = 0.007;
const MIC_MAX_RIPPLES = 18;
const TTS_AUDIO_FRESH_MS = 700;
const UBIKE_XTR_PROMPT = "請把以下任務指派給 ubike xtr：\n";
const UBIKE_XTR_OVERLAY_LABEL = "YouBike";
const CLEAR_TITLE_RESTORE = "__xtr_clear_title__";
const UBIKE_SUCCESS_PULSE_MS = 1100;
const LONG_PRESS_MS = 650;
const HIDDEN_COMMAND_TEXT = "請介紹你自己";
const HIDDEN_COMMAND_POSITION = "4,0";
const HOME_PRESS_ANIM_INTERVAL_MS = 30;
const MANAGED_ACTIONS = new Set([
  "com.xtr.codexagent.micwave",
  "com.xtr.codexagent.ubikextr",
]);
const CONSOLE_NODE_META = {
  user: { color: "#4ADEFF", label: "User XTR", icon: "◉" },
  gmail: { color: "#FB7185", label: "Gmail XTR", icon: "✉" },
  youbike: { color: "#FFB648", label: "YouBike XTR", icon: "⚲" },
  line_oa: { color: "#00B900", label: "Line OA XTR", icon: "✉" },
  tuya_plug: { color: "#60A5FA", label: "Tuya Plug XTR", icon: "⏻" },
  toshl: { color: "#F59E0B", label: "Toshl XTR", icon: "¥" },
  voice: { color: "#38BDF8", label: "Voice XTR", icon: "Mic" }, 
  maps: { color: "#34D399", label: "Maps XTR", icon: "◈" },
  judge: { color: "#A855F7", label: "Judge XTR", icon: "★" },
  guest: { color: "#c4b5fd", label: "Guest XTR", icon: "◎" },
  translator: { color: "#F0ABFC", label: "Translator", icon: "⇌" },
  winh: { color: "#8B5CF6", label: "Win+H", icon: "⌨" },
  new_chat: { color: "#22D3EE", label: "新增對話", icon: "+" },
  model_switch: { color: "#A78BFA", label: "切換模型", icon: "BrainCircuit" },
  send_input: { color: "#38BDF8", label: "送出", icon: "Send" },
  prev_msg:   { color: "#94A3B8", label: "上一則", icon: "◀" },
  next_msg:   { color: "#94A3B8", label: "下一則", icon: "▶" },
};
const DEVICE_ITEMS = [
  { id: "toshl", kind: "toshl", position: "1,0", iconFile: "toshl.svg", prompt: "請把以下任務指派給 toshl xtr：\n" },
  { id: "gmail", kind: "gmail", position: "2,0", iconFile: "gmail.svg", prompt: "請把以下任務指派給 gmail xtr：\n" },
  { id: "lineoa", kind: "line_oa", position: "3,0", iconFile: "line.svg", prompt: "請把以下任務指派給 line oa xtr：\n" },
  { id: "tuya", kind: "tuya_plug", position: "4,0", iconFile: "power.svg", prompt: "請把以下任務指派給 tuya plug xtr：\n" },
  { id: "user", kind: "user", position: "1,1", iconFile: "user.svg", prompt: "" },
  { id: "youbike", kind: "youbike", position: "2,1", iconFile: "bike.svg", prompt: UBIKE_XTR_PROMPT },
  { id: "computer", kind: "guest", label: "Computer XTR", position: "3,1", iconFile: "computer.svg", prompt: "請把以下任務指派給 computer xtr：\n" },
  { id: "winh", kind: "winh", label: "Voice Input", position: "4,1", iconFile: "mic.svg" },
  { id: "voice", kind: "voice", label: "Voice XTR", position: "2,2", iconFile: "mic.svg" },
  { id: "new-chat", kind: "new_chat", label: "新增對話", position: "0,1", iconFile: "new-chat.svg" },
  { id: "send-input", kind: "send_input", label: "送出", position: "4,2", iconFile: "send.svg" },
  { id: "prev-msg", kind: "prev_msg", label: "上一則", position: "0,2", iconFile: "prev.svg" },
  { id: "next-msg", kind: "next_msg", label: "下一則", position: "1,2", iconFile: "next.svg" },
  { id: "model-switch", kind: "model_switch", label: "切換模型", position: "3,2", iconFile: "model.svg" },
];
const DEVICE_BY_POSITION = new Map(DEVICE_ITEMS.map((item) => [item.position, item]));
const DEVICE_BY_ID = new Map(DEVICE_ITEMS.map((item) => [item.id, item]));
const VOICE_CONTROL_ITEMS = [
  { id: "voice-tts", position: "1,2", label: "語音播放", iconFile: "volume.svg", color: "#2563EB" },
  { id: "voice-ptt", position: "2,2", label: "開始講話", iconFile: "mic.svg", color: "#38BDF8" },
  { id: "model-switch", kind: "model_switch", label: "切換模型", position: "3,2", iconFile: "model.svg", color: "#A78BFA" },
  { id: "new-chat", kind: "new_chat", label: "新增對話", position: "4,0", iconFile: "new-chat.svg", color: "#22D3EE" },
];
const VOICE_CONTROL_BY_POSITION = new Map(VOICE_CONTROL_ITEMS.map((item) => [item.position, item]));
const MENU_ICON_CACHE = new Map();

function freePort(port) {
  if (process.platform !== "win32") return;
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n")) {
      if (!line.includes("LISTENING")) continue;
      if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`) && !line.match(new RegExp(`:${port}\\s`))) continue;
      const pid = parseInt(line.trim().split(/\s+/).pop(), 10);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        try { execFileSync("taskkill", ["/F", "/PID", String(pid)]); } catch (_) {}
      }
    }
  } catch (_) {}
}

freePort(BRIDGE_PORT);

const bridgeServer = new WebSocket.Server({ port: BRIDGE_PORT }, () => {
  console.log(`[XTR] Bridge 啟動於 ws://localhost:${BRIDGE_PORT}`);
});

bridgeServer.on("connection", (client) => {
  bridgeClients.add(client);
  if (micWave.activeContexts.size > 0 && !micWave.monitorRunning) {
    const [context] = micWave.activeContexts.keys();
    setTimeout(() => startMicMonitor(context), 200);
  } else if (xtrUi.layer === "voice" && !micWave.monitorRunning) {
    setTimeout(() => activateVoiceMicMonitor(), 200);
  }
  client.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "mic-level") {
        handleMicLevel(msg);
        return;
      }
      if (msg.type === "mic-status") {
        handleMicStatus(msg);
        return;
      }
      if (msg.type === "voice-status") {
        handleVoiceStatus(msg);
        return;
      }
      if (msg.type === "tts-audio-level") {
        handleTtsAudioLevel(msg);
        return;
      }
      if (msg.type === "mic-variant") {
        handleMicVariantMessage(msg);
        return;
      }
      if (msg.id && pendingCallbacks.has(msg.id)) {
        const cb = pendingCallbacks.get(msg.id);
        pendingCallbacks.delete(msg.id);
        clearTimeout(cb.timer);
        if (cb.onResult) {
          cb.onResult(msg.result);
        } else {
          renderBridgeResult(cb.context, msg.result, cb.label);
        }
      }
    } catch (_) {}
  });
  client.on("close", () => bridgeClients.delete(client));
  client.on("error", () => bridgeClients.delete(client));
});

function renderBridgeResult(context, result, label) {
  if (result === "TEXT_REPLACED") {
    triggerSuccessPulse(context);
    setTitle(context, "");
    setTimeout(() => setTitle(context, label === CLEAR_TITLE_RESTORE ? "" : label), 1200);
    return;
  }

  const display = {
    OK:                   { title: "完成",          ok: true  },
    ALREADY_LIKED:        { title: "已按讚",        ok: true  },
    NOT_FOUND:            { title: "❌ 找不到",    ok: false },
    NO_ACTIVE_TAB:        { title: "無作用\n分頁", ok: false },
    CONTENT_SCRIPT_ERROR: { title: "重整\n分頁",   ok: false },
    INVALID_SELECTOR:     { title: "選擇器\n錯誤", ok: false },
    NO_SELECTOR:          { title: "未設定\nselector", ok: false },
    MIC_STARTED:          { title: "Mic\n啟動",    ok: true  },
    MIC_STOPPED:          { title: "Mic\n停止",    ok: true  },
    MIC_PERMISSION:       { title: "允許\nMic",    ok: false },
    MIC_ERROR:            { title: "Mic\n錯誤",    ok: false },
    MIC_UNSUPPORTED:      { title: "不支援\nMic",  ok: false },
    TEXT_INSERTED:        { title: "已輸入",        ok: true  },
    TEXT_REPLACED:        { title: "已替換",        ok: true  },
    NO_TEXTBOX:           { title: "找不到\n輸入框", ok: false },
    HOST_WRONG_PAGE:      { title: "不是\nXTR",     ok: false },
    HOST_LOGIN_REQUIRED:  { title: "請先\n登入",    ok: false },
    VOICE_MODE:           { title: "語音\n模式",    ok: true  },
    VOICE_PTT_START:      { title: "",              ok: true, quiet: true },
    VOICE_PTT_STOP:       { title: "",              ok: true, quiet: true },
    HANDS_FREE_TOGGLED:   { title: "免持\n切換",    ok: true  },
    VOICE_NOT_READY:      { title: "語音\n未就緒",  ok: false },
    VOICE_UNAVAILABLE:    { title: "找不到\n語音",  ok: false },
    TTS_TOGGLED:          { title: "播放\n切換",    ok: true  },
    UNKNOWN_ACTION:       { title: "未知\n動作",   ok: false },
    WRONG_PAGE:           { title: "不是\nCodex",  ok: false },
    NEW_CHAT_CREATED:     { title: "",              ok: true, quiet: true },
    HOST_MESSAGE_SENT:    { title: "已送出",        ok: true  },
    HOST_SEND_NOT_FOUND:  { title: "找不到\n送出",  ok: false },
    HOST_INPUT_EMPTY:     { title: "沒有\n輸入",    ok: false },
    HOST_NAV_OK:          { title: "",              ok: true, quiet: true },
    HOST_AT_FIRST:        { title: "第一則",        ok: true  },
    HOST_AT_LAST:         { title: "最後一則",      ok: true  },
    MODEL_GPT_4O:         { title: "GPT-4o",       ok: true  },
    MODEL_GPT_4O_MINI:    { title: "GPT\nmini",    ok: true  },
    MODEL_CLAUDE_SONNET_46: { title: "Claude\nSonnet", ok: true },
    MODEL_CLAUDE_OPUS_47: { title: "Claude\nOpus", ok: true  },
    MODEL_SWITCHED:       { title: "模型\n已切換", ok: true  },
    MODEL_NOT_FOUND:      { title: "找不到\n模型", ok: false },
    MODEL_MENU_NOT_FOUND: { title: "找不到\n選單", ok: false },
    MODEL_SWITCH_LOCKED:  { title: "模型\n鎖定",   ok: false },
  }[result] || { title: `⚠️ ${String(result).slice(0, 8)}`, ok: false };

  setTitle(context, display.title);
  if (!display.quiet && !display.ok) {
    showAlert(context);
  }
  const restoreTitle = label === CLEAR_TITLE_RESTORE
    ? ""
    : (label === "" && result !== "MIC_STARTED" ? display.title : label);
  setTimeout(() => setTitle(context, restoreTitle), 3000);
}

function triggerSuccessPulse(context) {
  const state = micWave.activeContexts.get(context);
  const tile = state?.tile || getMicTileSettings({ tileCols: MIC_WAVE_FULL_COLS, tileRows: MIC_WAVE_FULL_ROWS, tileX: 2, tileY: 1 });

  micWave.successPulseStartedAt = Date.now();
  micWave.successPulseDurationMs = UBIKE_SUCCESS_PULSE_MS;
  micWave.successPulseOrigin = {
    x: tile.x + 0.5,
    y: tile.y + 0.5,
    cols: tile.cols,
    rows: tile.rows,
  };
  startMicRenderLoop();
  renderMicWaveFrame();
}

/**
 * 透過 Bridge 發送一個動作到 Chrome 外掛，等待回應
 */
function sendBridgeAction(context, action, label, extra = {}, pendingTitle = "點擊中...") {
  const restoreLabel = label === CLEAR_TITLE_RESTORE ? "" : label;
  if (bridgeClients.size === 0) {
    setTitle(context, "Chrome\n未連線");
    showAlert(context);
    setTimeout(() => setTitle(context, restoreLabel), 3000);
    return;
  }

  const id = Date.now().toString();
  setTitle(context, pendingTitle);

  const timer = setTimeout(() => {
    pendingCallbacks.delete(id);
    setTitle(context, "⏱️ 逾時");
    showAlert(context);
    setTimeout(() => setTitle(context, restoreLabel), 3000);
  }, 5000);

  pendingCallbacks.set(id, { context, timer, label });

  const data = JSON.stringify({ id, action, ...extra });
  for (const c of bridgeClients) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
}

function sendBridgeRequest(context, payload, label, timeoutMs = 5000) {
  if (bridgeClients.size === 0) {
    setTitle(context, "Chrome\n未連線");
    showAlert(context);
    setTimeout(() => setTitle(context, label), 3000);
    return false;
  }

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const timer = setTimeout(() => {
    pendingCallbacks.delete(id);
    setTitle(context, "⏱️ 逾時");
    showAlert(context);
    setTimeout(() => setTitle(context, label), 3000);
  }, timeoutMs);

  pendingCallbacks.set(id, { context, timer, label });
  const data = JSON.stringify({ id, ...payload });
  for (const c of bridgeClients) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// Stream Deck WebSocket 連線
// ═══════════════════════════════════════════════════════════
const args = process.argv.slice(2);
const params = {};
for (let i = 0; i < args.length; i += 2) {
  params[args[i].replace("-", "")] = args[i + 1];
}

if (!params.port || !params.pluginUUID) {
  console.error("[XTR] 缺少必要參數 (port / pluginUUID)");
  process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${params.port}`);

ws.on("open", () => {
  send({ event: params.registerEvent, uuid: params.pluginUUID });
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  switch (msg.event) {
    case "willAppear": handleWillAppear(msg); break;
    case "willDisappear": handleWillDisappear(msg); break;
    case "keyDown":    handleKeyDown(msg);    break;
    case "keyUp":      handleKeyUp(msg);      break;
  }
});

ws.on("error", (err) => console.error("[XTR] WebSocket 錯誤:", err));

function send(obj) { ws.send(JSON.stringify(obj)); }
function setTitle(ctx, title) {
  send({ event: "setTitle", context: ctx, payload: { title, target: 0 } });
}
function showAlert(ctx) { send({ event: "showAlert", context: ctx }); }
function setImage(ctx, image) {
  send({ event: "setImage", context: ctx, payload: { image, target: 0 } });
}

// ═══════════════════════════════════════════════════════════
// Action 路由
// ═══════════════════════════════════════════════════════════
const ACTION_TITLES = {
  "com.xtr.codexagent.runscript": "XTR\n專案",
  "com.xtr.codexagent.sysinfo":   "系統\n資訊",
  "com.xtr.codexagent.openapp":   "開啟\nCodex",
  "com.xtr.codexagent.webclick":  "Codex\n送出",
  "com.xtr.codexagent.customclick": "自訂\n點擊",
  "com.xtr.codexagent.ubikextr": "ubike\nxtr",
  "com.xtr.codexagent.micwave": "Mic\nWave",
};

function handleWillAppear(msg) {
  if (MANAGED_ACTIONS.has(msg.action)) {
    registerUiContext(msg);
    renderUiLayer();
    return;
  }

  const title = ACTION_TITLES[msg.action];
  if (title) setTitle(msg.context, title);
}

function handleWillDisappear(msg) {
  if (MANAGED_ACTIONS.has(msg.action)) {
    unregisterUiContext(msg.context);
  }
}

function handleKeyDown(msg) {
  const ctx = msg.context;
  const settings = msg.payload?.settings || {};
  if (MANAGED_ACTIONS.has(msg.action)) {
    handleManagedKeyDown(msg);
    return;
  }

  switch (msg.action) {
    case "com.xtr.codexagent.runscript": runScript(ctx); break;
    case "com.xtr.codexagent.sysinfo":   showSysInfo(ctx); break;
    case "com.xtr.codexagent.openapp":   openApp(ctx); break;
    case "com.xtr.codexagent.webclick":
      sendBridgeAction(
        ctx,
        settings.preset || "codex-send",
        ACTION_TITLES["com.xtr.codexagent.webclick"]
      );
      break;
    case "com.xtr.codexagent.customclick":
      sendBridgeAction(
        ctx,
        settings.preset || "click",
        ACTION_TITLES["com.xtr.codexagent.customclick"],
        { selector: settings.selector || settings.cssSelector || "" }
      );
      break;
  }
}

function handleKeyUp(msg) {
  if (!MANAGED_ACTIONS.has(msg.action)) return;
  handleManagedKeyUp(msg);
}

function registerUiContext(msg) {
  const settings = msg.payload?.settings || {};
  xtrUi.contexts.set(msg.context, {
    action: msg.action,
    settings,
    tile: getManagedTileSettings(settings, msg.payload?.coordinates),
  });
  setTitle(msg.context, "");
}

function unregisterUiContext(context) {
  clearLongPressTimer(context);
  xtrUi.longPressFired.delete(context);
  xtrUi.voicePressedContexts.delete(context);
  xtrUi.contexts.delete(context);
  stopMicWaveContext(context);
  if (xtrUi.contexts.size === 0) {
    deactivateDetailMicContexts();
    stopVoiceRenderLoop();
    stopIntroRenderLoop();
  }
}

function handleManagedKeyDown(msg) {
  const state = getOrRegisterUiContext(msg);
  if (!state) return;

  if (xtrUi.layer !== "intro" && isTopLeftTile(state.tile)) {
    startHomeLongPress(msg.context);
    return;
  }

  if (xtrUi.layer === "intro") {
    if (getTileKey(state.tile) === HIDDEN_COMMAND_POSITION) {
      startHiddenLongPress(msg.context, state);
      return;
    }
    xtrUi.layer = "menu";
    xtrUi.selectedDeviceId = null;
    xtrUi.introStartedAt = 0;
    renderUiLayer();
    return;
  }

  if (xtrUi.layer === "menu") {
    const device = DEVICE_BY_POSITION.get(getTileKey(state.tile));
    if (!device) return;
    if (device.id === "voice") {
      xtrUi.layer = "voice";
      xtrUi.selectedDeviceId = null;
      renderUiLayer();
      sendBridgeAction(
        msg.context,
        "host-voice-mode",
        CLEAR_TITLE_RESTORE,
        getHostBridgeExtras(state),
        "切換中..."
      );
      return;
    }
    if (device.id === "model-switch") {
      sendBridgeAction(
        msg.context,
        "host-toggle-model",
        CLEAR_TITLE_RESTORE,
        getHostBridgeExtras(state),
        "切換中..."
      );
      return;
    }
    if (device.id === "winh") {
      if (bridgeClients.size === 0) {
        pressWinH(msg.context);
        return;
      }
      const id = Date.now().toString();
      const ctx = msg.context;
      const timer = setTimeout(() => {
        pendingCallbacks.delete(id);
        pressWinH(ctx);
      }, 2000);
      pendingCallbacks.set(id, { context: ctx, timer, label: CLEAR_TITLE_RESTORE, onResult: () => pressWinH(ctx) });
      for (const client of bridgeClients) {
        client.send(JSON.stringify({ type: "action", id, action: "host-focus-input", ...getHostBridgeExtras(state) }));
      }
      return;
    }
    if (device.id === "new-chat") {
      sendBridgeAction(
        msg.context,
        "host-new-chat",
        CLEAR_TITLE_RESTORE,
        getHostBridgeExtras(state),
        "新增中..."
      );
      return;
    }
    if (device.id === "send-input") {
      sendBridgeAction(
        msg.context,
        "host-send-input",
        CLEAR_TITLE_RESTORE,
        getHostBridgeExtras(state),
        "送出中..."
      );
      return;
    }
    if (device.id === "prev-msg") {
      sendBridgeAction(
        msg.context,
        "host-prev-msg",
        CLEAR_TITLE_RESTORE,
        getHostBridgeExtras(state),
        ""
      );
      return;
    }
    if (device.id === "next-msg") {
      sendBridgeAction(
        msg.context,
        "host-next-msg",
        CLEAR_TITLE_RESTORE,
        getHostBridgeExtras(state),
        ""
      );
      return;
    }
    sendDevicePrompt(msg.context, state, device);
    return;
  }

  if (xtrUi.layer === "detail") {
    handleDetailKeyDown(msg.context, state);
    return;
  }

  if (xtrUi.layer === "voice") {
    handleVoiceKeyDown(msg.context, state);
  }
}

function handleManagedKeyUp(msg) {
  const state = xtrUi.contexts.get(msg.context);
  clearLongPressTimer(msg.context);
  const longPressFired = xtrUi.longPressFired.has(msg.context);
  if (longPressFired) {
    xtrUi.longPressFired.delete(msg.context);
  }
  if (xtrUi.hiddenLongPressFired.has(msg.context)) {
    xtrUi.hiddenLongPressFired.delete(msg.context);
  } else if (xtrUi.hiddenLongPressTimers.has(msg.context)) {
    clearHiddenLongPressTimer(msg.context);
    if (xtrUi.layer === "intro") {
      xtrUi.layer = "menu";
      xtrUi.selectedDeviceId = null;
      xtrUi.introStartedAt = 0;
      renderUiLayer();
    }
  }
  if (xtrUi.layer === "voice") {
    handleVoiceKeyUp(msg.context, state);
    if (!longPressFired && isTopLeftTile(state?.tile)) {
      const userDevice = DEVICE_BY_ID.get("user");
      if (userDevice) sendDevicePrompt(msg.context, state, userDevice);
      xtrUi.layer = "menu";
      xtrUi.selectedDeviceId = null;
      renderUiLayer();
    }
  }
}

function handleDetailKeyDown(context, state) {
  const device = DEVICE_BY_ID.get(xtrUi.selectedDeviceId);
  if (!device || !isCenterTile(state.tile)) return;

  if (device.id === "youbike") {
    sendBridgeAction(
      context,
      state.settings.preset || "host-ubike-xtr",
      CLEAR_TITLE_RESTORE,
      {
        selector: state.settings.selector || state.settings.cssSelector || "",
        text: resolveDevicePromptText(state.settings, device, UBIKE_XTR_PROMPT),
        allowedHosts: state.settings.allowedHosts || state.settings.hosts || "",
      },
      "輸入中..."
    );
    return;
  }

  triggerSuccessPulse(context);
}

function sendDevicePrompt(context, state, device) {
  sendBridgeAction(
    context,
    state.settings.preset || "host-agent-xtr",
    CLEAR_TITLE_RESTORE,
    {
      selector: state.settings.selector || state.settings.cssSelector || "",
      text: resolveDevicePromptText(state.settings, device, getDefaultDevicePrompt(device)),
      allowedHosts: state.settings.allowedHosts || state.settings.hosts || "",
    },
    "輸入中..."
  );
}

function resolveDevicePromptText(settings = {}, device, fallbackText) {
  if (settings.text !== undefined) return String(settings.text);
  if (settings.prompt !== undefined) return String(settings.prompt);
  if (device?.prompt !== undefined) return String(device.prompt);
  return fallbackText;
}

function getDefaultDevicePrompt(device) {
  const label = splitDeckLabel(getDeviceMeta(device).label).join(" ").trim().toLowerCase();
  return `請把以下任務指派給 ${label}：\n`;
}

function handleVoiceKeyDown(context, state) {
  const control = VOICE_CONTROL_BY_POSITION.get(getTileKey(state.tile));
  if (!control) return;

  const pttState = xtrUi.voiceStatus.state;
  const pttBlocked = pttState === "transcribing" || pttState === "thinking" || pttState === "speaking";

  if (control.id === "voice-ptt") {
    if (pttBlocked) return;
    if (xtrUi.voicePressedContexts.has(context)) return;
    xtrUi.voicePressedContexts.add(context);
    setVoiceStatus({ state: "listening" });
    sendBridgeAction(
      context,
      "host-voice-ptt-start",
      CLEAR_TITLE_RESTORE,
      getHostBridgeExtras(state),
      ""
    );
    return;
  }

  if (pttBlocked) return;

  if (control.id === "voice-tts") {
    sendBridgeAction(
      context,
      "host-voice-tts-toggle",
      CLEAR_TITLE_RESTORE,
      getHostBridgeExtras(state),
      "切換中..."
    );
    return;
  }

  if (control.id === "model-switch") {
    sendBridgeAction(
      context,
      "host-toggle-model",
      CLEAR_TITLE_RESTORE,
      getHostBridgeExtras(state),
      "切換中..."
    );
    return;
  }

  if (control.id === "new-chat") {
    sendBridgeAction(
      context,
      "host-new-chat",
      CLEAR_TITLE_RESTORE,
      getHostBridgeExtras(state),
      "新增中..."
    );
  }
}

function handleVoiceKeyUp(context, state) {
  if (!state || !xtrUi.voicePressedContexts.has(context)) return;
  const control = VOICE_CONTROL_BY_POSITION.get(getTileKey(state.tile));
  if (!control || control.id !== "voice-ptt") return;

  xtrUi.voicePressedContexts.delete(context);
  setVoiceStatus({ state: "transcribing" });
  sendBridgeAction(
    context,
    "host-voice-ptt-stop",
    CLEAR_TITLE_RESTORE,
    getHostBridgeExtras(state),
    ""
  );
}

function getHostBridgeExtras(state, extra = {}) {
  const settings = state?.settings || {};
  return {
    allowedHosts: settings.allowedHosts || settings.hosts || "",
    ...extra,
  };
}

function getOrRegisterUiContext(msg) {
  if (!xtrUi.contexts.has(msg.context)) {
    registerUiContext(msg);
  } else if (msg.payload?.settings || msg.payload?.coordinates) {
    const current = xtrUi.contexts.get(msg.context);
    const settings = msg.payload?.settings || current.settings || {};
    xtrUi.contexts.set(msg.context, {
      ...current,
      settings,
      tile: getManagedTileSettings(settings, msg.payload?.coordinates || current.tile),
    });
  }
  return xtrUi.contexts.get(msg.context);
}

function startHomeLongPress(context) {
  if (xtrUi.longPressTimers.has(context)) return;
  xtrUi.homePressStartedAt = Date.now();
  startHomePressAnimation();
  const timer = setTimeout(() => {
    xtrUi.longPressTimers.delete(context);
    xtrUi.longPressFired.add(context);
    stopHomePressAnimation();
    xtrUi.layer = xtrUi.layer === "detail" || xtrUi.layer === "voice" ? "menu" : "intro";
    xtrUi.selectedDeviceId = null;
    if (xtrUi.layer === "intro") {
      xtrUi.introStartedAt = Date.now();
      xtrUi.introPhase = 0;
    }
    renderUiLayer();
  }, LONG_PRESS_MS);
  xtrUi.longPressTimers.set(context, timer);
}

function clearLongPressTimer(context) {
  const timer = xtrUi.longPressTimers.get(context);
  if (!timer) return;
  clearTimeout(timer);
  xtrUi.longPressTimers.delete(context);
  stopHomePressAnimation();
  for (const [ctx, state] of xtrUi.contexts.entries()) {
    if (!isTopLeftTile(state.tile)) continue;
    setTitle(ctx, "");
    if (xtrUi.layer === "menu") setImage(ctx, renderMenuTileImage(state.tile));
    break;
  }
}

function startHiddenLongPress(context, state) {
  if (xtrUi.hiddenLongPressTimers.has(context)) return;
  const timer = setTimeout(() => {
    xtrUi.hiddenLongPressTimers.delete(context);
    xtrUi.hiddenLongPressFired.add(context);
    sendHiddenCommand(context, state);
  }, LONG_PRESS_MS);
  xtrUi.hiddenLongPressTimers.set(context, timer);
}

function clearHiddenLongPressTimer(context) {
  const timer = xtrUi.hiddenLongPressTimers.get(context);
  if (!timer) return;
  clearTimeout(timer);
  xtrUi.hiddenLongPressTimers.delete(context);
}

function sendHiddenCommand(context, state) {
  if (bridgeClients.size === 0) {
    setTitle(context, "Chrome\n未連線");
    showAlert(context);
    setTimeout(() => setTitle(context, ""), 3000);
    return;
  }
  const id = `${Date.now()}-hidden`;
  const timer = setTimeout(() => {
    pendingCallbacks.delete(id);
    setTitle(context, "⏱️ 逾時");
    showAlert(context);
    setTimeout(() => setTitle(context, ""), 3000);
  }, 5000);
  pendingCallbacks.set(id, {
    context,
    timer,
    label: CLEAR_TITLE_RESTORE,
    onResult: (result) => {
      if (result === "TEXT_REPLACED" || result === "TEXT_INSERTED") {
        sendBridgeAction(context, "host-send-input", CLEAR_TITLE_RESTORE, getHostBridgeExtras(state), "");
      }
    },
  });
  setTitle(context, "傳送中...");
  const data = JSON.stringify({
    id,
    action: "host-agent-xtr",
    text: HIDDEN_COMMAND_TEXT,
    selector: state.settings.selector || state.settings.cssSelector || "",
    allowedHosts: state.settings.allowedHosts || state.settings.hosts || "",
  });
  for (const c of bridgeClients) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
}

function startHomePressAnimation() {
  if (xtrUi.homePressAnimTimer) return;
  xtrUi.homePressAnimTimer = setInterval(renderHomePressFrame, HOME_PRESS_ANIM_INTERVAL_MS);
}

function stopHomePressAnimation() {
  if (xtrUi.homePressAnimTimer) {
    clearInterval(xtrUi.homePressAnimTimer);
    xtrUi.homePressAnimTimer = null;
  }
  xtrUi.homePressStartedAt = 0;
}

function renderHomePressFrame() {
  if (!xtrUi.homePressStartedAt || xtrUi.contexts.size === 0) {
    stopHomePressAnimation();
    return;
  }
  if (xtrUi.layer !== "menu" && xtrUi.layer !== "voice") {
    stopHomePressAnimation();
    return;
  }
  for (const [ctx, state] of xtrUi.contexts.entries()) {
    if (!isTopLeftTile(state.tile)) continue;
    setTitle(ctx, "");
    setImage(ctx, xtrUi.layer === "voice" ? renderVoiceTileImage(state.tile) : renderMenuTileImage(state.tile));
    break;
  }
}

function renderUiLayer() {
  if (xtrUi.layer === "detail") {
    stopVoiceRenderLoop();
    stopIntroRenderLoop();
    activateDetailMicContexts();
    return;
  }

  deactivateDetailMicContexts();
  if (xtrUi.layer === "voice") {
    stopIntroRenderLoop();
    activateVoiceMicMonitor();
    startVoiceRenderLoop();
    renderVoiceFrame();
    return;
  }

  deactivateVoiceMicMonitor();
  stopVoiceRenderLoop();
  if (xtrUi.layer === "intro") {
    startIntroRenderLoop();
    renderIntroFrame();
    return;
  }

  stopIntroRenderLoop();
  for (const [context, state] of xtrUi.contexts.entries()) {
    setTitle(context, "");
    setImage(context, renderMenuTileImage(state.tile));
  }
}

function startIntroRenderLoop() {
  if (xtrUi.introFrameTimer) return;
  xtrUi.introFrameTimer = setInterval(renderIntroFrame, UI_RENDER_INTERVAL_MS);
}

function stopIntroRenderLoop() {
  if (!xtrUi.introFrameTimer) return;
  clearInterval(xtrUi.introFrameTimer);
  xtrUi.introFrameTimer = null;
}

function renderIntroFrame() {
  if (xtrUi.layer !== "intro" || xtrUi.contexts.size === 0) {
    stopIntroRenderLoop();
    return;
  }

  if (!xtrUi.introStartedAt) {
    xtrUi.introStartedAt = Date.now();
  }

  xtrUi.introPhase += 0.16;
  const elapsedMs = Date.now() - xtrUi.introStartedAt;
  for (const [context, state] of xtrUi.contexts.entries()) {
    setTitle(context, "");
    setImage(context, renderIntroTileImage(state.tile, xtrUi.introPhase, elapsedMs));
  }
}

function setVoiceStatus(next = {}) {
  xtrUi.voiceStatus = {
    ...xtrUi.voiceStatus,
    ...next,
    updatedAt: Date.now(),
  };
  if (xtrUi.layer === "voice") {
    startVoiceRenderLoop();
    renderVoiceFrame();
  }
}

function handleVoiceStatus(msg) {
  setVoiceStatus({
    state: msg.state || xtrUi.voiceStatus.state || "idle",
    ttsEnabled: msg.ttsEnabled !== undefined ? Boolean(msg.ttsEnabled) : xtrUi.voiceStatus.ttsEnabled,
    handsFree: msg.handsFree !== undefined ? Boolean(msg.handsFree) : xtrUi.voiceStatus.handsFree,
  });
}

function handleTtsAudioLevel(msg) {
  setVoiceStatus({
    ttsAudioLevel: clampNumber(msg.level, 0, MIC_VISUAL_MAX_LEVEL),
    ttsAudioPeak: clampNumber(msg.peak, 0, MIC_VISUAL_MAX_LEVEL),
    ttsAudioActive: Boolean(msg.active),
    ttsAudioUpdatedAt: Date.now(),
  });
}

function startVoiceRenderLoop() {
  if (xtrUi.voiceFrameTimer) return;
  xtrUi.voiceFrameTimer = setInterval(renderVoiceFrame, MIC_RENDER_INTERVAL_MS);
}

function stopVoiceRenderLoop() {
  if (!xtrUi.voiceFrameTimer) return;
  clearInterval(xtrUi.voiceFrameTimer);
  xtrUi.voiceFrameTimer = null;
}

function renderVoiceFrame() {
  if (xtrUi.layer !== "voice" || xtrUi.contexts.size === 0) {
    stopVoiceRenderLoop();
    return;
  }

  xtrUi.voicePhase += 0.28;
  updateVoiceWaveState();
  for (const [context, state] of xtrUi.contexts.entries()) {
    setTitle(context, "");
    setImage(context, renderVoiceTileImage(state.tile, xtrUi.voicePhase));
  }
}

function updateVoiceWaveState() {
  const state = getEffectiveVoiceVisualState();
  const ttsSpeaking = state === "speaking";
  const micListening = state === "listening";
  const liveMicLevel = clampNumber(micWave.latestLevel, 0, MIC_VISUAL_MAX_LEVEL);
  const targetLevel = ttsSpeaking
    ? clampNumber(xtrUi.voiceStatus.ttsAudioLevel, 0, MIC_VISUAL_MAX_LEVEL)
    : (micListening ? liveMicLevel : 0);
  const targetVolume = targetLevel > 0
    ? clampNumber(targetLevel / MIC_VISUAL_MAX_LEVEL, 0, 1) * 255
    : 0;
  const waveState = xtrUi.voiceWave;
  const frameScale = MIC_RENDER_INTERVAL_MS / (1000 / 60);
  const deckScale = (MIC_WAVE_FULL_ROWS * 144) / MIC_REFERENCE_HEIGHT;
  const rippleScale = deckScale * MIC_RIPPLE_RANGE_MULTIPLIER;

  waveState.latestLevel = liveMicLevel;
  waveState.latestPeak = ttsSpeaking
    ? xtrUi.voiceStatus.ttsAudioPeak
    : (micListening ? micWave.latestPeak : 0);
  waveState.visualLevel += (targetLevel - waveState.visualLevel) * (targetLevel > 0 ? 0.42 : 1);
  waveState.smoothedVolume += (targetVolume - waveState.smoothedVolume) * 0.15;
  if (targetVolume === 0 && waveState.smoothedVolume < 0.5) {
    waveState.smoothedVolume = 0;
  }
  waveState.frameIndex += 1;

  if (targetLevel > 0 && waveState.smoothedVolume > 5 && waveState.frameIndex % 1 === 0) {
    waveState.ripples.push({
      radius: waveState.smoothedVolume * 0.5 * rippleScale,
      alpha: ttsSpeaking ? 0.52 : 0.6,
      speed: (4 + waveState.smoothedVolume * 0.08) * rippleScale * frameScale,
      lineWidth: (2 + waveState.smoothedVolume * 0.05) * deckScale * 1.18,
    });
  }

  waveState.ripples = waveState.ripples
    .map((ripple) => ({
      ...ripple,
      radius: ripple.radius + ripple.speed,
      alpha: ripple.alpha - MIC_RIPPLE_ALPHA_DECAY * frameScale,
    }))
    .filter((ripple) => ripple.alpha > 0)
    .slice(-MIC_MAX_RIPPLES);

  const pttBlocked = state === "transcribing" || state === "thinking" || state === "speaking";
  const pttOpacityTarget = pttBlocked ? 0 : 1;
  const pttOpacityCurrent = xtrUi.voiceStatus.pttButtonOpacity ?? 1;
  const pttOpacityNext = pttOpacityCurrent + (pttOpacityTarget - pttOpacityCurrent) * 0.4;
  xtrUi.voiceStatus = {
    ...xtrUi.voiceStatus,
    pttButtonOpacity: pttOpacityNext < 0.01 ? 0 : (pttOpacityNext > 0.99 ? 1 : pttOpacityNext),
  };
}

function hasFreshTtsAudio() {
  return xtrUi.voiceStatus.ttsAudioActive
    && Date.now() - (xtrUi.voiceStatus.ttsAudioUpdatedAt || 0) < TTS_AUDIO_FRESH_MS;
}

function getEffectiveVoiceVisualState() {
  const state = xtrUi.voiceStatus.state || "idle";
  if (state === "speaking" && !hasFreshTtsAudio()) return "idle";
  return state;
}

function activateVoiceMicMonitor() {
  if (bridgeClients.size === 0 || micWave.monitorRunning) return;
  const [context] = xtrUi.contexts.keys();
  if (!context) return;
  startMicMonitor(context);
}

function deactivateVoiceMicMonitor() {
  if (micWave.activeContexts.size > 0 || !micWave.monitorRunning) return;
  micWave.monitorRunning = false;
  sendBridgeControl({ type: "mic-control", command: "stop" });
}

function activateDetailMicContexts() {
  if (xtrUi.contexts.size === 0) {
    deactivateDetailMicContexts();
    return;
  }

  const device = DEVICE_BY_ID.get(xtrUi.selectedDeviceId) || DEVICE_BY_ID.get("youbike");
  const deviceMeta = getDeviceMeta(device);
  micWave.activeContexts.clear();
  for (const [context, state] of xtrUi.contexts.entries()) {
    micWave.activeContexts.set(context, {
      tile: state.tile,
      overlayLabel: isCenterTile(state.tile) ? splitDeckLabel(deviceMeta.label).join("\n") : "",
    });
    setTitle(context, "");
  }

  startMicRenderLoop();
  renderMicWaveFrame();
  if (bridgeClients.size > 0 && !micWave.monitorRunning) {
    const [context] = xtrUi.contexts.keys();
    startMicMonitor(context);
  }
}

function deactivateDetailMicContexts() {
  if (micWave.activeContexts.size === 0) return;
  micWave.activeContexts.clear();
  stopMicRenderLoop();
  if (micWave.monitorRunning) {
    micWave.monitorRunning = false;
    sendBridgeControl({ type: "mic-control", command: "stop" });
  }
}

function getManagedTileSettings(settings = {}, coordinates = {}) {
  const cols = clampInteger(settings.tileCols, 1, 8, MIC_WAVE_FULL_COLS);
  const rows = clampInteger(settings.tileRows, 1, 4, MIC_WAVE_FULL_ROWS);
  const fallbackColumn = coordinates?.column ?? coordinates?.x ?? 0;
  const fallbackRow = coordinates?.row ?? coordinates?.y ?? 0;

  return {
    x: clampInteger(settings.tileX ?? fallbackColumn, 0, cols - 1, 0),
    y: clampInteger(settings.tileY ?? fallbackRow, 0, rows - 1, 0),
    cols,
    rows,
  };
}

function getTileKey(tile) {
  return `${tile.x},${tile.y}`;
}

function isTopLeftTile(tile) {
  return tile.x === 0 && tile.y === 0;
}

function isCenterTile(tile) {
  return tile.x === 2 && tile.y === 1;
}

function renderIntroTileImage(tile, phase = 0, elapsedMs = 0) {
  const tileSize = 144;
  const canvasWidth = MIC_WAVE_FULL_COLS * tileSize;
  const canvasHeight = MIC_WAVE_FULL_ROWS * tileSize;
  const viewX = tile.x * tileSize;
  const viewY = tile.y * tileSize;
  const grid = renderDeckGrid(tileSize, "#0b5f6a", 0.34);
  const sparkLines = [0, 1, 2, 3, 4, 5].map((index) => {
    const y = 34 + index * 68 + Math.sin(phase * 0.9 + index) * 8;
    const drift = ((phase * 42 + index * 61) % 180) - 90;
    const lift = Math.cos(phase * 0.7 + index * 0.8) * 18;
    const opacity = 0.07 + ((Math.sin(phase + index) + 1) / 2) * 0.1;
    return `<path d="M ${(-120 + drift).toFixed(1)} ${y.toFixed(1)} C ${(90 + drift).toFixed(1)} ${(y - 26 + lift).toFixed(1)}, ${(250 + drift).toFixed(1)} ${(y + 34 - lift).toFixed(1)}, ${(430 + drift).toFixed(1)} ${(y + lift * 0.4).toFixed(1)} S ${(650 + drift).toFixed(1)} ${(y + 20 - lift * 0.5).toFixed(1)}, ${(850 + drift).toFixed(1)} ${(y - 10 + lift * 0.3).toFixed(1)}" fill="none" stroke="#0dd7e8" stroke-width="2" opacity="${opacity.toFixed(2)}"/>`;
  }).join("");
  const movingNodes = [0, 1, 2, 3].map((index) => {
    const cx = ((phase * 54 + index * 190) % (canvasWidth + 80)) - 40;
    const cy = 70 + index * 82 + Math.sin(phase * 1.1 + index) * 18;
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(2.2 + index * 0.35).toFixed(1)}" fill="#7eeeff" opacity="0.42"/>`;
  }).join("");
  const logo = renderIntroLogo({
    x: canvasWidth / 2,
    y: 74,
    elapsedMs,
    phase,
  });
  const line1 = renderAnimatedGlitchText({
    id: "introLine1",
    text: "當 XTR 成為 OS",
    x: canvasWidth / 2,
    y: 198,
    canvasWidth,
    elapsedMs,
    delayMs: INTRO_TEXT_LINE_1_DELAY_MS,
    phase,
    fontSize: 54,
    fontWeight: 850,
    fill: "#ffffff",
  });
  const line2 = renderAnimatedGlitchText({
    id: "introLine2",
    text: "操作方式從此改寫",
    x: canvasWidth / 2,
    y: 270,
    canvasWidth,
    elapsedMs,
    delayMs: INTRO_TEXT_LINE_2_DELAY_MS,
    phase: phase + 1.7,
    fontSize: 46,
    fontWeight: 760,
    fill: "url(#introGradientText)",
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${tileSize}" height="${tileSize}" viewBox="${viewX} ${viewY} ${tileSize} ${tileSize}">
<defs>
  <radialGradient id="introGlow" cx="50%" cy="50%" r="68%">
    <stop offset="0%" stop-color="#14343a"/>
    <stop offset="58%" stop-color="#06090c"/>
    <stop offset="100%" stop-color="#020304"/>
  </radialGradient>
  <linearGradient id="introGradientText" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="#36A9E1"/>
    <stop offset="100%" stop-color="#00FF7F"/>
  </linearGradient>
</defs>
<rect width="${canvasWidth}" height="${canvasHeight}" fill="url(#introGlow)"/>
${sparkLines}
${movingNodes}
${grid}
${logo}
${line1}
${line2}
<text x="360" y="360" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="18" font-weight="700" fill="#8aaeb4" opacity="0.82">PRESS ANY KEY</text>
<circle cx="700" cy="20" r="${(3 + Math.sin(phase * 2.4) * 1.2).toFixed(2)}" fill="#22D3EE" opacity="${(0.12 + Math.abs(Math.sin(phase * 1.8)) * 0.1).toFixed(3)}"/>
</svg>`;
  return svgToDataUrl(svg);
}

function renderIntroLogo({ x, y, elapsedMs, phase }) {
  void elapsedMs;
  void phase;
  if (!INTRO_LOGO_DATA_URI) return "";

  const width = 122;
  const height = 58;
  return `<image x="${(x - width / 2).toFixed(1)}" y="${(y - height / 2).toFixed(1)}" width="${width}" height="${height}" href="${INTRO_LOGO_DATA_URI}" xlink:href="${INTRO_LOGO_DATA_URI}" preserveAspectRatio="xMidYMid meet"/>`;
}

function renderAnimatedGlitchText(options) {
  const state = getAnimatedTextState(options.text, options.elapsedMs, options.delayMs);
  if (!state.started) return "";

  const text = escapeSvgText(state.complete ? options.text : state.displayedText);
  const showCursor = !state.complete && Math.floor(options.elapsedMs / 260) % 2 === 0;
  const cursor = showCursor ? `<tspan fill="#00FF7F">|</tspan>` : "";
  const fontFamily = "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  const textAnchor = options.textAnchor || "middle";
  const common = `text-anchor="${textAnchor}" font-family="${fontFamily}" font-size="${options.fontSize}" font-weight="${options.fontWeight}"`;
  const baseText = `${text}${cursor}`;
  const glitching = state.complete && isIntroTextGlitching(state.completeElapsedMs);
  const shadow = glitching
    ? `<text x="${(options.x - 2).toFixed(1)}" y="${(options.y - 2).toFixed(1)}" ${common} fill="#1df2f0" opacity="0.78">${text}</text>
<text x="${(options.x + 2).toFixed(1)}" y="${(options.y + 2).toFixed(1)}" ${common} fill="#E94BE8" opacity="0.72">${text}</text>`
    : "";
  const slices = glitching ? renderGlitchSlices({ ...options, text, common }) : "";

  return `<g>
${slices}
${shadow}
<text x="${options.x.toFixed(1)}" y="${options.y.toFixed(1)}" ${common} fill="${options.fill}">${baseText}</text>
</g>`;
}

function getAnimatedTextState(text, elapsedMs, delayMs) {
  if (elapsedMs < delayMs) {
    return { started: false, complete: false, displayedText: "", completeElapsedMs: 0 };
  }

  const chars = Array.from(text);
  const visibleCount = Math.min(chars.length, Math.floor((elapsedMs - delayMs) / INTRO_TEXT_CHARACTER_DELAY_MS) + 1);
  const complete = visibleCount >= chars.length;
  const completeElapsedMs = complete
    ? elapsedMs - delayMs - (chars.length - 1) * INTRO_TEXT_CHARACTER_DELAY_MS
    : 0;

  return {
    started: true,
    complete,
    displayedText: chars.slice(0, visibleCount).join(""),
    completeElapsedMs,
  };
}

function isIntroTextGlitching(completeElapsedMs) {
  if (completeElapsedMs < 0) return false;
  return completeElapsedMs % INTRO_TEXT_GLITCH_INTERVAL_MS < INTRO_TEXT_GLITCH_DURATION_MS;
}

function renderGlitchSlices(options) {
  const textTop = options.y - options.fontSize * 0.9;
  const textHeight = options.fontSize * 1.25;
  const step = Math.floor((options.elapsedMs + options.phase * 120) / UI_RENDER_INTERVAL_MS);

  return Array.from({ length: 7 }, (_, index) => {
    const topRatio = ((index * 17 + step * 13) % 92) / 100;
    const top = textTop + textHeight * topRatio;
    const height = textHeight * (0.08 + ((index + step) % 3) * 0.035);
    const dx = (((step + index * 5) % 5) - 2) * 3.2;
    const dy = (((step + index * 7) % 3) - 1) * 2.4;
    const color = index % 2 === 0 ? "#1df2f0" : "#E94BE8";
    const clipId = `${options.id}Clip${index}`;
    return `<defs><clipPath id="${clipId}"><rect x="0" y="${top.toFixed(1)}" width="${options.canvasWidth}" height="${height.toFixed(1)}"/></clipPath></defs>
<text x="${(options.x + dx).toFixed(1)}" y="${(options.y + dy).toFixed(1)}" ${options.common} fill="${color}" opacity="0.95" clip-path="url(#${clipId})">${options.text}</text>`;
  }).join("");
}

function renderMenuTileImage(tile) {
  const tileSize = 144;
  const canvasWidth = MIC_WAVE_FULL_COLS * tileSize;
  const canvasHeight = MIC_WAVE_FULL_ROWS * tileSize;
  const viewX = tile.x * tileSize;
  const viewY = tile.y * tileSize;
  const cells = getMenuCells().map((cell) => renderMenuCell(cell, tileSize)).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileSize}" height="${tileSize}" viewBox="${viewX} ${viewY} ${tileSize} ${tileSize}">
<rect width="${canvasWidth}" height="${canvasHeight}" fill="#030607"/>
<rect x="0" y="0" width="${canvasWidth}" height="${canvasHeight}" fill="#061014" opacity="0.9"/>
${cells}
</svg>`;
  return svgToDataUrl(svg);
}

function renderVoiceTileImage(tile, phase = 0) {
  const tileSize = 144;
  void phase;
  const cells = getVoiceCells().map((cell) => renderMenuCell(cell, tileSize)).join("");
  const palette = getVoiceWavePalette();
  return renderMicWaveImage(xtrUi.voiceWave.visualLevel, {
    tile,
    peak: xtrUi.voiceWave.latestPeak,
    state: xtrUi.voiceWave,
    phase: xtrUi.voicePhase,
    techColor: palette.techColor,
    bgColor: palette.bgColor,
    extraElements: cells,
  });
}

function getVoiceWavePalette() {
  const state = getEffectiveVoiceVisualState();
  if (state === "speaking") return { techColor: "#1D4ED8", bgColor: "#020617" };
  if (state === "transcribing") return { techColor: "#F59E0B", bgColor: "#100803" };
  if (state === "thinking") return { techColor: "#A855F7", bgColor: "#0b0614" };
  if (state === "armed") return { techColor: "#34D399", bgColor: "#03130E" };
  return { techColor: "#00E5FF", bgColor: "#050505" };
}

function getVoiceCells() {
  const cells = [
    {
      position: "0,0",
      kind: "home",
    },
    ...VOICE_CONTROL_ITEMS.map((item) => ({
      position: item.position,
      item,
      meta: getVoiceControlMeta(item),
      kind: "device",
    })),
  ];
  const used = new Set(cells.map((cell) => cell.position));
  for (let y = 0; y < MIC_WAVE_FULL_ROWS; y += 1) {
    for (let x = 0; x < MIC_WAVE_FULL_COLS; x += 1) {
      const position = `${x},${y}`;
      if (used.has(position)) continue;
      cells.push({
        position,
        kind: "placeholder",
        hidden: true,
      });
    }
  }
  return cells;
}

function getMenuCells() {
  const cells = [
    {
      position: "0,0",
      kind: "home",
    },
    ...DEVICE_ITEMS.map((item) => ({
      position: item.position,
      item,
      meta: getDeviceMeta(item),
      kind: "device",
    })),
  ];
  const used = new Set(cells.map((cell) => cell.position));
  for (let y = 0; y < MIC_WAVE_FULL_ROWS; y += 1) {
    for (let x = 0; x < MIC_WAVE_FULL_COLS; x += 1) {
      const position = `${x},${y}`;
      if (used.has(position)) continue;
      cells.push({
        position,
        kind: "placeholder",
        hidden: true,
      });
    }
  }
  return cells;
}

function getDeviceMeta(device) {
  if (!device) return CONSOLE_NODE_META.guest;
  const base = CONSOLE_NODE_META[device.kind] || CONSOLE_NODE_META.guest;
  return {
    ...base,
    label: device.label || base.label,
    iconDataUri: device.iconFile ? loadMenuIconDataUri(device.iconFile, base.color) : "",
  };
}

function getVoiceControlMeta(control) {
  const buttonsOpacity = xtrUi.voiceStatus.pttButtonOpacity ?? 1;

  if (control.id === "voice-tts") {
    const enabled = xtrUi.voiceStatus.ttsEnabled !== false;
    return {
      color: enabled ? "#2563EB" : "#64748B",
      label: enabled ? "語音播放" : "播放關閉",
      opacity: buttonsOpacity,
      icon: "",
      iconDataUri: control.iconFile ? loadMenuIconDataUri(control.iconFile, enabled ? "#2563EB" : "#64748B") : "",
    };
  }

  if (control.id === "voice-ptt") {
    const state = getEffectiveVoiceVisualState();
    const label = state === "speaking" ? "播放中" : state === "listening" ? "講話中" : control.label;
    const color = state === "speaking" ? "#1D4ED8" : control.color;
    return {
      color,
      label,
      opacity: buttonsOpacity,
      icon: "",
      iconDataUri: control.iconFile ? loadMenuIconDataUri(control.iconFile, color) : "",
    };
  }

  return {
    color: control.color,
    label: control.label,
    opacity: buttonsOpacity,
    icon: "",
    iconDataUri: control.iconFile ? loadMenuIconDataUri(control.iconFile, control.color) : "",
  };
}

function loadMenuIconDataUri(iconFile, color) {
  const cacheKey = `${iconFile}:${color}`;
  if (MENU_ICON_CACHE.has(cacheKey)) return MENU_ICON_CACHE.get(cacheKey);

  const filePath = path.join(__dirname, "imgs", "menu-icons", iconFile);
  try {
    let svg = fs.readFileSync(filePath, "utf8");
    svg = svg.replace(/currentColor/g, color);
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    MENU_ICON_CACHE.set(cacheKey, dataUri);
    return dataUri;
  } catch (error) {
    console.error(`[XTR] 無法載入 menu icon: ${filePath}`, error.message);
    MENU_ICON_CACHE.set(cacheKey, "");
    return "";
  }
}

function splitDeckLabel(label) {
  const text = String(label || "").trim();
  if (!text) return [];
  if (text === "長按首頁") return ["長按", "首頁"];
  if (text === "加入裝置") return ["加入", "裝置"];
  if (text.endsWith(" XTR")) return [text.slice(0, -4), "XTR"];
  if (text.length > 10 && text.includes(" ")) {
    const words = text.split(/\s+/);
    const last = words.pop();
    return [words.join(" "), last].filter(Boolean);
  }
  return [text];
}

function renderHomeCell(col, row, tileSize) {
  const cx = col * tileSize + tileSize / 2;
  const cy = row * tileSize + tileSize / 2;
  const color = "#4ADEFF";
  const iconDataUri = loadMenuIconDataUri("back.svg", color);
  const iconSize = 52;
  const r = 56;
  const circumference = 2 * Math.PI * r;

  let progressArc;
  if (xtrUi.homePressStartedAt > 0) {
    const elapsed = Date.now() - xtrUi.homePressStartedAt;
    const progress = Math.min(1, elapsed / LONG_PRESS_MS);
    const offset = (circumference * (1 - progress)).toFixed(1);
    const glowAlpha = (0.12 + progress * 0.22).toFixed(2);
    progressArc = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="none" stroke="${color}" stroke-width="8" opacity="${glowAlpha}"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${offset}" transform="rotate(-90 ${cx.toFixed(1)} ${cy.toFixed(1)})" opacity="0.9"/>`;
  } else {
    progressArc = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="none" stroke="${color}" stroke-width="1" opacity="0.2"/>`;
  }

  const icon = iconDataUri
    ? `<image x="${(cx - iconSize / 2).toFixed(1)}" y="${(cy - iconSize / 2).toFixed(1)}" width="${iconSize}" height="${iconSize}" href="${iconDataUri}" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="48" fill="${color}">&#8592;</text>`;

  return `${progressArc}${icon}`;
}

function renderMenuCell(cell, tileSize) {
  if (cell.hidden || cell.kind === "placeholder") return "";

  const [col, row] = cell.position.split(",").map((value) => Number.parseInt(value, 10));

  if (cell.kind === "home") {
    return renderHomeCell(col, row, tileSize);
  }
  const cx = col * tileSize + tileSize / 2;
  const cy = row * tileSize + tileSize / 2;
  const isDevice = cell.kind === "device";
  const meta = cell.meta || { color: "#78939a", label: "", icon: "" };
  const color = meta.color;
  const lines = splitDeckLabel(meta.label);
  const textOpacity = isDevice ? 0.95 : 0.7;
  const iconY = cy - 29;
  const iconSize = 64;
  const icon = meta.iconDataUri
    ? `<image x="${(cx - iconSize / 2).toFixed(1)}" y="${(iconY - iconSize / 2).toFixed(1)}" width="${iconSize}" height="${iconSize}" href="${meta.iconDataUri}" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="${cx.toFixed(1)}" y="${iconY.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="${iconSize}" font-weight="800" fill="${color}">${escapeSvgText(meta.icon)}</text>`;
  const text = renderMenuLabelLines(lines, cx, cy + 32, {
    fill: "#ffffff",
    accentFill: color,
    opacity: textOpacity,
  });

  const cellOpacity = meta.opacity !== undefined ? meta.opacity : 1;
  if (cellOpacity <= 0) return "";
  const content = `${icon}${text}`;
  return cellOpacity >= 1 ? content : `<g opacity="${cellOpacity.toFixed(3)}">${content}</g>`;
}

function renderMenuLabelLines(lines, x, y, options = {}) {
  const fill = options.fill || "#ffffff";
  const accentFill = options.accentFill || fill;
  const opacity = options.opacity ?? 1;
  const safeLines = lines.slice(0, 2).map(escapeSvgText);
  if (safeLines.length === 0) return "";

  if (safeLines.length === 1) {
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="22" font-weight="800" fill="${fill}" opacity="${Number(opacity).toFixed(2)}">${safeLines[0]}</text>`;
  }

  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="22" font-weight="820" fill="${fill}" opacity="${Number(opacity).toFixed(2)}">${safeLines[0]}</text>
<text x="${x.toFixed(1)}" y="${(y + 22).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" font-weight="760" letter-spacing="2" fill="${accentFill}" opacity="${Number(opacity * 0.88).toFixed(2)}">${safeLines[1]}</text>`;
}

function renderSvgTextLines(lines, x, y, options = {}) {
  const fill = options.fill || "#ffffff";
  const opacity = options.opacity ?? 1;
  const fontSize = options.fontSize || 20;
  const fontWeight = options.fontWeight || 700;
  const lineHeight = options.lineHeight || Math.round(fontSize * 1.25);
  const safeLines = lines.slice(0, 3).map(escapeSvgText);
  const firstY = y - ((safeLines.length - 1) * lineHeight) / 2;
  return safeLines.map((line, index) => (
    `<text x="${x.toFixed(1)}" y="${(firstY + index * lineHeight).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}" opacity="${Number(opacity).toFixed(2)}">${line}</text>`
  )).join("");
}

function renderDeckGrid(tileSize, stroke, opacity) {
  const canvasWidth = MIC_WAVE_FULL_COLS * tileSize;
  const canvasHeight = MIC_WAVE_FULL_ROWS * tileSize;
  const lines = [];
  for (let x = 1; x < MIC_WAVE_FULL_COLS; x += 1) {
    lines.push(`<line x1="${x * tileSize}" y1="0" x2="${x * tileSize}" y2="${canvasHeight}" stroke="${stroke}" stroke-width="1" opacity="${opacity}"/>`);
  }
  for (let y = 1; y < MIC_WAVE_FULL_ROWS; y += 1) {
    lines.push(`<line x1="0" y1="${y * tileSize}" x2="${canvasWidth}" y2="${y * tileSize}" stroke="${stroke}" stroke-width="1" opacity="${opacity}"/>`);
  }
  return lines.join("");
}

function svgToDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function loadImageDataUri(filePath, mimeType) {
  if (!filePath) return "";
  try {
    return `data:${mimeType};base64,${fs.readFileSync(filePath).toString("base64")}`;
  } catch (error) {
    console.error(`[XTR] 無法載入圖片: ${filePath}`, error.message);
    return "";
  }
}

function resolveIntroLogoPath() {
  const candidates = [
    process.env.XTR_STREAMDECK_LOGO_PATH,
    path.join(__dirname, "imgs", "xtr-logo.png"),
    path.join(REPO_ROOT, "packages", "services", "ft", "app", "public", "xtr-logo.png"),
    path.join(REPO_ROOT, "deploy", "website", "public", "logo.png"),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function findRepoRoot(startDir) {
  let dir = startDir;
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(startDir, "..");
}

// ═══════════════════════════════════════════════════════════
// Action 實作
// ═══════════════════════════════════════════════════════════
function runScript(context) {
  setTitle(context, "執行中...");
  if (!openCodexWorkspace()) {
    setTitle(context, "Codex\n未找到");
    showAlert(context);
    setTimeout(() => setTitle(context, ACTION_TITLES["com.xtr.codexagent.runscript"]), 3000);
    return;
  }
  setTitle(context, "XTR\nProject");
  setTimeout(() => setTitle(context, ACTION_TITLES["com.xtr.codexagent.runscript"]), 3000);
}

function showSysInfo(context) {
  setTitle(context, "讀取中...");
  const start = readCpuSnapshot();
  setTimeout(() => {
    const end = readCpuSnapshot();
    const cpu = calculateCpuUsage(start, end);
    const mem = formatBytes(os.totalmem() - os.freemem());
    setTitle(context, `CPU\n${cpu}%\nMEM\n${mem}`);
    setTimeout(() => setTitle(context, ACTION_TITLES["com.xtr.codexagent.sysinfo"]), 5000);
  }, 700);
}

function openApp(context) {
  setTitle(context, "開啟中...");
  if (!openCodexApp()) {
    setTitle(context, "❌ 失敗");
    showAlert(context);
    return;
  }
  setTitle(context, "Codex\n已開啟");
  setTimeout(() => setTitle(context, ACTION_TITLES["com.xtr.codexagent.openapp"]), 2000);
}

function pressWinH(context) {
  if (process.platform !== "win32") {
    setTitle(context, "僅\nWindows");
    showAlert(context);
    setTimeout(() => renderUiLayer(), 2000);
    return;
  }
  setTitle(context, "");
  const psScript = [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class KB {',
    '    [DllImport("user32.dll")]',
    '    public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);',
    '}',
    '"@',
    'Start-Sleep -Milliseconds 50',
    '[KB]::keybd_event(0x5B, 0, 0, 0)',
    '[KB]::keybd_event(0x48, 0, 0, 0)',
    'Start-Sleep -Milliseconds 50',
    '[KB]::keybd_event(0x48, 0, 2, 0)',
    '[KB]::keybd_event(0x5B, 0, 2, 0)',
  ].join('\n');
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const proc = spawn('powershell.exe', [
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-EncodedCommand', encoded,
  ], { detached: false, stdio: ['ignore', 'ignore', 'pipe'] });
  let errOut = '';
  proc.stderr.on('data', (d) => { errOut += d.toString(); });
  proc.on('close', (code) => {
    if (code !== 0) {
      console.error('[XTR] pressWinH PowerShell error:', errOut.trim());
      setTitle(context, "❌ 失敗");
      showAlert(context);
      setTimeout(() => renderUiLayer(), 2000);
    } else {
      setTimeout(() => renderUiLayer(), 500);
    }
  });
}

function openCodexWorkspace() {
  const workspace = resolveCodexWorkspace();
  const codexCli = findCodexCli();
  if (codexCli && spawnDetached(codexCli, ["app", workspace])) return true;
  const appPath = findCodexApp();
  if (appPath && spawnDetached(appPath, [])) return true;
  return openCodexApp();
}

function openCodexApp() {
  const appPath = findCodexApp();
  if (appPath && spawnDetached(appPath, [])) return true;

  const codexCli = findCodexCli();
  if (codexCli && spawnDetached(codexCli, ["app"])) return true;

  if (process.platform === "darwin") {
    try {
      exec(`open -a "Codex"`);
      return true;
    } catch (_) {
      return false;
    }
  }

  return false;
}

function resolveCodexWorkspace() {
  if (process.env.XTR_CODEX_WORKSPACE) return process.env.XTR_CODEX_WORKSPACE;
  if (fs.existsSync(path.join(REPO_ROOT, "pnpm-workspace.yaml"))) return REPO_ROOT;
  return path.resolve(__dirname, "..");
}

function findCodexCli() {
  const candidates = [
    process.env.XTR_CODEX_BIN,
    findCommand("codex"),
    process.platform === "darwin" ? "/Applications/Codex.app/Contents/Resources/codex" : "",
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Programs", "Codex", "resources", "codex.exe") : "",
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Programs", "Codex", "codex.exe") : "",
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate) || candidate === "codex") || "";
}

function findCodexApp() {
  const candidates = [
    process.env.XTR_CODEX_APP,
    process.platform === "darwin" ? "/Applications/Codex.app" : "",
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Programs", "Codex", "Codex.exe") : "",
    process.platform === "win32" ? path.join(process.env.PROGRAMFILES || "", "Codex", "Codex.exe") : "",
    process.platform === "win32" ? path.join(process.env["PROGRAMFILES(X86)"] || "", "Codex", "Codex.exe") : "",
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function findCommand(command) {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    const output = execFileSync(lookup, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  } catch (_) {
    return "";
  }
}

function spawnDetached(command, args = []) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32" && /\.(bat|cmd)$/i.test(command),
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (error) {
    console.error(`[XTR] 無法啟動: ${command}`, error.message);
    return false;
  }
}

function readCpuSnapshot() {
  return os.cpus().reduce(
    (total, cpu) => {
      const times = cpu.times;
      total.idle += times.idle;
      total.total += times.user + times.nice + times.sys + times.idle + times.irq;
      return total;
    },
    { idle: 0, total: 0 }
  );
}

function calculateCpuUsage(start, end) {
  const idle = end.idle - start.idle;
  const total = end.total - start.total;
  if (total <= 0) return "?";
  return Math.max(0, Math.min(100, 100 - (idle / total) * 100)).toFixed(0);
}

function formatBytes(bytes) {
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)}G`;
  return `${Math.round(bytes / 1024 / 1024)}M`;
}

// ═══════════════════════════════════════════════════════════
// 麥克風聲波 Action
// ═══════════════════════════════════════════════════════════
function handleMicWaveKeyDown(context, settings = {}) {
  const tile = getMicTileSettings(settings);
  if (tile.cols === MIC_WAVE_FULL_COLS && tile.rows === MIC_WAVE_FULL_ROWS) {
    if (tile.x === 0 && tile.y === tile.rows - 1) {
      changeMicWaveVariant(-1);
    } else if (tile.x === tile.cols - 1 && tile.y === tile.rows - 1) {
      changeMicWaveVariant(1);
    }
    return;
  }

  toggleMicWave(context, settings);
}

function changeMicWaveVariant(direction) {
  micWave.variantIndex = (micWave.variantIndex + direction + MIC_WAVE_VARIANT_COUNT) % MIC_WAVE_VARIANT_COUNT;
  micWave.phase = 0;
  renderMicWaveFrame();
}

function handleMicVariantMessage(msg) {
  const index = Number.parseInt(msg.index, 10);
  if (Number.isFinite(index)) {
    micWave.variantIndex = normalizeMicVariant(index);
    micWave.phase = 0;
    renderMicWaveFrame();
    return;
  }

  const direction = msg.direction === "prev" || msg.direction === -1 ? -1 : 1;
  changeMicWaveVariant(direction);
}

function toggleMicWave(context, settings = {}) {
  if (micWave.activeContexts.has(context)) {
    stopMicWaveContext(context);
    setImage(context, renderMicWaveImage(0, { idle: true, tile: getMicTileSettings(settings) }));
    setTitle(context, "");
    return;
  }

  if (bridgeClients.size === 0) {
    setImage(context, renderMicWaveImage(0, { idle: true, error: true, tile: getMicTileSettings(settings) }));
    setTitle(context, "Chrome\n未連線");
    showAlert(context);
    setTimeout(() => setTitle(context, ""), 3000);
    return;
  }

  startMicWaveContext(context, { settings });
}

function startMicWaveContext(context, { requestMonitor = true, settings = {}, overlayLabel = "" } = {}) {
  if (micWave.activeContexts.has(context)) return;

  micWave.activeContexts.set(context, {
    tile: getMicTileSettings(settings),
    overlayLabel,
  });

  setTitle(context, "");
  setImage(context, renderMicWaveImage(0.04, {
    starting: true,
    state: micWave,
    tile: getMicTileSettings(settings),
    overlayLabel,
  }));
  startMicRenderLoop();
  if (requestMonitor) startMicMonitor(context);
}

function startMicMonitor(context) {
  if (micWave.monitorRunning) return;
  micWave.monitorRunning = sendBridgeRequest(
    context,
    { type: "mic-control", command: "start" },
    "",
    8000
  );
}

function stopMicWaveContext(context) {
  micWave.activeContexts.delete(context);

  if (micWave.activeContexts.size === 0) {
    stopMicRenderLoop();
    if (micWave.monitorRunning) {
      micWave.monitorRunning = false;
      sendBridgeControl({ type: "mic-control", command: "stop" });
    }
  }
}

function sendBridgeControl(payload) {
  if (bridgeClients.size === 0) return;
  const data = JSON.stringify(payload);
  for (const c of bridgeClients) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
}

function handleMicLevel(msg) {
  micWave.latestLevel = clampNumber(msg.level, 0, 1);
  micWave.latestPeak = clampNumber(msg.peak, 0, 1);
}

function handleMicStatus(msg) {
  if (msg.status === "started") {
    micWave.monitorRunning = true;
    for (const context of micWave.activeContexts.keys()) {
      setTitle(context, "");
    }
    return;
  }

  if (msg.status === "stopped") {
    micWave.monitorRunning = false;
    return;
  }

  if (msg.status === "permission-needed" || msg.status === "error" || msg.status === "unsupported") {
    const title = {
      "permission-needed": "允許\nMic",
      error: "Mic\n錯誤",
      unsupported: "不支援\nMic",
    }[msg.status];

    for (const [context, state] of micWave.activeContexts.entries()) {
      setTitle(context, title);
      setImage(context, renderMicWaveImage(0, {
        idle: true,
        error: true,
        state: micWave,
        tile: state.tile,
        overlayLabel: state.overlayLabel,
      }));
      showAlert(context);
    }
    micWave.monitorRunning = false;
  }
}

function startMicRenderLoop() {
  if (micWave.frameTimer) return;
  micWave.frameTimer = setInterval(renderMicWaveFrame, MIC_RENDER_INTERVAL_MS);
}

function stopMicRenderLoop() {
  if (!micWave.frameTimer) return;
  clearInterval(micWave.frameTimer);
  micWave.frameTimer = null;
}

function renderMicWaveFrame() {
  if (micWave.activeContexts.size === 0) {
    stopMicRenderLoop();
    return;
  }

  const gatedLevel = getThresholdedMicLevel(micWave.latestLevel);
  micWave.phase += gatedLevel > 0 ? 0.38 : 0;
  micWave.visualLevel += (gatedLevel - micWave.visualLevel) * (gatedLevel > 0 ? 0.42 : 1);
  updateMicRipples();
  const now = Date.now();
  const successPulse = getSuccessPulse(now);

  for (const [context, state] of micWave.activeContexts.entries()) {
    const image = renderMicWaveImage(micWave.visualLevel, {
      peak: micWave.latestPeak,
      phase: micWave.phase,
      state: micWave,
      tile: state.tile,
      overlayLabel: state.overlayLabel,
      successPulse,
    });
    setImage(context, image);
  }
}

function getSuccessPulse(now) {
  if (!micWave.successPulseStartedAt) return null;

  const duration = micWave.successPulseDurationMs || UBIKE_SUCCESS_PULSE_MS;
  const elapsed = now - micWave.successPulseStartedAt;
  if (elapsed >= duration) {
    delete micWave.successPulseStartedAt;
    delete micWave.successPulseDurationMs;
    delete micWave.successPulseOrigin;
    return null;
  }

  return {
    origin: micWave.successPulseOrigin || { x: 2.5, y: 1.5, cols: MIC_WAVE_FULL_COLS, rows: MIC_WAVE_FULL_ROWS },
    progress: clampNumber(elapsed / duration, 0, 1),
  };
}

function updateMicRipples() {
  const gatedLevel = getThresholdedMicLevel(micWave.latestLevel);
  const frameScale = MIC_RENDER_INTERVAL_MS / (1000 / 60);
  const deckScale = (MIC_WAVE_FULL_ROWS * 144) / MIC_REFERENCE_HEIGHT;
  const rippleScale = deckScale * MIC_RIPPLE_RANGE_MULTIPLIER;
  const targetVolume = gatedLevel > 0
    ? clampNumber(gatedLevel / MIC_VISUAL_MAX_LEVEL, 0, 1) * 255
    : 0;

  micWave.smoothedVolume += (targetVolume - micWave.smoothedVolume) * 0.15;
  if (targetVolume === 0 && micWave.smoothedVolume < 0.5) {
    micWave.smoothedVolume = 0;
  }
  micWave.frameIndex += 1;

  if (gatedLevel > 0 && micWave.smoothedVolume > 5 && micWave.frameIndex % 1 === 0) {
    micWave.ripples.push({
      radius: micWave.smoothedVolume * 0.5 * rippleScale,
      alpha: 0.6,
      speed: (4 + micWave.smoothedVolume * 0.08) * rippleScale * frameScale,
      lineWidth: (2 + micWave.smoothedVolume * 0.05) * deckScale * 1.18,
    });
  }

  micWave.ripples = micWave.ripples
    .map((ripple) => ({
      ...ripple,
      radius: ripple.radius + ripple.speed,
      alpha: ripple.alpha - MIC_RIPPLE_ALPHA_DECAY * frameScale,
    }))
    .filter((ripple) => ripple.alpha > 0)
    .slice(-MIC_MAX_RIPPLES);
}

function getThresholdedMicLevel(level) {
  const value = clampNumber(level, 0, MIC_VISUAL_MAX_LEVEL);
  return value >= MIC_VOLUME_THRESHOLD ? value : 0;
}

function renderMicWaveImage(level, options = {}) {
  const tileSize = 144;
  const tile = options.tile || getMicTileSettings({});
  const canvasWidth = tile.cols * tileSize;
  const canvasHeight = tile.rows * tileSize;
  const phase = options.phase || 0;
  const peak = clampNumber(options.peak || 0, 0, 1);
  const state = options.state || micWave;
  const error = options.error;
  const normalizedLevel = clampNumber(level / MIC_VISUAL_MAX_LEVEL, 0, 1);
  const volume = clampNumber(state.smoothedVolume ?? normalizedLevel * 255, 0, 255);
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;
  const techColor = error ? "#ff4466" : (options.techColor || "#00e5ff");
  const bgColor = error ? "#080304" : (options.bgColor || "#050505");
  const deckScale = Math.min(canvasWidth / MIC_REFERENCE_WIDTH, canvasHeight / MIC_REFERENCE_HEIGHT);
  const coreRadius = (5 + volume * 0.5) * deckScale;
  const shadowRadius = (30 + volume) * deckScale;
  const ripples = Array.isArray(state.ripples) ? state.ripples : [];
  const rippleElements = ripples.map((ripple) => {
    const radius = Math.max(1, ripple.radius);
    const lineWidth = Math.max(1, ripple.lineWidth);
    const alpha = clampNumber(ripple.alpha, 0, 1);
    const glowWidth = lineWidth + 18 * deckScale;
    return `<circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${radius.toFixed(1)}" fill="none" stroke="${techColor}" stroke-width="${glowWidth.toFixed(1)}" opacity="${(alpha * 0.28).toFixed(2)}"/><circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${radius.toFixed(1)}" fill="none" stroke="${techColor}" stroke-width="${lineWidth.toFixed(1)}" opacity="${alpha.toFixed(2)}"/>`;
  }).join("");
  const overlayElements = renderTileOverlay(options.overlayLabel, tile, tileSize);
  const successPulseElements = renderSuccessPulse(options.successPulse, tileSize);
  const extraElements = options.extraElements || "";
  const coreAlpha = clampNumber(0.5 + volume / 200, 0.5, 1);
  const viewX = tile.x * tileSize;
  const viewY = tile.y * tileSize;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileSize}" height="${tileSize}" viewBox="${viewX} ${viewY} ${tileSize} ${tileSize}">
<rect width="${canvasWidth}" height="${canvasHeight}" fill="${bgColor}"/>
<circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${(coreRadius + shadowRadius).toFixed(1)}" fill="${techColor}" opacity="${(0.08 + volume / 255 * 0.08).toFixed(2)}"/>
<circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${(coreRadius + shadowRadius * 0.36).toFixed(1)}" fill="${techColor}" opacity="${(0.14 + volume / 255 * 0.12).toFixed(2)}"/>
${rippleElements}
<circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${(coreRadius * 1.9).toFixed(1)}" fill="${techColor}" opacity="${(coreAlpha * 0.18).toFixed(2)}"/>
<circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${coreRadius.toFixed(1)}" fill="${techColor}" opacity="${coreAlpha.toFixed(2)}"/>
${successPulseElements}
${overlayElements}
${extraElements}
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function renderSuccessPulse(pulse, tileSize) {
  if (!pulse) return "";

  const p = clampNumber(pulse.progress, 0, 1);
  const origin = pulse.origin || { x: 2.5, y: 1.5, cols: MIC_WAVE_FULL_COLS, rows: MIC_WAVE_FULL_ROWS };
  const cx = origin.x * tileSize;
  const cy = origin.y * tileSize;
  const cols = Math.max(1, origin.cols || MIC_WAVE_FULL_COLS);
  const rows = Math.max(1, origin.rows || MIC_WAVE_FULL_ROWS);
  const maxRadius = Math.hypot(Math.max(origin.x, cols - origin.x), Math.max(origin.y, rows - origin.y)) * tileSize;
  const eased = 1 - Math.pow(1 - p, 3);
  const radius = tileSize * 0.16 + eased * maxRadius;
  const alpha = Math.max(0, 1 - p);
  const fillAlpha = 0.18 * alpha;
  const strokeAlpha = 0.92 * alpha;
  const glowAlpha = 0.32 * alpha;

  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(radius * 0.72).toFixed(1)}" fill="#22c55e" opacity="${fillAlpha.toFixed(2)}"/>
<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="none" stroke="#22c55e" stroke-width="${(18 - p * 10).toFixed(1)}" opacity="${glowAlpha.toFixed(2)}"/>
<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="none" stroke="#86efac" stroke-width="${(5 - p * 2).toFixed(1)}" opacity="${strokeAlpha.toFixed(2)}"/>`;
}

function renderTileOverlay(label, tile, tileSize) {
  if (!label) return "";

  const x = tile.x * tileSize;
  const y = tile.y * tileSize;
  const lines = String(label).split("\n").slice(0, 3).map(escapeSvgText);
  const text = lines.map((line, index) => (
    `<text x="${(x + tileSize / 2).toFixed(1)}" y="${(y + 82 + index * 30).toFixed(1)}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="24" font-weight="800" fill="#ffffff">${line}</text>`
  )).join("");

  return text;
}

function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeMicVariant(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 0;
  return ((n % MIC_WAVE_VARIANT_COUNT) + MIC_WAVE_VARIANT_COUNT) % MIC_WAVE_VARIANT_COUNT;
}

function renderMicWaveVariant(variant, m) {
  switch (variant) {
    case 0: return renderVariantColumnPills(m);
    case 1: return renderVariantRowPulses(m);
    case 2: return renderVariantTileBreath(m);
    case 3: return renderVariantRibbonField(m);
    case 4: return renderVariantDiagonalBeams(m);
    case 5: return renderVariantSignalRings(m);
    case 6: return renderVariantBlockMeter(m);
    case 7: return renderVariantCenterEngine(m);
    case 8: return renderVariantCornerCells(m);
    case 9: return renderVariantSplitWave(m);
    case 10: return renderVariantStepField(m);
    case 11: return renderVariantPanelPulse(m);
    case 12: return renderVariantTunnel(m);
    case 13: return renderVariantCometLanes(m);
    case 14: return renderVariantLocalEqualizers(m);
    default: return renderVariantColumnPills(m);
  }
}

function renderVariantColumnPills(m) {
  return Array.from({ length: m.cols }, (_, i) => {
    const shape = 0.45 + (1 - Math.abs(i - (m.cols - 1) / 2) / Math.max(1, m.cols / 2)) * 0.45;
    const bounce = wave(m.phase, i, 1.8, 0.76);
    const height = m.canvasHeight * (0.34 + clampNumber(m.energy * shape + m.peak * bounce * 0.28, 0, 1) * 0.58);
    const width = m.colW * 0.74;
    const x = m.colW * (i + 0.5) - width / 2;
    const y = m.centerY - height / 2;
    const color = i === Math.floor(m.cols / 2) ? m.color : m.color2;
    return pill(x, y, width, height, color, 0.72 + m.energy * 0.24);
  }).join("");
}

function renderVariantRowPulses(m) {
  return Array.from({ length: m.rows }, (_, row) => {
    const bounce = wave(m.phase, row, 2.1, 1.4);
    const height = m.rowH * (0.34 + m.energy * 0.46 + bounce * m.peak * 0.28);
    const width = m.canvasWidth * (0.54 + m.energy * 0.36 + bounce * 0.08);
    const x = (m.canvasWidth - width) / 2;
    const y = m.rowH * (row + 0.5) - height / 2;
    return pill(x, y, width, height, row === 1 ? m.color : m.color2, 0.62 + m.energy * 0.3);
  }).join("");
}

function renderVariantTileBreath(m) {
  const cells = [];
  for (let y = 0; y < m.rows; y += 1) {
    for (let x = 0; x < m.cols; x += 1) {
      const pulse = wave(m.phase, x + y * 2, 2.4, 0.7);
      const size = Math.min(m.colW, m.rowH) * (0.34 + m.energy * 0.24 + pulse * 0.15);
      cells.push(pill(
        m.colW * (x + 0.5) - size / 2,
        m.rowH * (y + 0.5) - size / 2,
        size,
        size,
        (x + y) % 2 ? m.color2 : m.color,
        0.48 + m.energy * 0.36 + pulse * 0.1
      ));
    }
  }
  return cells.join("");
}

function renderVariantRibbonField(m) {
  const ribbons = [];
  for (let row = 0; row < m.rows; row += 1) {
    const y = m.rowH * (row + 0.5);
    const amp = m.rowH * (0.08 + m.energy * 0.2 + m.peak * 0.08);
    const thick = m.rowH * (0.26 + m.energy * 0.18);
    ribbons.push(`<path d="${ribbonPath(m, y, amp, thick, row)}" fill="${row === 1 ? m.color : m.color2}" opacity="${(0.5 + m.energy * 0.34).toFixed(2)}"/>`);
  }
  return ribbons.join("");
}

function renderVariantDiagonalBeams(m) {
  const beams = [];
  const beamW = Math.max(m.colW * 0.56, m.tileSize * 0.5);
  const beamH = m.canvasHeight * (0.72 + m.energy * 0.24);
  for (let i = -1; i <= m.cols; i += 1) {
    const pulse = wave(m.phase, i, 2.0, 0.9);
    const x = m.colW * (i + 0.25 + pulse * 0.18);
    const y = m.centerY - beamH / 2;
    beams.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${beamW.toFixed(1)}" height="${beamH.toFixed(1)}" rx="${(beamW / 2).toFixed(1)}" fill="${i % 2 ? m.color2 : m.color}" opacity="${(0.44 + m.energy * 0.36).toFixed(2)}" transform="rotate(-18 ${x.toFixed(1)} ${m.centerY.toFixed(1)})"/>`);
  }
  return beams.join("");
}

function renderVariantSignalRings(m) {
  const rings = [0, 1, 2, 3].map((i) => {
    const pulse = wave(m.phase, i, 1.3, 1.1);
    const rx = m.canvasWidth * (0.12 + i * 0.1 + m.energy * 0.05 + pulse * 0.02);
    const ry = m.canvasHeight * (0.12 + i * 0.08 + m.energy * 0.05);
    return `<ellipse cx="${m.centerX.toFixed(1)}" cy="${m.centerY.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="${i % 2 ? m.color2 : m.color}" stroke-width="${(m.tileSize * (0.07 + m.energy * 0.03)).toFixed(1)}" opacity="${(0.22 + m.energy * 0.34 - i * 0.03).toFixed(2)}"/>`;
  });
  return `<ellipse cx="${m.centerX.toFixed(1)}" cy="${m.centerY.toFixed(1)}" rx="${(m.canvasWidth * 0.18).toFixed(1)}" ry="${(m.canvasHeight * 0.2).toFixed(1)}" fill="url(#softGlow)" opacity="0.8" filter="url(#blur8)"/>${rings.join("")}`;
}

function renderVariantBlockMeter(m) {
  const blocks = [];
  for (let x = 0; x < m.cols; x += 1) {
    const active = Math.ceil(1 + m.energy * m.rows + wave(m.phase, x, 2.2, 0.9) * m.peak * 2);
    for (let y = 0; y < m.rows; y += 1) {
      const fromBottom = m.rows - y;
      const on = fromBottom <= active;
      const pad = m.tileSize * 0.08;
      blocks.push(`<rect x="${(x * m.colW + pad).toFixed(1)}" y="${(y * m.rowH + pad).toFixed(1)}" width="${(m.colW - pad * 2).toFixed(1)}" height="${(m.rowH - pad * 2).toFixed(1)}" rx="${(m.tileSize * 0.08).toFixed(1)}" fill="${on ? (y === 1 ? m.color : m.color2) : m.color3}" opacity="${on ? (0.58 + m.energy * 0.32).toFixed(2) : "0.22"}"/>`);
    }
  }
  return blocks.join("");
}

function renderVariantCenterEngine(m) {
  const center = `<ellipse cx="${m.centerX.toFixed(1)}" cy="${m.centerY.toFixed(1)}" rx="${(m.canvasWidth * (0.16 + m.energy * 0.07)).toFixed(1)}" ry="${(m.canvasHeight * (0.18 + m.energy * 0.08)).toFixed(1)}" fill="${m.color}" opacity="${(0.62 + m.energy * 0.28).toFixed(2)}"/>`;
  const fins = [
    pill(m.colW * 0.25, m.centerY - m.rowH * 0.2, m.colW * 1.1, m.rowH * 0.4, m.color2, 0.54 + m.energy * 0.24),
    pill(m.canvasWidth - m.colW * 1.35, m.centerY - m.rowH * 0.2, m.colW * 1.1, m.rowH * 0.4, m.color2, 0.54 + m.energy * 0.24),
    pill(m.centerX - m.colW * 0.38, m.rowH * 0.18, m.colW * 0.76, m.rowH * 0.74, m.color3, 0.36 + m.energy * 0.3),
    pill(m.centerX - m.colW * 0.38, m.canvasHeight - m.rowH * 0.92, m.colW * 0.76, m.rowH * 0.74, m.color3, 0.36 + m.energy * 0.3),
  ].join("");
  return `${fins}${center}`;
}

function renderVariantCornerCells(m) {
  const dots = [
    [0.5, 0.5, 0],
    [m.cols - 0.5, 0.5, 1],
    [0.5, m.rows - 0.5, 2],
    [m.cols - 0.5, m.rows - 0.5, 3],
    [m.cols / 2, m.rows / 2, 4],
  ];
  return dots.map(([cx, cy, i]) => {
    const pulse = wave(m.phase, i, 2.3, 0.8);
    const size = m.tileSize * (0.72 + m.energy * 0.28 + pulse * m.peak * 0.16);
    return pill(m.colW * cx - size / 2, m.rowH * cy - size / 2, size, size, i === 4 ? m.color : m.color2, 0.5 + m.energy * 0.35);
  }).join("");
}

function renderVariantSplitWave(m) {
  const count = m.cols;
  const left = [];
  const right = [];
  for (let i = 0; i < count; i += 1) {
    const pulse = wave(m.phase, i, 2.5, 0.65);
    const w = m.colW * (0.38 + m.energy * 0.34 + pulse * m.peak * 0.18);
    const h = m.canvasHeight * (0.18 + (1 - i / count) * 0.32 + m.energy * 0.16);
    const y = m.centerY - h / 2;
    left.push(pill(m.colW * i * 0.42, y, w, h, i % 2 ? m.color2 : m.color, 0.45 + m.energy * 0.34));
    right.push(pill(m.canvasWidth - m.colW * (i * 0.42 + 0.38) - w * 0.25, y, w, h, i % 2 ? m.color2 : m.color, 0.45 + m.energy * 0.34));
  }
  return `${left.join("")}${right.join("")}`;
}

function renderVariantStepField(m) {
  return Array.from({ length: m.cols }, (_, i) => {
    const pulse = wave(m.phase, i, 2.0, 1.0);
    const height = m.rowH * (0.55 + i * 0.22 + m.energy * 0.7 + pulse * m.peak * 0.36);
    const width = m.colW * 0.7;
    const y = m.canvasHeight - height - m.rowH * 0.08;
    return pill(m.colW * (i + 0.5) - width / 2, y, width, height, i % 2 ? m.color2 : m.color, 0.55 + m.energy * 0.35);
  }).join("");
}

function renderVariantPanelPulse(m) {
  const panels = [];
  for (let y = 0; y < m.rows; y += 1) {
    for (let x = 0; x < m.cols; x += 1) {
      const pulse = wave(m.phase, x + y, 2.8, 0.55);
      const pad = m.tileSize * (0.07 + pulse * 0.02);
      panels.push(`<rect x="${(x * m.colW + pad).toFixed(1)}" y="${(y * m.rowH + pad).toFixed(1)}" width="${(m.colW - pad * 2).toFixed(1)}" height="${(m.rowH - pad * 2).toFixed(1)}" rx="${(m.tileSize * 0.12).toFixed(1)}" fill="${(x + y) % 2 ? m.color2 : m.color}" opacity="${(0.32 + m.energy * 0.42 + pulse * 0.08).toFixed(2)}"/>`);
    }
  }
  return panels.join("");
}

function renderVariantTunnel(m) {
  const rings = [];
  for (let i = 0; i < 5; i += 1) {
    const insetX = m.colW * (0.2 + i * 0.38 - m.energy * 0.05);
    const insetY = m.rowH * (0.18 + i * 0.18 - m.energy * 0.04);
    rings.push(`<rect x="${insetX.toFixed(1)}" y="${insetY.toFixed(1)}" width="${(m.canvasWidth - insetX * 2).toFixed(1)}" height="${(m.canvasHeight - insetY * 2).toFixed(1)}" rx="${(m.tileSize * (0.16 + i * 0.03)).toFixed(1)}" fill="none" stroke="${i % 2 ? m.color2 : m.color}" stroke-width="${(m.tileSize * (0.05 + m.energy * 0.02)).toFixed(1)}" opacity="${(0.2 + m.energy * 0.3 - i * 0.02).toFixed(2)}"/>`);
  }
  return rings.join("");
}

function renderVariantCometLanes(m) {
  const lanes = [];
  for (let row = 0; row < m.rows; row += 1) {
    const y = m.rowH * (row + 0.5);
    const baseX = ((m.phase * (18 + row * 8)) % (m.canvasWidth + m.colW * 2)) - m.colW;
    for (let i = 0; i < 3; i += 1) {
      const w = m.colW * (0.64 + m.energy * 0.5 - i * 0.08);
      const h = m.rowH * (0.28 + m.energy * 0.18);
      const x = baseX - i * m.colW * 0.7;
      lanes.push(pill(x, y - h / 2, w, h, i === 0 ? m.color : m.color2, 0.32 + m.energy * 0.38 - i * 0.06));
    }
  }
  return lanes.join("");
}

function renderVariantLocalEqualizers(m) {
  const groups = [];
  for (let x = 0; x < m.cols; x += 1) {
    for (let b = 0; b < 3; b += 1) {
      const pulse = wave(m.phase, x * 3 + b, 3.1, 0.5);
      const w = m.colW * 0.18;
      const h = m.rowH * (0.45 + m.energy * 0.78 * (0.45 + pulse * 0.55));
      const bx = x * m.colW + m.colW * (0.28 + b * 0.22) - w / 2;
      groups.push(pill(bx, m.centerY - h / 2, w, h, b === 1 ? m.color : m.color2, 0.48 + m.energy * 0.36));
    }
  }
  return groups.join("");
}

function ribbonPath(m, y, amp, thick, offset) {
  const top = [];
  const bottom = [];
  for (let x = -m.colW; x <= m.canvasWidth + m.colW; x += m.colW / 2) {
    const t = x / m.canvasWidth;
    const yy = y + Math.sin(t * Math.PI * 4 + m.phase * 0.7 + offset) * amp;
    top.push(`${x.toFixed(1)},${(yy - thick / 2).toFixed(1)}`);
    bottom.unshift(`${x.toFixed(1)},${(yy + thick / 2).toFixed(1)}`);
  }
  return `M ${top.join(" L ")} L ${bottom.join(" L ")} Z`;
}

function pill(x, y, width, height, fill, opacity) {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" rx="${(Math.min(width, height) / 2).toFixed(1)}" fill="${fill}" opacity="${clampNumber(opacity, 0, 1).toFixed(2)}"/>`;
}

function wave(phase, index, speed, offset) {
  return (Math.sin(phase * speed + index * offset) + 1) / 2;
}

function getMicTileSettings(settings) {
  const cols = clampInteger(settings.tileCols, 1, 8, 1);
  const rows = clampInteger(settings.tileRows, 1, 4, 1);
  return {
    x: clampInteger(settings.tileX, 0, cols - 1, 0),
    y: clampInteger(settings.tileY, 0, rows - 1, 0),
    cols,
    rows,
  };
}

function getUbikeMicSettings(settings) {
  return {
    ...settings,
    tileCols: settings.tileCols ?? MIC_WAVE_FULL_COLS,
    tileRows: settings.tileRows ?? MIC_WAVE_FULL_ROWS,
    tileX: settings.tileX ?? 2,
    tileY: settings.tileY ?? 1,
  };
}

function clampInteger(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
