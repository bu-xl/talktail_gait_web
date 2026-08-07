/** Pick the pressure-mat USB serial port (STM32 CDC / STMicroelectronics). */

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
  serialNumber?: string;
}

/** STMicroelectronics USB VID (STM32 Virtual COM Port). */
export const STM_USB_VENDOR_ID = "0483";
/** STM32 Virtual ComPort product id (pressure mat). */
export const STM_USB_PRODUCT_ID = "5740";
export const STM_USB_PRODUCT_NAME = "STM32 Virtual ComPort";

function normVid(vid?: string): string {
  if (!vid) return "";
  return vid.toLowerCase().replace(/^0x/, "").padStart(4, "0");
}

function normHexId(v?: string): string {
  if (!v) return "";
  return v.toLowerCase().replace(/^0x/, "").padStart(4, "0");
}

/** True when VID/PID match the mat's STM32 Virtual ComPort. */
export function isStmVirtualComPortIds(vendorId?: string, productId?: string): boolean {
  return normVid(vendorId) === STM_USB_VENDOR_ID && normHexId(productId) === STM_USB_PRODUCT_ID;
}

/** macOS cu./tty. and Windows COM paths compare equal when they refer to the same device. */
export function sameSerialPortPath(a: string, b: string): boolean {
  return normalizeSerialPortPath(a) === normalizeSerialPortPath(b);
}

export function isConnectedPathPresent(list: SerialPortInfo[], connectedPath: string): boolean {
  const target = normalizeSerialPortPath(connectedPath);
  return list.some((p) => sameSerialPortPath(p.path, target));
}

