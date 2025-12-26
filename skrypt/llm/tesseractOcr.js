// skrypt/llm/tesseractOcr.js
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function stripBase64Prefix(b64) {
  if (!b64) return null;
  const s = String(b64);
  const idx = s.indexOf(",");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    const t = setTimeout(() => {
      child.kill("SIGKILL");
      const err = new Error(`TIMEOUT: ${cmd} ${args.join(" ")}`);
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf-8")));

    child.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) {
        const err = new Error(`tesseract exit=${code}: ${stderr || stdout}`);
        err.name = "TesseractError";
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * TSV header:
 * level page_num block_num par_num line_num word_num left top width height conf text
 */
function parseTsvToLines(tsvText) {
  const rows = tsvText.split(/\r?\n/).filter(Boolean);
  if (rows.length <= 1) return { text: "", confidence: 0, lines: [] };

  const header = rows[0].split("\t");
  const idx = Object.fromEntries(header.map((k, i) => [k, i]));

  const groups = new Map(); // key -> { words:[], confs:[], left, top, right, bottom }
  let pageW = 0;
  let pageH = 0;

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split("\t");
    const level = Number(cols[idx.level]);
    if (level !== 5) continue; // słowa

    const text = (cols[idx.text] || "").trim();
    if (!text) continue;

    const confRaw = Number(cols[idx.conf]);
    const conf = Number.isFinite(confRaw) && confRaw >= 0 ? confRaw / 100 : 0;

    const left = Number(cols[idx.left] ?? 0) || 0;
    const top = Number(cols[idx.top] ?? 0) || 0;
    const width = Number(cols[idx.width] ?? 0) || 0;
    const height = Number(cols[idx.height] ?? 0) || 0;
    const right = left + width;
    const bottom = top + height;

    if (right > pageW) pageW = right;
    if (bottom > pageH) pageH = bottom;

    const key = [
      cols[idx.page_num],
      cols[idx.block_num],
      cols[idx.par_num],
      cols[idx.line_num],
    ].join("-");

    if (!groups.has(key)) {
      groups.set(key, {
        words: [],
        confs: [],
        left,
        top,
        right,
        bottom,
      });
    }

    const g = groups.get(key);
    g.words.push(text);
    g.confs.push(conf);
    if (left < g.left) g.left = left;
    if (top < g.top) g.top = top;
    if (right > g.right) g.right = right;
    if (bottom > g.bottom) g.bottom = bottom;
  }

  const lines = [];
  for (const [, g] of groups.entries()) {
    const lineText = g.words.join(" ").replace(/\s+/g, " ").trim();
    if (!lineText) continue;

    const lineConf = mean(g.confs);
    const y = g.top;
    const x = g.left;

    lines.push({
      text: lineText,
      confidence: Number.isFinite(lineConf) ? lineConf : 0,
      bbox: { left: g.left, top: g.top, right: g.right, bottom: g.bottom },
      pos: { x, y },
    });
  }

  // sort “po ludzku”: najpierw góra->dół, potem lewo->prawo
  lines.sort((a, b) => (a.pos.y - b.pos.y) || (a.pos.x - b.pos.x));

  const fullText = lines.map((l) => l.text).join("\n").trim();
  const overallConf = mean(lines.map((l) => l.confidence));

  return {
    text: fullText,
    confidence: Number.isFinite(overallConf) ? overallConf : 0,
    lines,
    page: { width: pageW, height: pageH },
  };
}

function defaultBlocklist() {
  // ogólne “śmieci” (nie pod jedną stronę)
  return [
    "cookies",
    "polityka prywatności",
    "regulamin",
    "rodo",
    "zgoda",
    "newsletter",
    "subskrybuj",
    "zaloguj",
    "reklama",
    "sponsorowane",
    "promocja",
    "udostępnij",
    "obserwuj",
    "powiadomienia",
  ];
}

function normalizeForDup(s) {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s%.,:;()\-+]/gu, "") // wyrzuć “krzaki”
    .trim();
}

function looksLikeNoise(text) {
  const t = text.trim();
  if (t.length < 3) return true;

  // % znaków “normalnych”
  const normal = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  const ratio = normal / Math.max(1, t.length);

  // dużo losowych znaków/punktów → szum
  if (ratio < 0.35) return true;

  // “prawie same znaki specjalne”
  if (/^[\W_]+$/u.test(t)) return true;

  return false;
}

