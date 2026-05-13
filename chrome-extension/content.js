/**
 * XTR Stream Deck Bridge - Content Script
 *
 * 注入在每個網頁裡。接收 background.js 透過 chrome.tabs.sendMessage 傳來的
 * 指令，在頁面 DOM 上執行對應點擊，回傳結果字串。
 *
 * 回傳值規範：
 *   "OK"            → 成功
 *   "ALREADY_LIKED" → 已是按下狀態（避免重複觸發）
 *   "NOT_FOUND"     → 找不到目標元素
 *   "WRONG_PAGE"    → 目前分頁不是 Codex / ChatGPT / OpenAI 頁面
 *   "HOST_WRONG_PAGE" → 目前分頁不是 XTR Host 頁面
 *   其他            → 不預期的錯誤訊息
 */

const XTR_HOST = "host.xtr-multiverse.xyz";
const LOCAL_XTR_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_HOST_FT_PORT = "3502";
const UBIKE_XTR_PROMPT = "請把以下任務指派給 ubike xtr：\n";
let activeVoiceButton = null;
let voiceStatusTimer = null;
let lastVoiceStatusKey = "";
let lastTtsAudioLevelSentAt = 0;

function injectTtsAudioMeter() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-audio-meter.js");
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
}

injectTtsAudioMeter();

function clickFirst(selectors, { skipPressed = false } = {}) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    if (skipPressed && el.getAttribute("aria-pressed") === "true") return "ALREADY_LIKED";
    el.click();
    return "OK";
  }
  return "NOT_FOUND";
}

function clickButtonByText(words) {
  const buttons = collectElementsDeep(document, "button, [role='button']");
  const target = buttons.find((el) => {
    const text = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.trim().toLowerCase();
    if (!text) return false;
    return words.some((word) => text.includes(word.toLowerCase()));
  });
  if (!target) return "NOT_FOUND";
  target.click();
  return "OK";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMatch(getMatch, timeoutMs = 900, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const match = getMatch();
    if (match) return match;
    await delay(intervalMs);
  }
  return null;
}

function requireCodexPage() {
  const host = location.hostname.toLowerCase();
  const path = location.pathname.toLowerCase();
  if (host.includes("codex") || host.includes("chatgpt.com") || host.includes("openai.com")) return null;
  if (path.includes("codex")) return null;
  return "WRONG_PAGE";
}

function requireXtrHostPage(msg = {}) {
  const host = location.hostname.toLowerCase();
  const allowedHosts = normalizeAllowedHosts(msg.allowedHosts || msg.hosts);
  if (host === XTR_HOST || allowedHosts.includes(host)) return null;
  if (LOCAL_XTR_HOSTS.has(host) && location.port === LOCAL_HOST_FT_PORT) return null;
  return "HOST_WRONG_PAGE";
}

function normalizeAllowedHosts(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

function isCloudflareAccessPage() {
  return document.title.includes("Cloudflare Access")
    || Boolean(document.querySelector("#totp-form, .AuthBox-RequestCode"));
}

function isEditableElement(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;

  const tag = el.tagName?.toLowerCase();
  if (tag === "textarea") return !el.disabled && !el.readOnly;
  if (tag !== "input") return el.getAttribute("role") === "textbox";

  const type = (el.getAttribute("type") || "text").toLowerCase();
  return !el.disabled
    && !el.readOnly
    && ["", "text", "search", "email", "url", "tel", "password"].includes(type);
}

function isVisible(el) {
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== "none"
    && style.visibility !== "hidden"
    && rect.width > 0
    && rect.height > 0;
}

function getDeepActiveElement(root = document) {
  const active = root.activeElement;
  if (active?.shadowRoot) return getDeepActiveElement(active.shadowRoot);
  return active;
}

function collectEditableTargets(root, selectors, targets = []) {
  if (!root?.querySelectorAll) return targets;

  for (const el of root.querySelectorAll(selectors)) {
    targets.push(el);
  }

  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) collectEditableTargets(el.shadowRoot, selectors, targets);
  }

  return targets;
}

function collectElementsDeep(root, selector, targets = []) {
  if (!root?.querySelectorAll) return targets;

  for (const el of root.querySelectorAll(selector)) {
    targets.push(el);
  }

  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) collectElementsDeep(el.shadowRoot, selector, targets);
  }

  return targets;
}

