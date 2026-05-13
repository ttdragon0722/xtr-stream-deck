#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const pluginDir = path.join(rootDir, "com.xtr.codexagent.sdPlugin");
const isWindows = process.platform === "win32";

function main() {
  printHeader();
  requireCommand("node", "Node.js 20 LTS or newer is required: https://nodejs.org");

  const nodeVersion = process.version;
  console.log(`Node.js ${nodeVersion}`);
  if (!isNodeVersionSupported(nodeVersion)) {
    console.error("Node.js 20 or newer is required.");
    process.exit(1);
  }

  checkCodex();
  installDependencies();
  ensureStreamDeckCli();
  enableDeveloperMode();
  linkPlugin();
  printNextSteps();
}

function printHeader() {
  console.log("======================================");
  console.log("  XTR Stream Deck installer");
  console.log("======================================");
  console.log("");
}

function requireCommand(command, message) {
  if (!commandExists(command)) {
    console.error(message);
    process.exit(1);
  }
}

function commandExists(command) {
  const lookup = isWindows ? "where" : "command -v";
  const result = isWindows
    ? spawnSync("where", [command], { stdio: "ignore", shell: true })
    : spawnSync("sh", ["-lc", `${lookup} ${shellQuote(command)}`], { stdio: "ignore" });
  return result.status === 0;
}

function isNodeVersionSupported(version) {
  const major = Number.parseInt(String(version).replace(/^v/, "").split(".")[0], 10);
  return Number.isFinite(major) && major >= 20;
}

function checkCodex() {
  console.log("");
  console.log("Checking Codex...");
  if (commandExists("codex")) {
    const result = run("codex", ["--version"], { allowFailure: true, capture: true });
    console.log(result.stdout.trim() || "Codex CLI found");
    return;
  }

  if (findCodexApp()) {
    console.log("Codex app found");
    return;
  }

  console.log("Codex was not found. Browser and host controls still work; Codex launch buttons may not.");
}

function findCodexApp() {
  const candidates = [
    process.env.XTR_CODEX_APP,
    process.platform === "darwin" ? "/Applications/Codex.app" : "",
    isWindows ? path.join(process.env.LOCALAPPDATA || "", "Programs", "Codex", "Codex.exe") : "",
    isWindows ? path.join(process.env.PROGRAMFILES || "", "Codex", "Codex.exe") : "",
    isWindows ? path.join(process.env["PROGRAMFILES(X86)"] || "", "Codex", "Codex.exe") : "",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function installDependencies() {
  console.log("");
  console.log("Installing Node dependencies...");
  if (commandExists("pnpm")) {
    run("pnpm", ["install", "--silent"], { cwd: rootDir });
  } else if (commandExists("npm")) {
    run("npm", ["install", "--no-package-lock", "--silent"], { cwd: rootDir });
  } else {
    console.error("Cannot find pnpm or npm. Install Node.js with npm and run this installer again.");
    process.exit(1);
  }
  console.log("Dependencies installed");
}

function ensureStreamDeckCli() {
  console.log("");
  console.log("Checking Stream Deck CLI...");
  if (!commandExists("streamdeck")) {
    if (!commandExists("npm")) {
      console.error("Cannot install @elgato/cli because npm was not found.");
      process.exit(1);
    }
    run("npm", ["install", "-g", "@elgato/cli@latest", "--silent"], { allowFailure: true });
  }

  if (!commandExists("streamdeck")) {
    console.error("Stream Deck CLI was not found. Please run: npm install -g @elgato/cli@latest");
    process.exit(1);
  }
  console.log("Stream Deck CLI ready");
}

function enableDeveloperMode() {
  console.log("");
  console.log("Enabling Stream Deck developer mode...");
  run("streamdeck", ["dev"], { allowFailure: true });
}

function linkPlugin() {
  console.log("");
  console.log("Linking Stream Deck plugin...");
  run("streamdeck", ["link", pluginDir], { allowFailure: true });
  console.log("Plugin linked");
}

function printNextSteps() {
  console.log("");
  console.log("======================================");
  console.log("  Install complete");
  console.log("======================================");
  console.log("");
  console.log("Next steps:");
  console.log("1. Restart the Stream Deck app.");
  console.log("2. In Chrome, open chrome://extensions and enable Developer Mode.");
  console.log(`3. Load unpacked: ${path.join(rootDir, "chrome-extension")}`);
  console.log("4. Refresh the browser tab you want to control.");
  console.log("");
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: isWindows,
    windowsHide: true,
  });

  if (options.capture) return result;

  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status || 1);
  }
  return result;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

main();

