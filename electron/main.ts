/**
 * Electron main process: SerialPort + shared SerialFrameParser → IPC frames.
 *
 * ## Connection design (2026-08)
 *
 * Root causes found in startup.log:
 * 1) `Resource busy` — Chrome Web Serial or a previous open held /dev/cu.usbmodem*
 *    while auto-scan kept calling open every 1.5s.
 * 2) Double open — renderer `serial:start` AND main auto-scan both called openSerial;
 *    openSerial always close()'d first, then the stale `close` handler cleared the
 *    new connection and UI showed "disconnected".
 * 3) tty vs cu — list() returns tty.*; we open cu.* (fixed via sameSerialPortPath).
 *
 * Rules:
 * - Single owner: only this module opens/closes the COM port.
 * - `ensureConnected()` never closes a healthy open of the same STM port.
 * - Close handlers are generation-tagged so a previous port cannot wipe a new one.
 * - Auto-scan only runs when disconnected; backs off on Resource busy.
 * - Fixed target: STM32 Virtual ComPort = USB VID 0483 / PID 5740.
 */

import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pickStmElectronSerialPortId,
  pickStmSerialPort,
  normalizeSerialPortPath,
  isConnectedPathPresent,
  sameSerialPortPath,
  listConnectablePorts,
  formatSerialPortLabel,
  isStmSerialPort,
  STM_USB_PRODUCT_NAME,
  STM_USB_VENDOR_ID,
  STM_USB_PRODUCT_ID,
  type SerialPortInfo,
} from "../src/core/stmPortPick.js";
import { SerialFrameParser } from "../src/core/serialParser.js";
import { logStartup } from "./startupLog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BAUD = 3_000_000;
const AUTO_SCAN_MS = 2_000;
const SERIAL_DEFER_MS = 1_000;
const CONNECT_RETRIES = 5;
const CONNECT_RETRY_MS = 400;
const BUSY_BACKOFF_MS = 5_000;

let win: BrowserWindow | null = null;
let port: import("serialport").SerialPort | null = null;
let connectedPath: string | null = null;
let connectedLabel = "";
/** Bumped on every close/replace so stale port event handlers become no-ops. */
let connectionGeneration = 0;
let opening = false;
let autoScanTimer: ReturnType<typeof setInterval> | null = null;
let serialDeferredTimer: ReturnType<typeof setTimeout> | null = null;
let busyUntil = 0;
const parser = new SerialFrameParser();

let serialHandlersInstalled = false;

function safeSerialCallback(callback: (portId: string) => void): (portId: string) => void {
  let settled = false;
  return (portId: string) => {
    if (settled) return;
    settled = true;
    try {
      callback(portId ?? "");
    } catch (err) {
      logStartup("select-serial-port callback failed", err);
    }
  };
}