function querySelectorDeep(selector, root = document) {
  const match = root.querySelector(selector);
  if (match) return match;

  for (const el of root.querySelectorAll("*")) {
    if (!el.shadowRoot) continue;
    const shadowMatch = querySelectorDeep(selector, el.shadowRoot);
    if (shadowMatch) return shadowMatch;
  }

  return null;
}

function findEditableTarget() {
  const activeElement = getDeepActiveElement();
  if (isEditableElement(activeElement) && isVisible(activeElement)) {
    return activeElement;
  }

  const selectors = [
    "textarea:not([disabled]):not([readonly])",
    "input:not([disabled]):not([readonly])",
    "[contenteditable='true']",
    "[contenteditable='plaintext-only']",
    "[role='textbox']",
    ".ProseMirror",
    ".cm-content",
  ].join(",");

  return collectEditableTargets(document, selectors)
    .find((el) => isEditableElement(el) && isVisible(el));
}

function dispatchEditableEvents(el, inputType = "insertText") {
  try {
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      data: null,
      inputType,
    }));
  } catch (_) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeValue(el, value) {
  const prototype = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(el, value);
  else el.value = value;
}

function replaceEditableContent(el, text) {
  el.focus();

  if (el.isContentEditable || el.getAttribute("role") === "textbox") {
    const selection = window.getSelection();
    if (!selection) return "NO_TEXTBOX";

    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);

    const replaced = document.execCommand?.("insertText", false, text);
    if (!replaced) {
      el.textContent = text;
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    dispatchEditableEvents(el, "insertReplacementText");
    return "TEXT_REPLACED";
  }

  setNativeValue(el, text);
  if (typeof el.setSelectionRange === "function") {
    const cursor = text.length;
    el.setSelectionRange(cursor, cursor);
  }

  dispatchEditableEvents(el, "insertReplacementText");
  return "TEXT_REPLACED";
}

function getControlText(el) {
  return `${el?.getAttribute?.("aria-label") || ""} ${el?.getAttribute?.("title") || ""} ${el?.textContent || ""}`
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findVoiceModeToggle() {
  const explicit = querySelectorDeep("[data-xtr-streamdeck='voice-mode-toggle']");
  if (explicit && isVisible(explicit)) return explicit;

  return collectElementsDeep(document, "button, [role='button']")
    .find((el) => isVisible(el) && getControlText(el).includes("切換到語音模式"));
}

function findTextModeToggle() {
  const explicit = querySelectorDeep("[data-xtr-streamdeck='text-mode-toggle']");
  if (explicit && isVisible(explicit)) return explicit;

  return collectElementsDeep(document, "button, [role='button']")
    .find((el) => {
      if (!isVisible(el)) return false;
      const text = getControlText(el);
      return text.includes("切換到文字模式") || text.includes("離開語音模式");
    });
}

function findVoiceMicButton() {
  const explicit = querySelectorDeep("[data-xtr-streamdeck='voice-ptt']");
  if (explicit && isVisible(explicit)) return explicit;

  return collectElementsDeep(document, "button")
    .find((el) => {
      if (!isVisible(el)) return false;
      const text = getControlText(el);
      return text.includes("按住說話") || text.includes("免持模式（自動斷句）");
    });
}

function findHandsFreeCheckbox() {
  const explicit = querySelectorDeep("[data-xtr-streamdeck='handsfree-toggle']");
  if (explicit && isVisible(explicit)) return explicit;

  const labels = collectElementsDeep(document, "label");
  for (const label of labels) {
    if (!isVisible(label) || !getControlText(label).includes("免持模式")) continue;
    const input = label.querySelector?.("input[type='checkbox']");
    if (input && isVisible(input)) return input;
  }

  return collectElementsDeep(document, "input[type='checkbox']")
    .find((input) => isVisible(input) && getControlText(input.closest?.("label")).includes("免持模式"));
}

function findTtsToggleButton() {
  const explicit = querySelectorDeep("[data-xtr-streamdeck='tts-toggle']");
  if (explicit && isVisible(explicit)) return explicit;

  return collectElementsDeep(document, "button, [role='button']")
    .find((el) => {
      if (!isVisible(el)) return false;
      const text = getControlText(el);
      return text.includes("關閉語音播放") || text.includes("開啟語音播放") || text.includes("語音播放");
    });
}

function findUserMessages() {
  return collectElementsDeep(document, "div, article")
    .filter((el) => {
      if (!isVisible(el)) return false;
      const cls = typeof el.className === "string" ? el.className : "";
      if (!cls.includes("justify-end")) return false;
      return el.getBoundingClientRect().height > 20;
    });
}

function scrollToUserMessage(el) {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function findCurrentMsgIndex(messages) {
  const midY = window.scrollY + window.innerHeight / 2;
  let closest = 0;
  let closestDist = Infinity;
  messages.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const absTop = rect.top + window.scrollY;
    const dist = Math.abs(absTop - midY);
    if (dist < closestDist) { closestDist = dist; closest = i; }
  });
  return closest;
}

