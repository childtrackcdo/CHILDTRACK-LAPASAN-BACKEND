// src/services/gsmSerial.ts
//
// Direct SIM800L serial communication from Node.js.
// Optimised for minimum latency — target <3 s from scan to SMS sent.
//
// .env:
//   GSM_PORT=COM3
//   GSM_BAUD=9600
//   GSM_ENABLED=true
//
// npm install serialport
//
import { SerialPort } from 'serialport';

const PORT_PATH = process.env.GSM_PORT    ?? 'COM3';
const BAUD_RATE = Number(process.env.GSM_BAUD ?? 9600);
const ENABLED   = process.env.GSM_ENABLED === 'true';

let port:   SerialPort | null = null;
let ready = false;
let buffer = '';

// Single lock — prevents two SMS from fighting over the serial line
let sendLock = false;

/* ── Open + init ─────────────────────────────────────────────────────────── */

export function initGSM(): void {
  if (!ENABLED) {
    console.log('[GSM] Disabled (GSM_ENABLED != true)');
    return;
  }

  port = new SerialPort({ path: PORT_PATH, baudRate: BAUD_RATE, autoOpen: false });

  port.open(err => {
    if (err) {
      console.error(`[GSM] Cannot open ${PORT_PATH}:`, err.message);
      return;
    }
    console.log(`[GSM] ${PORT_PATH} open @ ${BAUD_RATE} baud`);
    runInit();
  });

  port.on('data', (d: Buffer) => { buffer += d.toString(); });
  port.on('error', (e: Error) => { console.error('[GSM] error:', e.message); ready = false; });
  port.on('close', ()         => { console.warn('[GSM] port closed'); ready = false; });
}

/* ── AT helpers ──────────────────────────────────────────────────────────── */

function at(cmd: string): void {
  port?.write(cmd + '\r\n');
}

function waitFor(token: string, ms = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    buffer = '';
    const deadline = Date.now() + ms;
    const iv = setInterval(() => {
      if (buffer.includes(token)) { clearInterval(iv); resolve(buffer); }
      else if (Date.now() > deadline) {
        clearInterval(iv);
        reject(new Error(`Timeout waiting for "${token}" — got: ${buffer.slice(-120)}`));
      }
    }, 20);   // check every 20 ms — tight loop
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ── Init sequence (runs once at startup) ────────────────────────────────── */

async function runInit(): Promise<void> {
  try {
    await sleep(800);

    for (let i = 0; i < 5; i++) {
      at('AT');
      try { await waitFor('OK', 1500); break; }
      catch { if (i === 4) throw new Error('No AT response after 5 tries'); }
    }

    at('AT+CMGF=1');  await waitFor('OK', 2000);  // text mode — stays set
    at('AT+CSCS="GSM"'); await waitFor('OK', 2000);

    at('AT+CSQ');
    const csq = await waitFor('OK', 2000);
    console.log('[GSM] Signal CSQ:', csq.match(/\+CSQ:\s*(\d+)/)?.[1] ?? '?');

    at('AT+CPIN?');
    const cpin = await waitFor('OK', 3000);
    if (!cpin.includes('READY')) throw new Error('SIM not READY: ' + cpin.trim());

    // Network registration
    at('AT+CREG?');
    const creg = await waitFor('OK', 3000);
    console.log('[GSM] CREG:', creg.match(/\+CREG:\s*[\d,]+/)?.[0] ?? '?');

    ready = true;
    console.log('[GSM] ✅ Ready — SMS will be sent directly from backend (<3 s target)');
  } catch (err: any) {
    console.error('[GSM] Init failed:', err.message);
  }
}

/* ── Send SMS — optimised for minimum latency ────────────────────────────── */

export async function sendSMSDirect(phone: string, message: string): Promise<boolean> {
  if (!ENABLED)      { console.log('[GSM] disabled');   return false; }
  if (!ready)        { console.error('[GSM] not ready'); return false; }
  if (!port?.isOpen) { console.error('[GSM] port closed'); return false; }

  // Serialise: if another send is in progress, wait (max 10 s)
  const lockStart = Date.now();
  while (sendLock) {
    if (Date.now() - lockStart > 10_000) {
      console.error('[GSM] Lock timeout — dropping SMS to', phone);
      return false;
    }
    await sleep(50);
  }
  sendLock = true;

  const t0 = Date.now();
  try {
    // Flush stale data
    buffer = '';
    while (port.read()) { /* drain */ }

    // CMGS — skip re-setting CMGF (already set at init, stays set)
    buffer = '';
    at(`AT+CMGS="${phone}"`);
    await waitFor('>', 4000);   // SIM800L echoes '>' when ready for text

    // Write body + CTRL+Z in one shot — no delay between
    port.write(message + '\x1A');

    // Wait for +CMGS: confirmation (network round-trip ~1-3 s on good signal)
    const result = await waitFor('+CMGS:', 15_000);

    const elapsed = Date.now() - t0;
    console.log(`[GSM] ✅ Sent to ${phone} in ${elapsed} ms —`, result.match(/\+CMGS:\s*\d+/)?.[0]);
    return true;
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    console.error(`[GSM] ❌ Failed to ${phone} after ${elapsed} ms:`, err.message);

    // Hard-reset the SMS mode so next send starts clean
    try { at('AT+CMGF=1'); await waitFor('OK', 1000); } catch { /* ignore */ }
    return false;
  } finally {
    sendLock = false;
  }
}

export function isGSMReady(): boolean { return ready; }