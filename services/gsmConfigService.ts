// src/services/gsmConfigService.ts
//
// Single source of truth for GSM/ESP32 bridge BEHAVIOR.
//
// The ESP32 bridge (src/sms-bridge/main.cpp) polls GET /api/gsm/config
// on boot and every CONFIG_FETCH_INTERVAL_MS after that. Whatever this
// service returns is what the device does — flip `enabled` off or
// change `pollIntervalMs` via PUT /api/gsm/config and every kiosk picks
// it up on its next check, no reflash required.
//
// This is what makes the SIM800L+ESP32 a true "plugin": the firmware
// hardcodes only WiFi credentials, BASE_URL, and physical wiring pins.
// Every behavioral decision (on/off, how fast to poll) lives here.
//
// Persistence: a `gsm_config` row per kiosk_id, so config survives a
// backend restart/redeploy — an in-memory-only flag would silently
// reset to defaults on every deploy, which is the opposite of reliable.
//
// Caching: a short in-memory TTL cache in front of the DB read, since
// N kiosks each polling /config every ~30s (plus /pending every few
// seconds) would otherwise mean a steady trickle of SELECTs. 5s TTL
// keeps that cheap without meaningfully delaying an admin's config
// change from reaching devices (worst case: 5s + one poll cycle).
//
// Migration (run once):
//
//   CREATE TABLE IF NOT EXISTS gsm_config (
//     kiosk_id         INT PRIMARY KEY,
//     enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
//     poll_interval_ms INT         NOT NULL DEFAULT 4000,
//     updated_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
//   );
//
import pool from '../lib/db';

export interface GSMConfig {
  kioskId: number;
  enabled: boolean;
  pollIntervalMs: number;
  updatedAt: string;
}

const DEFAULTS = {
  enabled: true,
  pollIntervalMs: 4000,
} as const;

// Guardrails: a fat-fingered PUT body shouldn't be able to make a kiosk
// hammer the backend every few ms, or go effectively offline for hours.
const MIN_POLL_MS = 2000;
const MAX_POLL_MS = 60_000;

const CACHE_TTL_MS = 5000;
const cache = new Map<number, { config: GSMConfig; expiresAt: number }>();

function clampPollInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULTS.pollIntervalMs;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(ms)));
}

function rowToConfig(r: any): GSMConfig {
  return {
    kioskId: r.kiosk_id,
    enabled: !!r.enabled,
    pollIntervalMs: r.poll_interval_ms,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

// Fetch the kiosk's row, creating it with defaults on first-ever contact.
// ON DUPLICATE KEY UPDATE ... = itself is a no-op that just avoids a race
// where two near-simultaneous first requests both try to INSERT.
async function ensureRow(kioskId: number): Promise<GSMConfig> {
  const [rows]: any = await (pool as any).query(
    `SELECT kiosk_id, enabled, poll_interval_ms, updated_at
       FROM gsm_config WHERE kiosk_id = ?`,
    [kioskId],
  );

  if (rows?.[0]) return rowToConfig(rows[0]);

  await (pool as any).query(
    `INSERT INTO gsm_config (kiosk_id, enabled, poll_interval_ms, updated_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE kiosk_id = kiosk_id`,
    [kioskId, DEFAULTS.enabled, DEFAULTS.pollIntervalMs],
  );

  return {
    kioskId,
    enabled: DEFAULTS.enabled,
    pollIntervalMs: DEFAULTS.pollIntervalMs,
    updatedAt: new Date().toISOString(),
  };
}

/** What the ESP32 bridge calls on boot + every CONFIG_FETCH_INTERVAL_MS. */
export async function getConfig(kioskId: number): Promise<GSMConfig> {
  const hit = cache.get(kioskId);
  if (hit && hit.expiresAt > Date.now()) return hit.config;

  const config = await ensureRow(kioskId);
  cache.set(kioskId, { config, expiresAt: Date.now() + CACHE_TTL_MS });
  return config;
}

/** What an admin panel / PUT /api/gsm/config calls to change behavior. */
export async function updateConfig(
  kioskId: number,
  patch: Partial<Pick<GSMConfig, 'enabled' | 'pollIntervalMs'>>,
): Promise<GSMConfig> {
  const current = await ensureRow(kioskId);

  const next: GSMConfig = {
    kioskId,
    enabled: patch.enabled ?? current.enabled,
    pollIntervalMs:
      patch.pollIntervalMs != null
        ? clampPollInterval(patch.pollIntervalMs)
        : current.pollIntervalMs,
    updatedAt: new Date().toISOString(),
  };

  await (pool as any).query(
    `UPDATE gsm_config SET enabled = ?, poll_interval_ms = ?, updated_at = NOW()
     WHERE kiosk_id = ?`,
    [next.enabled, next.pollIntervalMs, kioskId],
  );

  // Drop the cache entry rather than overwrite it in place — forces the
  // very next getConfig() (from any backend instance, if you run more
  // than one) to hit the DB and confirm what was actually persisted.
  cache.delete(kioskId);
  return next;
}

export function invalidateConfigCache(kioskId?: number): void {
  if (kioskId != null) cache.delete(kioskId);
  else cache.clear();
}