function findHostInputField() {
  const explicit = querySelectorDeep("[data-xtr-streamdeck='chat-input']");
  if (explicit && isVisible(explicit)) return explicit;

  return collectElementsDeep(
    document,
    "textarea, [contenteditable='true'], [role='textbox'], input[type='text'], input:not([type])"
  ).find((el) => isVisible(el));
}

function findNewConversationButton() {
  const explicit = querySelectorDeep("[data-xtr-streamdeck='new-chat']");
  if (explicit && isVisible(explicit)) return explicit;

  return collectElementsDeep(document, "button, [role='button']")
    .find((el) => {
      if (!isVisible(el)) return false;
      const text = getControlText(el);
      return text.includes("新增對話") || text.includes("開始新對話");
    });
}

function findHostSendButton() {
  const explicit = querySelectorDeep("[data-xtr-streamdeck='send-input']");
  if (explicit && isVisible(explicit)) return explicit;

  const buttons = collectElementsDeep(document, "button, [role='button']");
  return buttons.find((el) => {
    if (!isVisible(el)) return false;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;

    const text = getControlText(el).toLowerCase();
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.toLowerCase();

    return (
      text.includes("送出") ||
      text.includes("send") ||
      label.includes("送出") ||
      label.includes("send")
    );
  });
}

function hasHostInputValue() {
  const fields = collectElementsDeep(
    document,
    "textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']"
  );

  return fields.some((el) => {
    if (!isVisible(el)) return false;
    const value =
      el.value !== undefined
        ? String(el.value)
        : String(el.textContent || "");
    return value.trim().length > 0;
  });
}

function readVoiceStatus() {
  const micButton = findVoiceMicButton();
  if (!micButton) return null;

  const text = getControlText(document.body);
  let state = "idle";
  if (text.includes("回答中") || text.includes("ai 回答") || text.includes("speaking")) {
    state = "speaking";
  } else if (text.includes("聆聽") || text.includes("我在聽") || text.includes("listening")) {
    state = "listening";
  } else if (text.includes("轉錄") || text.includes("transcribing")) {
    state = "transcribing";
  } else if (text.includes("思考") || text.includes("thinking")) {
    state = "thinking";
  } else if (text.includes("你可以說話了") || text.includes("免持模式中")) {
    state = "armed";
  }

  const ttsToggle = findTtsToggleButton();
  const ttsText = getControlText(ttsToggle);
  const handsFree = Boolean(findHandsFreeCheckbox()?.checked);
  const ttsEnabled = ttsText ? !ttsText.includes("開啟語音播放") : true;
  return { state, ttsEnabled, handsFree };
}

function publishVoiceStatus(force = false) {
  const status = readVoiceStatus();
  if (!status) return;

  const key = `${status.state}:${status.ttsEnabled}:${status.handsFree}`;
  if (!force && key === lastVoiceStatusKey) return;
  lastVoiceStatusKey = key;

  try {
    chrome.runtime.sendMessage({
      source: "content",
      type: "VOICE_STATUS",
      ...status,
    });
  } catch (_) {}
}

function startVoiceStatusWatcher() {
  if (voiceStatusTimer) return;
  voiceStatusTimer = setInterval(() => publishVoiceStatus(false), 250);
  publishVoiceStatus(true);
}