function haystack(p: SerialPortInfo): string {
  return [p.manufacturer, p.pnpId, p.path, p.productId, p.serialNumber]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function pathLower(p: SerialPortInfo): string {
  return p.path.toLowerCase().replace(/\\/g, "/");
}

/** macOS USB CDC path (Chrome lists cu.*; serialport often lists tty.*). */
export function isMacUsbModemPath(path: string): boolean {
  const p = path.toLowerCase().replace(/\\/g, "/");
  return (
    /(?:^|\/)cu\.usbmodem[0-9a-f]+$/i.test(p) ||
    /^cu\.usbmodem[0-9a-f]+$/i.test(p) ||
    /(?:^|\/)tty\.usbmodem[0-9a-f]+$/i.test(p) ||
    /^tty\.usbmodem[0-9a-f]+$/i.test(p)
  );
}

/** @deprecated use isMacUsbModemPath */
export function isMacUsbModemCalloutPath(path: string): boolean {
  return isMacUsbModemPath(path);
}

export function isExcludedSerialPort(p: SerialPortInfo): boolean {
  const h = haystack(p);
  return (
    h.includes("bluetooth") ||
    h.includes("rfcomm") ||
    h.includes("spp") ||
    pathLower(p).includes("bluetooth")
  );
}

/** True when the port looks like an STM32 / STMicro USB CDC device. */
export function isStmSerialPort(p: SerialPortInfo): boolean {
  if (isExcludedSerialPort(p)) return false;

  if (normVid(p.vendorId) === STM_USB_VENDOR_ID) return true;

  const h = haystack(p);
  if (h.includes("stmicro")) return true;
  if (h.includes("stm32")) return true;
  if (h.includes("virtual com") || h.includes("virtual comport")) return true;
  if (/\bstm\b/.test(h)) return true;

  const pnp = (p.pnpId ?? "").toUpperCase();
  if (pnp.includes("VID_0483")) return true;

  // macOS: metadata is often missing; STM32 VCP shows as cu./tty.usbmodem########
  if (isMacUsbModemPath(p.path)) return true;

  return false;
}

function scoreStmPort(p: SerialPortInfo): number {
  let s = 0;
  if (normVid(p.vendorId) === STM_USB_VENDOR_ID) s += 100;
  const man = (p.manufacturer ?? "").toLowerCase();
  if (man.includes("stmicro")) s += 50;
  if (man.includes("stm32")) s += 45;
  if (man.includes("virtual com")) s += 40;
  if (man.includes("stm")) s += 30;
  if ((p.pnpId ?? "").toUpperCase().includes("VID_0483")) s += 40;
  if (isMacUsbModemPath(p.path)) s += 35;
  if (pathLower(p).startsWith("com")) s += 5;
  if (pathLower(p).includes("/cu.") || pathLower(p).startsWith("cu.")) s += 20;
  if (pathLower(p).includes("/tty.") || pathLower(p).startsWith("tty.")) s -= 30;
  return s;
}

/** Prefer cu.* call-out device when serialport lists tty.* (macOS). */
export function preferMacCalloutPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  const base = trimmed.replace(/^\/dev\//i, "");
  if (base.startsWith("tty.usbmodem")) {
    return `/dev/cu.${base.slice("tty.".length)}`;
  }
  if (base.startsWith("cu.") || base.startsWith("tty.")) {
    return `/dev/${base}`;
  }
  return trimmed;
}

/** Normalize path for serialport.open (macOS cu./tty. needs /dev/ prefix). */
export function normalizeSerialPortPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  const base = trimmed.replace(/^\/dev\//i, "");
  if (base.startsWith("cu.") || base.startsWith("tty.")) {
    return preferMacCalloutPath(`/dev/${base}`);
  }
  return trimmed;
}

/** Electron Web Serial port entry (select-serial-port callback list). */
export interface ElectronSerialPort {
  portId: string;
  portName?: string;
  displayName?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
}

function scoreElectronSerialPort(p: ElectronSerialPort): number {
  let s = 0;
  if (normVid(p.vendorId) === STM_USB_VENDOR_ID) s += 100;
  const h = [p.displayName, p.portName, p.serialNumber].filter(Boolean).join(" ").toLowerCase();
  if (h.includes("stmicro")) s += 50;
  if (h.includes("stm32")) s += 45;
  if (h.includes("virtual com")) s += 40;
  if (/\bstm\b/.test(h)) s += 30;
  const name = (p.portName ?? "").toLowerCase();
  if (name.includes("cu.usbmodem")) s += 35;
  if (name.includes("tty.usbmodem")) s += 20;
  if (name.includes("usbmodem")) s += 15;
  return s;
}

/** Best STM port id for Electron select-serial-port, or "" if none. */
export function pickStmElectronSerialPortId(list: ElectronSerialPort[]): string {
  if (!list.length) return "";
  const ranked = [...list].sort(
    (a, b) => scoreElectronSerialPort(b) - scoreElectronSerialPort(a),
  );
  const best = ranked.find((p) => scoreElectronSerialPort(p) > 0) ?? ranked[0];
  return best?.portId ?? "";
}

/** Best STM mat port, or null if none present. */
export function pickStmSerialPort(list: SerialPortInfo[]): SerialPortInfo | null {
  const usable = list.filter((p) => !isExcludedSerialPort(p));
  const exact = usable.filter((p) => isStmVirtualComPortIds(p.vendorId, p.productId));
  const pool = exact.length ? exact : usable.filter(isStmSerialPort);
  if (!pool.length) return null;
  pool.sort((a, b) => scoreStmPort(b) - scoreStmPort(a));
  const best = pool[0];
  if (!best) return null;
  return { ...best, path: normalizeSerialPortPath(best.path) };
}

/** Human-readable label for the port picker modal. */
export function formatSerialPortLabel(p: SerialPortInfo): string {
  const name =
    (p as SerialPortInfo & { friendlyName?: string }).friendlyName?.trim() ||
    p.manufacturer?.trim() ||
    (isStmSerialPort(p) ? STM_USB_PRODUCT_NAME : "Serial");
  const ids =
    p.vendorId && p.productId
      ? ` · VID ${normHexId(p.vendorId).toUpperCase()} PID ${normHexId(p.productId).toUpperCase()}`
      : "";
  return `${name}${ids} — ${normalizeSerialPortPath(p.path)}`;
}

/** Ports shown in the Connect modal: exclude Bluetooth/debug noise, STM first. */
export function listConnectablePorts(list: SerialPortInfo[]): SerialPortInfo[] {
  const usable = list
    .filter((p) => !isExcludedSerialPort(p))
    .filter((p) => {
      const h = pathLower(p);
      if (h.includes("debug-console") || h.includes("bluetooth")) return false;
      return !!p.path?.trim();
    })
    .map((p) => ({ ...p, path: normalizeSerialPortPath(p.path) }));

  usable.sort((a, b) => {
    const sa = isStmSerialPort(a) ? scoreStmPort(a) + 1000 : scoreStmPort(a);
    const sb = isStmSerialPort(b) ? scoreStmPort(b) + 1000 : scoreStmPort(b);
    return sb - sa;
  });
  return usable;
}
