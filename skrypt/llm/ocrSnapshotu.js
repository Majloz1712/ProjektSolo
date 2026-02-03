// skrypt/llm/ocrSnapshotu.js
import { mongoClient } from '../polaczenieMDB.js';
import { ocrImageWithPaddle } from './paddleOcr.js';
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
  return s.trim().length ? s.trim() : null;
}

function sha1(str) {
  if (!str) return null;
  return crypto.createHash('sha1').update(str).digest('hex');
}

export async function ensureSnapshotOcr(
  snapshot,
  {
    force = false,
    logger,
    lang = 'en', // 'en' obejmuje PL (latin-based)
    timeoutMs = Number(process.env.OCR_PADDLE_TIMEOUT_MS || 60000),
    cleanOptions = {
      // detekcja/naprawa typowych artefaktów OCR
      mergeHyphenated: true,
      fixCommon: true,

      // usuń fałszywe "ikonki" rozpoznane jako znaki CJK (np. 回/女)
      stripCjkChars: true,

      // deduplikacja dokładna linii (zostawia pierwsze wystąpienie)
      dedupeExact: true,

      // format
      keepNewlines: true,
      collapseSpaces: true,

      // stabilizacja pod diff (uniwersalne)
      dedupeWindow: Number(process.env.OCR_DEDUPE_WINDOW || 80),
      boilerplateMinFreq: Number(process.env.OCR_BOILERPLATE_MIN_FREQ || 2),
      boilerplateMaxLineLen: Number(process.env.OCR_BOILERPLATE_MAX_LINE_LEN || 90),
      dropMostlyJunkLines: (process.env.OCR_DROP_JUNK ?? 'true') === 'true',
    },
    pythonBin,
    saveStdout = false, // opcjonalnie, zwykle false (stdout potrafi być duży)
  } = {},
) {
  const log = logger || console;
  if (!snapshot || !snapshot._id) return null;

  const shot = normalizeB64(snapshot.screenshot_b64);
  if (!shot) return null;

  const sourceHash = sha1(shot);
  const existing = snapshot.vision_ocr || null;

  // Cache check: jeśli to ten sam obraz i mamy już wynik (lub błąd)
  if (!force && existing && existing.sourceHash === sourceHash && (existing.clean_text || existing.error)) {
    return existing;
  }

  const t0 = performance.now();

  const ocr = await ocrImageWithPaddle({
    base64: shot,
    lang,
    timeoutMs,
    clean: true,
    cleanOptions,
    pythonBin,
  });

  const rawText = (ocr.text || '').toString();
  const cleanText = (ocr.clean_text || '').toString();

  // clean_lines potrafi być duże; zabezpieczenie na Mongo 16MB
  let cleanLines = Array.isArray(ocr.clean_lines) ? ocr.clean_lines : null;
  let cleanLinesTruncated = false;
  if (cleanLines) {
    const maxLines = Number(process.env.OCR_MAX_STORED_LINES || 1200);
    const maxChars = Number(process.env.OCR_MAX_STORED_LINES_CHARS || 600000);
    let total = 0;
    for (const l of cleanLines) total += String(l || '').length;
    if (cleanLines.length > maxLines || total > maxChars) {
      cleanLines = cleanLines.slice(0, maxLines);
      cleanLinesTruncated = true;
    }
  }

  // Mongo walidacja: niektóre schemy nie lubią pustych stringów/null
  // Zostawiamy "spację" jako minimalną wartość, ale status rozpoznajesz po `ok`/`error`.
  const finalCleanText = cleanText.trim().length ? cleanText : ' ';

  const ok = !ocr.error;

  const doc = {
    engine: 'paddleocr',
    ok,
    error: ocr.error || null,

    createdAt: new Date(),
    sourceHash,
    confidence: ocr.confidence ?? null,

    // Teksty:
    raw_text: rawText,          // może być pusty
    clean_text: finalCleanText, // zawsze niepusty (min 1)
    clean_lines: cleanLines,
    clean_meta: ocr.clean_meta || null,

    meta: {
      lang: ocr.lang,
      python: ocr.python_used,
      script: ocr.script_used,
      stderr: (ocr.stderr || '').slice(0, 2000),
      cleanLinesTruncated,
      ...(saveStdout ? { stdout: (ocr.stdout || '').slice(0, 2000) } : {}),
    },
  };

  await snapshotsCol.updateOne(
    { _id: snapshot._id },
    { $set: { vision_ocr: doc } },
  );

  snapshot.vision_ocr = doc;

  log.info('snapshot_ocr_done', {
    id: snapshot._id,
    ms: Math.round(performance.now() - t0),
    ok: doc.ok,
    err: doc.error,
    lenRaw: doc.raw_text.length,
    lenClean: doc.clean_text.length,
  });

  return doc;
}