window.addEventListener("xtr-streamdeck-tts-level", (event) => {
  const now = Date.now();
  if (now - lastTtsAudioLevelSentAt < 40) return;
  lastTtsAudioLevelSentAt = now;

  const detail = event.detail || {};
  try {
    chrome.runtime.sendMessage({
      source: "content",
      type: "TTS_AUDIO_LEVEL",
      level: Number(detail.level) || 0,
      peak: Number(detail.peak) || 0,
      active: Boolean(detail.active),
    });
  } catch (_) {}
});

async function ensureVoiceMode(msg) {
  const wrongPage = requireXtrHostPage(msg);
  if (wrongPage) return wrongPage;
  if (isCloudflareAccessPage()) return "HOST_LOGIN_REQUIRED";

  if (findVoiceMicButton()) {
    startVoiceStatusWatcher();
    publishVoiceStatus(true);
    return null;
  }

  const toggle = findVoiceModeToggle();
  if (!toggle) return "VOICE_UNAVAILABLE";

  toggle.click();
  const micButton = await waitForMatch(findVoiceMicButton);
  if (micButton) {
    startVoiceStatusWatcher();
    publishVoiceStatus(true);
  }
  return micButton ? null : "VOICE_NOT_READY";
}

async function ensureTextMode() {
  if (!findVoiceMicButton() && findEditableTarget()) return null;

  const toggle = findTextModeToggle();
  if (toggle) {
    toggle.click();
    const target = await waitForMatch(findEditableTarget, 1200);
    return target ? null : "NO_TEXTBOX";
  }

  return findEditableTarget() ? null : "NO_TEXTBOX";
}

async function replaceHostInput(msg, fallbackText) {
  const wrongPage = requireXtrHostPage(msg);
  if (wrongPage) return wrongPage;
  if (isCloudflareAccessPage()) return "HOST_LOGIN_REQUIRED";

  const textModeError = await ensureTextMode();
  if (textModeError) return textModeError;

  let target;
  if (msg.selector) {
    try {
      target = querySelectorDeep(msg.selector);
    } catch (_) {
      return "INVALID_SELECTOR";
    }
  } else {
    target = findEditableTarget();
  }

  if (!target) return "NO_TEXTBOX";
  if (!isEditableElement(target) || !isVisible(target)) return "NO_TEXTBOX";

  return replaceEditableContent(target, msg.text !== undefined ? String(msg.text) : fallbackText);
}

function dispatchVoicePointer(el, phase) {
  el.focus?.();
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons: phase === "down" ? 1 : 0,
  };

  if (window.PointerEvent) {
    el.dispatchEvent(new PointerEvent(phase === "down" ? "pointerdown" : "pointerup", {
      ...eventInit,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }));
  }

  el.dispatchEvent(new MouseEvent(phase === "down" ? "mousedown" : "mouseup", eventInit));
}

// ─── 切換模型 helpers ─────────────────────────────────────
const HOST_TEXT_MODELS = [
  { id: "gpt-4o", name: "GPT-4o", result: "MODEL_GPT_4O" },
  { id: "gpt-4o-mini", name: "GPT-4o mini", result: "MODEL_GPT_4O_MINI" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", result: "MODEL_CLAUDE_SONNET_46" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", result: "MODEL_CLAUDE_OPUS_47" },
];

function getCurrentHostModeScope() {
  return findVoiceMicButton() ? "voice" : "text";
}

function findModelSelectorTrigger(scope = getCurrentHostModeScope()) {
  const explicit = querySelectorDeep(
    `[data-xtr-streamdeck='model-selector'][data-xtr-model-scope='${scope}']`
  );
  if (explicit && isVisible(explicit)) return explicit;

  return collectElementsDeep(document, "button, [role='combobox']")
    .find((el) => {
      if (!isVisible(el)) return false;
      const text = getControlText(el);
      return HOST_TEXT_MODELS.some((model) => text.includes(model.name.toLowerCase()))
        || text.includes("選擇模型");
    });
}

function collectModelOptions() {
  return collectElementsDeep(
    document,
    "[role='option'], [role='menuitem'], [cmdk-item], [data-xtr-model-id]"
  ).filter((el) => isVisible(el) && getControlText(el).trim().length > 0);
}

