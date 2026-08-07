/**
 * Web Serial transport (Chrome/Edge/Electron). Opens the COM port at 3,000,000 baud
 * and feeds incoming bytes through the SHARED SerialFrameParser.
 *
 * Electron uses the same Web Serial API as Chrome (main process registers
 * select-serial-port + permission handlers). Node serialport is only a fallback.
 */

import { STM_USB_VENDOR_ID } from "../core/stmPortPick.js";
import { SerialFrameParser } from "../core/serialParser.js";
import type { FrameHandler, FrameSource, StatusHandler } from "./source.js";

const SERIAL_OPTIONS = {
  baudRate: 3_000_000,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  bufferSize: 1 << 16,
} as const;

const STM_USB_FILTER = { usbVendorId: parseInt(STM_USB_VENDOR_ID, 16) } as const;

interface SerialConnectEvent extends Event {
  port: SerialPort;
}

export interface WebSerialSourceOptions {
  /** When true, try getPorts() + USB hot-plug without opening the picker first. */
  autoConnect?: boolean;
}

export class WebSerialSource implements FrameSource {
  private readonly parser = new SerialFrameParser();
  private readonly autoConnect: boolean;
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private running = false;
  private frameHandler: FrameHandler = () => {};
  private statusHandler: StatusHandler = () => {};
  private hotplugInstalled = false;

  constructor(options: WebSerialSourceOptions = {}) {
    this.autoConnect = options.autoConnect ?? false;
  }

  onFrame(handler: FrameHandler): void {
    this.frameHandler = handler;
  }
  onStatus(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  async start(): Promise<void> {
    if (!("serial" in navigator)) {
      this.statusHandler(false, "Web Serial API unavailable (use Chrome/Edge).");
      throw new Error("Web Serial API not supported");
    }

    if (this.autoConnect) {
      this.installHotplug();
      const opened = await this.tryOpenGrantedPorts();
      if (opened) return;
      this.statusHandler(false, "waiting for STM USB");
      return;
    }

    await this.requestPort();
  }

  /** Open the system picker (Electron main auto-selects STM via select-serial-port). */
  async requestPort(): Promise<void> {
    if (!("serial" in navigator)) {
      this.statusHandler(false, "Web Serial API unavailable (use Chrome/Edge).");
      throw new Error("Web Serial API not supported");
    }
    this.installHotplug();
    const port = await navigator.serial.requestPort({ filters: [STM_USB_FILTER] });
    await this.openPort(port);
  }

  private installHotplug(): void {
    if (this.hotplugInstalled || !("serial" in navigator)) return;
    this.hotplugInstalled = true;
    navigator.serial.addEventListener("connect", this.onUsbConnect);
    navigator.serial.addEventListener("disconnect", this.onUsbDisconnect);
  }

  private onUsbConnect = (event: Event): void => {
    const ev = event as SerialConnectEvent;
    if (this.port?.readable) return;
    void this.openPort(ev.port).catch(() => {
      this.statusHandler(false, "waiting for STM USB");
    });
  };

  private onUsbDisconnect = (event: Event): void => {
    const ev = event as SerialConnectEvent;
    if (this.port !== ev.port) return;
    void this.stop();
  };

  private async tryOpenGrantedPorts(): Promise<boolean> {
    const ports = await navigator.serial.getPorts();
    for (const p of ports) {
      try {
        await this.openPort(p);
        return true;
      } catch {
        /* try next granted port */
      }
    }
    return false;
  }

  private async openPort(port: SerialPort): Promise<void> {
    await this.stop();
    this.port = port;
    const info = port.getInfo();
    const label =
      info.usbProductId != null
        ? `VID ${STM_USB_VENDOR_ID} PID ${info.usbProductId.toString(16).padStart(4, "0")}`
        : "STM USB";
    await this.port.open(SERIAL_OPTIONS);
    this.parser.reset();
    this.running = true;
    this.statusHandler(true, `connected ${label}`);
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    if (!this.port?.readable) return;
    this.reader = this.port.readable.getReader();
    try {
      while (this.running) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          const matrices = this.parser.appendChunk(value);
          for (const m of matrices) this.frameHandler(m);
        }
      }
    } catch (err) {
      this.statusHandler(false, `read error: ${String(err)}`);
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* ignore */
    }
    this.reader = null;
    try {
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
    this.statusHandler(false, "disconnected");
  }
}
