const grantButton = document.getElementById("grant");
const statusEl = document.getElementById("status");

grantButton.addEventListener("click", requestMicPermission);

async function requestMicPermission() {
  grantButton.disabled = true;
  statusEl.textContent = "正在開啟麥克風權限...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    for (const track of stream.getTracks()) track.stop();

    await chrome.runtime.sendMessage({ type: "MIC_PERMISSION_GRANTED" });
    statusEl.textContent = "已允許，正在回到 Stream Deck 聲波...";

    setTimeout(() => window.close(), 700);
  } catch (error) {
    grantButton.disabled = false;
    statusEl.textContent = `授權失敗：${error?.message || String(error)}`;
  }
}