function matchModelResult(text) {
  const lower = text.toLowerCase();
  const matched = HOST_TEXT_MODELS.find((m) =>
    lower.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(lower)
  );
  return matched ? matched.result : "MODEL_SWITCHED";
}

async function toggleHostCurrentModel(msg) {
  const wrongPage = requireXtrHostPage(msg);
  if (wrongPage) return wrongPage;
  if (isCloudflareAccessPage()) return "HOST_LOGIN_REQUIRED";

  const scope = getCurrentHostModeScope();
  const trigger = findModelSelectorTrigger(scope);
  if (!trigger) return "MODEL_MENU_NOT_FOUND";
  if (trigger.disabled || trigger.getAttribute("aria-disabled") === "true") {
    return "MODEL_SWITCH_LOCKED";
  }

  const currentText = getControlText(trigger).toLowerCase().trim();
  trigger.click();

  const options = await waitForMatch(() => {
    const items = collectModelOptions();
    return items.length > 0 ? items : null;
  }, 1200);

  if (!options || options.length === 0) return "MODEL_NOT_FOUND";

  const currentIndex = options.findIndex((el) => {
    const t = getControlText(el).toLowerCase().trim();
    return currentText.includes(t) || t.includes(currentText);
  });

  const nextIndex = ((currentIndex >= 0 ? currentIndex : -1) + 1) % options.length;
  const nextOption = options[nextIndex];
  const nextText = getControlText(nextOption);

  nextOption.click();
  return matchModelResult(nextText);
}

