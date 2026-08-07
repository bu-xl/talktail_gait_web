import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isMacUsbModemCalloutPath,
  isMacUsbModemPath,
  isStmSerialPort,
  normalizeSerialPortPath,
  pickStmElectronSerialPortId,
  pickStmSerialPort,
  preferMacCalloutPath,
} from "../src/core/stmPortPick.js";

describe("stmPortPick", () => {
  it("prefers STMicro VID 0483", () => {
    const list = [
      { path: "COM3", manufacturer: "wch.cn", vendorId: "1a86" },
      { path: "COM7", manufacturer: "STMicroelectronics", vendorId: "0483" },
    ];
    const picked = pickStmSerialPort(list);
    assert.equal(picked?.path, "COM7");
  });

  it("matches Windows PNP id VID_0483", () => {
    const p = { path: "COM5", pnpId: "USB\\VID_0483&PID_5740\\..." };
    assert.equal(isStmSerialPort(p), true);
  });

  it("matches macOS tty.usbmodem from serialport list", () => {
    const p = {
      path: "/dev/tty.usbmodem3784356533351",
      manufacturer: "STMicroelectronics",
      vendorId: "0483",
      productId: "5740",
    };
    assert.equal(isMacUsbModemPath(p.path), true);
    assert.equal(isStmSerialPort(p), true);
    const picked = pickStmSerialPort([p]);
    assert.equal(picked?.path, "/dev/cu.usbmodem3784356533351");
  });

  it("prefers cu call-out path on macOS", () => {
    assert.equal(
      preferMacCalloutPath("/dev/tty.usbmodem3784356533351"),
      "/dev/cu.usbmodem3784356533351",
    );
  });

  it("picks STM Electron Web Serial port by VID", () => {
    const id = pickStmElectronSerialPortId([
      { portId: "bt", portName: "Bluetooth", vendorId: "0000" },
      {
        portId: "stm",
        portName: "cu.usbmodem3784356533351",
        displayName: "STM32 Virtual ComPort",
        vendorId: "0483",
        productId: "5740",
      },
    ]);
    assert.equal(id, "stm");
  });

  it("matches macOS cu.usbmodem without manufacturer (STM32 VCP)", () => {
    const p = { path: "cu.usbmodem3784356533351" };
    assert.equal(isMacUsbModemCalloutPath(p.path), true);
    assert.equal(isStmSerialPort(p), true);
    const picked = pickStmSerialPort([p]);
    assert.equal(picked?.path, "/dev/cu.usbmodem3784356533351");
  });

  it("matches STM32 Virtual ComPort label", () => {
    const p = { path: "/dev/cu.usbmodem3784356533351", manufacturer: "STM32 Virtual ComPort" };
    assert.equal(isStmSerialPort(p), true);
  });

  it("ignores bluetooth ports", () => {
    const p = { path: "COM9", manufacturer: "Standard Serial over Bluetooth link" };
    assert.equal(isStmSerialPort(p), false);
  });

  it("returns null when no STM device", () => {
    assert.equal(pickStmSerialPort([{ path: "COM1", vendorId: "1a86" }]), null);
  });

  it("normalizes macOS path with /dev prefix", () => {
    assert.equal(normalizeSerialPortPath("cu.usbmodem123"), "/dev/cu.usbmodem123");
    assert.equal(normalizeSerialPortPath("/dev/cu.usbmodem123"), "/dev/cu.usbmodem123");
  });
});