function cleanLines(lines, page, opts = {}) {
  const {
    headerFrac = 0.10,
    footerFrac = 0.10,
    minConf = 0.55,
    maxLines = 260,
    blocklist = [],
    extraBlocklistRegex = [],
  } = opts;

  const H = page?.height || 0;
  const headerY = H ? H * headerFrac : null;
  const footerY = H ? H * (1 - footerFrac) : null;

  const BL = [...defaultBlocklist(), ...blocklist]
    .map((s) => String(s).toLowerCase())
    .filter(Boolean);

  const blockRegexes = (extraBlocklistRegex || [])
    .map((r) => {
      try { return new RegExp(r, "i"); } catch { return null; }
    })
    .filter(Boolean);

  const meta = {
    total: lines.length,
    droppedByPos: 0,
    droppedByBlocklist: 0,
    droppedByNoise: 0,
    droppedByConf: 0,
    droppedByDup: 0,
    kept: 0,
  };

  const seen = new Set();
  const kept = [];

  for (const l of lines) {
    const text = (l.text || "").replace(/\s+/g, " ").trim();
    if (!text) { meta.droppedByNoise++; continue; }

    // 1) pozycja (nagłówek/stopka)
    if (headerY != null && l.bbox?.top != null && l.bbox.top < headerY) {
      meta.droppedByPos++;
      continue;
    }
    if (footerY != null && l.bbox?.top != null && l.bbox.top > footerY) {
      meta.droppedByPos++;
      continue;
    }

    // 2) pewność
    if ((l.confidence ?? 0) < minConf) {
      meta.droppedByConf++;
      continue;
    }

    // 3) blocklist
    const low = text.toLowerCase();
    if (BL.some((p) => p && low.includes(p))) {
      meta.droppedByBlocklist++;
      continue;
    }
    if (blockRegexes.some((re) => re.test(text))) {
      meta.droppedByBlocklist++;
      continue;
    }

    // 4) szum
    if (looksLikeNoise(text)) {
      meta.droppedByNoise++;
      continue;
    }

    // 5) duplikaty
    const key = normalizeForDup(text);
    if (key && seen.has(key)) {
      meta.droppedByDup++;
      continue;
    }
    if (key) seen.add(key);

    kept.push({ ...l, text });
    if (kept.length >= maxLines) break;
  }

  meta.kept = kept.length;
  const clean_text = kept.map((x) => x.text).join("\n").trim();

  return { clean_text, clean_lines: kept, clean_meta: meta };
}

export async function ocrImageWithTesseract({
  base64,
  lang = "pol+eng",
  psm = 6,
  timeoutMs = 20000,
  // cleaning
  clean = true,
  cleanOptions = {},
} = {}) {
  const cleanB64 = stripBase64Prefix(base64);
  if (!cleanB64) return { text: "", confidence: 0, lines: [], clean_text: "", clean_meta: null };

  const buf = Buffer.from(cleanB64, "base64");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inz-ocr-"));
  const file = path.join(tmpDir, `shot_${crypto.randomUUID()}.png`);

  try {
    await fs.writeFile(file, buf);

    const { stdout } = await run(
      "tesseract",
      [file, "stdout", "-l", lang, "--psm", String(psm), "tsv"],
      { timeoutMs },
    );

    const parsed = parseTsvToLines(stdout);

    if (!clean) {
      return {
        text: parsed.text,
        confidence: parsed.confidence,
        lines: parsed.lines,
      };
    }

    const cleaned = cleanLines(parsed.lines, parsed.page, cleanOptions);

    return {
      text: parsed.text,
      confidence: parsed.confidence,
      lines: parsed.lines,
      clean_text: cleaned.clean_text,
      clean_meta: cleaned.clean_meta,
      // opcjonalnie: jak chcesz trzymać w mongo tylko skrót (np. 50 linii)
      clean_lines: cleaned.clean_lines,
    };
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

export async function ocrTwoImagesWithTesseract({
  prevBase64,
  nextBase64,
  lang = "pol+eng",
  psm = 6,
  timeoutMs = 20000,
  clean = true,
  cleanOptions = {},
} = {}) {
  const [prev, next] = await Promise.all([
    ocrImageWithTesseract({ base64: prevBase64, lang, psm, timeoutMs, clean, cleanOptions }),
    ocrImageWithTesseract({ base64: nextBase64, lang, psm, timeoutMs, clean, cleanOptions }),
  ]);

  return {
    engine: "tesseract",
    meta: { lang, psm },
    prev,
    next,
  };
}