// ─── 各網站的點擊邏輯 ────────────────────────────────────
const ACTIONS = {
  "youtube-like": () => {
    return clickFirst([
      "like-button-view-model button-view-model button",
      "segmented-like-dislike-button-view-model like-button-view-model button",
      "ytd-like-button-renderer button[aria-pressed]",
      "button[aria-label*='like' i]",
      "button[aria-label*='讚']",
    ], { skipPressed: true });
  },

  "youtube-subscribe": () => {
    return clickFirst([
      "yt-subscribe-button-view-model button",
      "ytd-subscribe-button-renderer button",
      "button[aria-label*='Subscribe' i]",
      "button[aria-label*='訂閱']",
    ]);
  },

  "codex-send": () => {
    const wrongPage = requireCodexPage();
    if (wrongPage) return wrongPage;
    return clickFirst([
      "button[data-testid='send-button']",
      "button[data-testid='composer-submit-button']",
      "button[aria-label='Send message']",
      "button[aria-label='Send prompt']",
      "button[aria-label*='Send' i]",
      "button[aria-label*='送出']",
      "button[type='submit']",
    ]);
  },

  "codex-continue": () => {
    const wrongPage = requireCodexPage();
    if (wrongPage) return wrongPage;
    return clickButtonByText([
      "continue",
      "resume",
      "run",
      "approve",
      "allow",
      "繼續",
      "恢復",
      "執行",
      "允許",
    ]);
  },

  "host-toggle-model": async (msg) => {
    return toggleHostCurrentModel(msg);
  },

  "host-agent-xtr": async (msg) => {
    return replaceHostInput(msg, msg.text !== undefined ? String(msg.text) : UBIKE_XTR_PROMPT);
  },

  "host-ubike-xtr": async (msg) => {
    return replaceHostInput(msg, UBIKE_XTR_PROMPT);
  },

  "host-voice-mode": async (msg) => {
    const unavailable = await ensureVoiceMode(msg);
    return unavailable || "VOICE_MODE";
  },

  "host-voice-ptt-start": async (msg) => {
    const unavailable = await ensureVoiceMode(msg);
    if (unavailable) return unavailable;

    const micButton = findVoiceMicButton();
    if (!micButton || micButton.disabled) return "VOICE_NOT_READY";

    activeVoiceButton = micButton;
    dispatchVoicePointer(micButton, "down");
    return "VOICE_PTT_START";
  },

  "host-voice-ptt-stop": async (msg) => {
    const unavailable = await ensureVoiceMode(msg);
    if (unavailable) return unavailable;

    const micButton = activeVoiceButton || findVoiceMicButton();
    if (!micButton) return "VOICE_NOT_READY";

    dispatchVoicePointer(micButton, "up");
    activeVoiceButton = null;
    return "VOICE_PTT_STOP";
  },

  "host-voice-handsfree-toggle": async (msg) => {
    const unavailable = await ensureVoiceMode(msg);
    if (unavailable) return unavailable;

    const checkbox = findHandsFreeCheckbox();
    if (!checkbox) return "VOICE_NOT_READY";

    checkbox.click();
    setTimeout(() => publishVoiceStatus(true), 80);
    return "HANDS_FREE_TOGGLED";
  },

  "host-voice-tts-toggle": async (msg) => {
    const unavailable = await ensureVoiceMode(msg);
    if (unavailable) return unavailable;

    const button = findTtsToggleButton();
    if (!button) return "VOICE_NOT_READY";

    button.click();
    setTimeout(() => publishVoiceStatus(true), 80);
    return "TTS_TOGGLED";
  },

  "host-focus-input": (msg) => {
    const wrongPage = requireXtrHostPage(msg);
    if (wrongPage) return wrongPage;
    if (isCloudflareAccessPage()) return "HOST_LOGIN_REQUIRED";

    const field = findHostInputField();
    if (!field) return "NOT_FOUND";

    field.focus();
    field.click();
    return "OK";
  },

  "host-new-chat": async (msg) => {
    const wrongPage = requireXtrHostPage(msg);
    if (wrongPage) return wrongPage;
    if (isCloudflareAccessPage()) return "HOST_LOGIN_REQUIRED";

    const button = findNewConversationButton();
    if (!button) return "NOT_FOUND";

    button.click();
    return "NEW_CHAT_CREATED";
  },

  "host-send-input": async (msg) => {
    const wrongPage = requireXtrHostPage(msg);
    if (wrongPage) return wrongPage;
    if (isCloudflareAccessPage()) return "HOST_LOGIN_REQUIRED";

    if (!hasHostInputValue()) return "HOST_INPUT_EMPTY";

    const button = findHostSendButton();
    if (!button) return "HOST_SEND_NOT_FOUND";

    button.click();
    return "HOST_MESSAGE_SENT";
  },

  "host-prev-msg": (msg) => {
    const wrongPage = requireXtrHostPage(msg);
    if (wrongPage) return wrongPage;
    if (isCloudflareAccessPage()) return "HOST_LOGIN_REQUIRED";

    const messages = findUserMessages();
    if (messages.length === 0) return "NOT_FOUND";

    const cur = findCurrentMsgIndex(messages);
    if (cur === 0) { scrollToUserMessage(messages[0]); return "HOST_AT_FIRST"; }

    scrollToUserMessage(messages[cur - 1]);
    return "HOST_NAV_OK";
  },

  "host-next-msg": (msg) => {
    const wrongPage = requireXtrHostPage(msg);
    if (wrongPage) return wrongPage;
    if (isCloudflareAccessPage()) return "HOST_LOGIN_REQUIRED";

    const messages = findUserMessages();
    if (messages.length === 0) return "NOT_FOUND";

    const cur = findCurrentMsgIndex(messages);
    if (cur === messages.length - 1) { scrollToUserMessage(messages[cur]); return "HOST_AT_LAST"; }

    scrollToUserMessage(messages[cur + 1]);
    return "HOST_NAV_OK";
  },

  // 通用點擊，由指令額外帶 selector 欄位
  "click": (msg) => {
    if (!msg.selector) return "NO_SELECTOR";
    try {
      const el = document.querySelector(msg.selector);
      if (!el) return "NOT_FOUND";
      el.click();
      return "OK";
    } catch (_) {
      return "INVALID_SELECTOR";
    }
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "XTR_ACTION") return false;

  const handler = ACTIONS[msg.action];
  Promise.resolve(handler ? handler(msg) : "UNKNOWN_ACTION")
    .then((result) => sendResponse({ result }))
    .catch(() => sendResponse({ result: "CONTENT_SCRIPT_ERROR" }));
  return true;
});

if (!requireXtrHostPage({})) {
  startVoiceStatusWatcher();
}
