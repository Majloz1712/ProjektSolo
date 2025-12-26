// skrypt/ocrSnapshotu.js
// OCR jako extractor: czyta screenshot (tesseract) i zapisuje wynik do snapshotu.
// Nie podejmuje decyzji o "important".

import { mongoClient } from '../polaczenieMDB.js';
import { ocrImageWithTesseract } from './tesseractOcr.js';
import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';

const db = mongoClient.db(process.env.MONGO_DB || 'inzynierka');
const snapshotsCol = db.collection('snapshots');

function normalizeB64(b64) {
  if (!b64) return null;
  let s = String(b64).trim();
  const idx = s.indexOf('base64,');
  if (idx !== -1) s = s.slice(idx + 7);
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    if (comma !== -1) s = s.slice(comma + 1);
  }
  s = s.trim();
  return s.length ? s : null;
}

function sha1(str) {
  if (!str) return null;
  return crypto.createHash('sha1').update(str).digest('hex');
}

function normalizeOcrText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Zapewnia, że snapshot ma pole `vision_ocr` odpowiadające AKTUALNEMU screenshotowi.
 * - cache: jeśli `vision_ocr.sourceHash` == hash screenshotu -> nie liczymy OCR ponownie
 * - force: wymusza przeliczenie OCR
 */
export async function ensureSnapshotOcr(
  snapshot,
  {
    force = false,
    logger,
    lang = 'pol+eng',
    psm = 6,
    timeoutMs = 20000,
    cleanOptions = {},
  } = {},
) {
  const log = logger || console;
  if (!snapshot || !snapshot._id) return null;

  const shot = normalizeB64(snapshot.screenshot_b64);
  if (!shot) {
    log.info('snapshot_ocr_skip_no_screenshot', {
      snapshotId: snapshot._id.toString(),
      monitorId: String(snapshot.monitor_id || ''),
    });
    return null;
  }

  const sourceHash = sha1(shot);

  const existing = snapshot.vision_ocr || null;
  const existingHash = existing?.sourceHash || null;

  if (!force && existing && existingHash && existingHash === sourceHash) {
    return existing;
  }

  const t0 = performance.now();
  log.info('snapshot_ocr_start', {
    snapshotId: snapshot._id.toString(),
    monitorId: String(snapshot.monitor_id || ''),
    sourceHash,
    force,
  });

  const ocr = await ocrImageWithTesseract({
    base64: shot,
    lang,
    psm,
    timeoutMs,
    clean: true,
    cleanOptions,
  });

  const doc = {
    engine: 'tesseract',
    meta: { lang, psm },
    createdAt: new Date(),
    sourceHash,
    confidence: ocr?.confidence ?? null,
    // trzymamy wersję "clean" jako główne źródło
    clean_text: normalizeOcrText(ocr?.clean_text || ocr?.text || ''),
    clean_meta: ocr?.clean_meta ?? null,
  };

  await snapshotsCol.updateOne(
    { _id: snapshot._id },
    { $set: { vision_ocr: doc } },
  );

  // aktualizacja obiektu w pamięci, żeby kolejne kroki pipeline miały to od razu
  snapshot.vision_ocr = doc;

  log.info('snapshot_ocr_done', {
    snapshotId: snapshot._id.toString(),
    monitorId: String(snapshot.monitor_id || ''),
    durationMs: Math.round(performance.now() - t0),
    confidence: doc.confidence,
    chars: doc.clean_text ? doc.clean_text.length : 0,
  });

  return doc;
}
