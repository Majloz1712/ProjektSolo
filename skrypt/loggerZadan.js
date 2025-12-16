/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './polaczeniePG.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// katalog bazowy na logi: Inzynierka/logs
const LOGS_ROOT = path.resolve(__dirname, '../logs');

// cache, żeby nie pytać bazy za każdym razem
const monitorMetaCache = new Map(); // monitor_id -> { userSlug, monitorSlug }

/**
 * Prosty slug:
 * "Sonda Play – światłowód" -> "sonda-play-swiatlowod"
 */
function slugify(str = '') {
  return (
    String(str)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '') // usuń akcenty
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

/**
 * Pobierz z bazy:
 * - pełną nazwę użytkownika (uzytkownicy.pelna_nazwa)
 * - nazwę sondy (monitory.nazwa)
 */
async function getMonitorMeta(monitorId) {
  if (monitorMetaCache.has(monitorId)) {
    return monitorMetaCache.get(monitorId);
  }

  const sql = `
    SELECT
      m.nazwa         AS monitor_name,
      u.pelna_nazwa   AS user_full_name,
      u.email         AS user_email
    FROM monitory m
    JOIN uzytkownicy u ON u.id = m.uzytkownik_id
    WHERE m.id = $1
    LIMIT 1
  `;

  let monitorName = monitorId;      // fallback
  let userName = 'unknown_user';    // fallback

  try {
    const res = await pool.query(sql, [monitorId]);
    if (res.rows.length > 0) {
      const row = res.rows[0];
      monitorName = row.monitor_name || monitorName;

      // priorytet: pelna_nazwa -> email -> fallback
      userName = row.user_full_name || row.user_email || userName;
    }
  } catch (err) {
    console.error('[logger] DB error in getMonitorMeta', err);
  }

  const meta = {
    userSlug: slugify(userName),
    monitorSlug: slugify(monitorName),
  };

  monitorMetaCache.set(monitorId, meta);
  return meta;
}

/**
 * Tworzy logger dla KONKRETNEGO zadania (zadania_skanu.id).
 * Struktura katalogów zostaje:
 *
 *   logs/<userSlug>/<monitorSlug>/zadania/<zadanieId>.log
 *
 * Jeżeli createTaskLogger zostanie wywołany kilka razy z tym samym
 * (monitorId, zadanieId) – wszystkie logi trafią do TEGO SAMEGO pliku.
 */
export async function createTaskLogger({ monitorId, zadanieId }) {
  const { userSlug, monitorSlug } = await getMonitorMeta(monitorId);

  const baseDir = path.join(
    LOGS_ROOT,
    userSlug,
    monitorSlug,
    'zadania',
  );

  fs.mkdirSync(baseDir, { recursive: true });

  // 👉 KLUCZOWA ZMIANA:
  // zamiast nazwy z timestampem:
  //   `${ts}__${zadanieId}.log`
  // używamy stałej nazwy per zadanie:
  //   `<zadanieId>.log`
  const fileName = `${zadanieId || 'unknown-task'}.log`;
  const filePath = path.join(baseDir, fileName);

  const stream = fs.createWriteStream(filePath, { flags: 'a' });

  function writeLine(level, msg, data) {
    const line = [
      new Date().toISOString(),
      `[${level.toUpperCase()}]`,
      msg,
      data ? JSON.stringify(data) : '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    stream.write(line + '\n');

    // opcjonalnie kopiuj do konsoli
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    info(msg, data) {
      writeLine('info', msg, data);
    },
    warn(msg, data) {
      writeLine('warn', msg, data);
    },
    error(msg, data) {
      writeLine('error', msg, data);
    },
    close() {
      stream.end();
    },
    filePath,
  };
}