/** Keep Web Serial permission plumbing for browser-like pages; do not open ports here. */
function installWebSerialHandlers(): void {
  const sess = session.defaultSession;
  if (!sess || serialHandlersInstalled) return;
  serialHandlersInstalled = true;

  try {
    sess.setPermissionCheckHandler((_wc, permission) => permission === "serial");
    sess.setDevicePermissionHandler((details) => details.deviceType === "serial");
  } catch (err) {
    logStartup("serial permission handlers failed", err);
  }

  // Deny renderer Web Serial picks in the packaged app — node-serialport owns the port.
  // Returning "" cancels the request so Chrome-in-Electron cannot steal the COM device.
  sess.on("select-serial-port", (event, portList, _wc, callback) => {
    event.preventDefault();
    const finish = safeSerialCallback(callback);
    logStartup(
      `select-serial-port blocked (node-serialport owns COM); list=${JSON.stringify(portList)}`,
    );
    finish("");
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

if (process.platform === "win32") {
  app.setAppUserModelId("com.talktail.gait-pressure-mat");
  try {
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
    app.commandLine.appendSwitch("disable-background-timer-throttling");
    app.commandLine.appendSwitch("ignore-gpu-blocklist");
  } catch {
    /* ignore */
  }
}

process.on("uncaughtException", (err) => {
  logStartup("uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  logStartup("unhandledRejection", reason);
});

function indexHtmlPath(): string {
  return path.join(__dirname, "../../dist/index.html");
}

function preloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function sendStatus(connected: boolean, detail?: string): void {
  win?.webContents.send("status", connected, detail);
}

function ensureWindowVisible(): void {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function isPortHealthy(): boolean {
  return !!port && port.isOpen === true && !!connectedPath;
}

function createWindow(): void {
  logStartup(`createWindow packaged=${app.isPackaged} platform=${process.platform}`);

  win = new BrowserWindow({
    width: 1100,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: true,
    center: true,
    backgroundColor: "#f8f9fb",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  try {
    win.webContents.setBackgroundThrottling(false);
  } catch {
    /* ignore */
  }

  const forceShowTimer = setTimeout(() => ensureWindowVisible(), 3_000);
  win.once("ready-to-show", () => {
    clearTimeout(forceShowTimer);
    ensureWindowVisible();
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logStartup(`did-fail-load ${code} ${desc} ${url}`);
    void dialog.showMessageBox({
      type: "error",
      title: "GaitPressureMat",
      message: "화면을 불러오지 못했습니다.",
      detail: `${desc}\n(${code})\n${url}\n\n로그: ${app.getPath("userData")}\\startup.log`,
    });
    ensureWindowVisible();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    const html = indexHtmlPath();
    logStartup(`loadFile ${html}`);
    void win.loadFile(html).catch((err: unknown) => {
      logStartup("loadFile failed", err);
      void dialog.showErrorBox("GaitPressureMat", `index.html 로드 실패:\n${String(err)}`);
      ensureWindowVisible();
    });
  }

  win.webContents.on("did-finish-load", () => {
    logStartup("did-finish-load");
    if (serialDeferredTimer) clearTimeout(serialDeferredTimer);
    serialDeferredTimer = setTimeout(() => {
      startAutoScan();
      void ensureConnected("auto-start");
    }, SERIAL_DEFER_MS);
  });

  win.on("closed", () => {
    win = null;
  });
}

async function getSerialPortModule(): Promise<typeof import("serialport") | null> {
  try {
    return await import("serialport");
  } catch (err) {
    logStartup("serialport import failed", err);
    sendStatus(false, "serial module load failed");
    return null;
  }
}

function isBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /resource busy|access denied|ebusy|cannot open|in use|access is denied/i.test(msg);
}

/**
 * Close the current port and invalidate all of its event handlers.
 * Safe to call when nothing is open.
 */
function closeSerial(reason = "close"): Promise<void> {
  connectionGeneration += 1;
  const p = port;
  const prev = connectedPath;
  port = null;
  connectedPath = null;
  connectedLabel = "";
  if (!p) return Promise.resolve();
  logStartup(`closeSerial reason=${reason} path=${prev ?? "?"}`);
  try {
    p.removeAllListeners("data");
    p.removeAllListeners("error");
    p.removeAllListeners("close");
  } catch {
    /* ignore */
  }
  return new Promise((resolve) => {
    try {
      if (p.isOpen) {
        p.close(() => resolve());
      } else {
        resolve();
      }
    } catch {
      resolve();
    }
  });
}

async function listPorts(): Promise<SerialPortInfo[]> {
  const mod = await getSerialPortModule();
  if (!mod) return [];
  return mod.SerialPort.list();
}

async function listPortsForUi(): Promise<{
  ports: Array<{
    path: string;
    label: string;
    recommended: boolean;
    manufacturer: string;
    friendlyName: string;
    vendorId: string;
    productId: string;
  }>;
  rawCount: number;
  error?: string;
}> {
  try {
    const mod = await getSerialPortModule();
    if (!mod) {
      return { ports: [], rawCount: 0, error: "serial module load failed" };
    }
    const list = (await mod.SerialPort.list()) as SerialPortInfo[];
    logStartup(
      `serial:list raw=${list.length} ${JSON.stringify(
        list.map((p) => ({
          path: p.path,
          manufacturer: p.manufacturer,
          friendlyName: (p as SerialPortInfo & { friendlyName?: string }).friendlyName,
          vendorId: p.vendorId,
          productId: p.productId,
        })),
      )}`,
    );

    let chosen = listConnectablePorts(list);
    if (!chosen.length && list.length) {
      chosen = list
        .filter((p) => !!p.path?.trim())
        .map((p) => ({ ...p, path: normalizeSerialPortPath(p.path) }));
      logStartup(`serial:list fallback showing all ${chosen.length} ports`);
    }

    const ports = chosen.map((p) => ({
      path: p.path,
      label: formatSerialPortLabel(p),
      recommended: isStmSerialPort(p),
      manufacturer: p.manufacturer ?? "",
      friendlyName: (p as SerialPortInfo & { friendlyName?: string }).friendlyName ?? "",
      vendorId: p.vendorId ?? "",
      productId: p.productId ?? "",
    }));
    return { ports, rawCount: list.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logStartup("serial:list failed", err);
    return { ports: [], rawCount: 0, error: message };
  }
}

/**
 * Ensure the STM32 Virtual ComPort (VID 0483 / PID 5740) is open.
 * Does NOT close a healthy existing connection.
 */
async function ensureConnected(reason = "ensure", explicitPath?: string): Promise<boolean> {
  if (opening) {
    logStartup(`ensureConnected skip (opening) reason=${reason}`);
    return isPortHealthy();
  }

  if (isPortHealthy() && connectedPath) {
    // Confirm device still enumerated (tty/cu treated as equal).
    try {
      const list = await listPorts();
      if (isConnectedPathPresent(list, connectedPath)) {
        sendStatus(true, `connected ${connectedLabel || connectedPath}`);
        return true;
      }
      logStartup(`ensureConnected device missing from list; reconnecting`);
      await closeSerial("device-missing");
    } catch {
      sendStatus(true, `connected ${connectedLabel || connectedPath}`);
      return true;
    }
  }

  if (Date.now() < busyUntil) {
    sendStatus(false, "port busy");
    return false;
  }

  opening = true;
  const gen = ++connectionGeneration;
  try {
    // Only close if we still hold a stale handle.
    if (port) await closeSerial("reopen");

    const mod = await getSerialPortModule();
    if (!mod) return false;

    const { SerialPort } = mod;
    const list = await SerialPort.list();
    logStartup(
      `ensureConnected(${reason}) ports=${list.length} target=${STM_USB_PRODUCT_NAME} VID=${STM_USB_VENDOR_ID} PID=${STM_USB_PRODUCT_ID}: ${JSON.stringify(list)}`,
    );

    let target: string;
    let picked: SerialPortInfo | null;
    if (explicitPath?.trim()) {
      target = normalizeSerialPortPath(explicitPath.trim());
      picked =
        list.find((p) => sameSerialPortPath(p.path, target)) ??
        ({ path: target } as SerialPortInfo);
    } else {
      picked = pickStmSerialPort(list);
      if (!picked) {
        sendStatus(false, "waiting for STM USB");
        return false;
      }
      target = normalizeSerialPortPath(picked.path);
    }
    parser.reset();

    const next = new SerialPort({
      path: target,
      baudRate: BAUD,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) => {
      next.open((err) => (err ? reject(err) : resolve()));
    });

    // Another ensureConnected may have raced; drop if we were superseded.
    if (gen !== connectionGeneration) {
      logStartup("ensureConnected superseded after open; closing orphan");
      try {
        next.close(() => undefined);
      } catch {
        /* ignore */
      }
      return isPortHealthy();
    }

    port = next;
    connectedPath = target;
    const name =
      (picked as SerialPortInfo & { friendlyName?: string }).friendlyName ||
      picked.manufacturer ||
      STM_USB_PRODUCT_NAME;
    const ids =
      picked.vendorId && picked.productId
        ? ` VID ${picked.vendorId} PID ${picked.productId}`
        : ` VID ${STM_USB_VENDOR_ID} PID ${STM_USB_PRODUCT_ID}`;
    connectedLabel = `${target} (${name}${ids})`;
    logStartup(`serial open ${connectedLabel}`);
    sendStatus(true, `connected ${connectedLabel}`);
    busyUntil = 0;

    const myGen = gen;
    next.on("error", (e) => {
      if (myGen !== connectionGeneration) return;
      logStartup("serial error", e);
      sendStatus(false, `error: ${e.message}`);
      void closeSerial("port-error");
    });
    next.on("close", () => {
      if (myGen !== connectionGeneration) return;
      logStartup("serial close event");
      port = null;
      connectedPath = null;
      connectedLabel = "";
      sendStatus(false, "disconnected");
    });
    next.on("data", (chunk: Buffer) => {
      if (myGen !== connectionGeneration) return;
      const matrices = parser.appendChunk(new Uint8Array(chunk));
      for (const m of matrices) {
        const buf = m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength);
        win?.webContents.send("frame", buf);
      }
    });

    return true;
  } catch (err) {
    logStartup("ensureConnected failed", err);
    if (gen === connectionGeneration) {
      await closeSerial("open-failed");
    }
    if (isBusyError(err)) {
      busyUntil = Date.now() + BUSY_BACKOFF_MS;
      sendStatus(false, "port busy");
    } else {
      sendStatus(false, `error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  } finally {
    opening = false;
  }
}

/** Connect button: retry without tearing down a good link. */
async function forceConnect(): Promise<boolean> {
  logStartup("forceConnect");
  if (isPortHealthy()) {
    sendStatus(true, `connected ${connectedLabel || connectedPath}`);
    return true;
  }
  busyUntil = 0; // user explicitly asked — clear backoff
  for (let i = 0; i < CONNECT_RETRIES; i++) {
    const ok = await ensureConnected(`force-${i + 1}`);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
  }
  if (!isPortHealthy()) {
    sendStatus(false, Date.now() < busyUntil ? "port busy" : "waiting for STM USB");
  }
  return isPortHealthy();
}

async function safeAutoScanTick(): Promise<void> {
  try {
    if (opening) return;
    if (isPortHealthy()) {
      // Lightweight liveness: only disconnect if device vanished from the OS list.
      if (!connectedPath) return;
      const list = await listPorts();
      if (!isConnectedPathPresent(list, connectedPath)) {
        await closeSerial("unplugged");
        sendStatus(false, "disconnected");
      }
      return;
    }
    if (Date.now() < busyUntil) return;
    await ensureConnected("auto-scan");
  } catch (err) {
    logStartup("auto-scan tick failed", err);
  }
}

function startAutoScan(): void {
  if (autoScanTimer) return;
  autoScanTimer = setInterval(() => void safeAutoScanTick(), AUTO_SCAN_MS);
}

function stopAutoScan(): void {
  if (autoScanTimer) {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
  }
  if (serialDeferredTimer) {
    clearTimeout(serialDeferredTimer);
    serialDeferredTimer = null;
  }
}

// serial:start = ensure connected (idempotent). Never force-close a healthy port.
ipcMain.handle("serial:list", () => listPortsForUi());
ipcMain.handle("serial:start", (_e, portPath?: string) => ensureConnected("ipc-start", portPath));
ipcMain.handle("serial:stop", async () => {
  await closeSerial("ipc-stop");
  sendStatus(false, "disconnected");
});
ipcMain.handle("serial:rescan", () => forceConnect());

if (gotSingleInstanceLock) {
  app
    .whenReady()
    .then(() => {
      logStartup("app ready");
      installWebSerialHandlers();
      createWindow();
    })
    .catch((err: unknown) => {
      logStartup("whenReady failed", err);
      app.quit();
    });
}

app.on("window-all-closed", () => {
  stopAutoScan();
  void closeSerial("app-quit");
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else ensureWindowVisible();
});

// Silence unused import when Web Serial picker is blocked (kept for type/docs).
void pickStmElectronSerialPortId;
void sameSerialPortPath;
