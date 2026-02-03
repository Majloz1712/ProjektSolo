// skrypt/llm/paddleOcr.js
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeBase64(b64) {
  if (!b64) return null;
  let s = String(b64).trim();
  const idx = s.indexOf('base64,');
  if (idx !== -1) s = s.slice(idx + 7);
  // Obsługa data URI
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    if (comma !== -1) s = s.slice(comma + 1);
  }
  // Usunięcie białych znaków
  s = s.replace(/\s+/g, '');
  return s.length ? s : null;
}

function mapLang(lang) {
  const l = String(lang || '').toLowerCase().trim();
  if (!l) return 'en';

  // PaddleOCR "en" model obsługuje większość języków łacińskich (w tym PL)
  // "latin" nie jest poprawnym kluczem modelu w standardowym repo Paddle
  if (l === 'latin' || l.includes('pol') || l.includes('pl')) return 'en';
  if (l.includes('eng')) return 'en';

  if (l === 'ch' || l.includes('chi')) return 'ch';
  if (l === 'fr' || l.includes('fra')) return 'fr'; // fr istnieje jako oddzielny model, ale en też działa
  if (l === 'de' || l.includes('ger')) return 'german';
  if (l === 'ja' || l.includes('jap')) return 'japan';
  if (l === 'ko' || l.includes('kor')) return 'korean';

  return l;
}

// -----------------------------
// Uniwersalne czyszczenie OCR (deterministyczne)
// - zachowuje linie (clean_lines)
// - usuwa powtarzające się elementy UI (window + freq)
// - usuwa śmieciowe znaki/linie (quality score)
// - NIE używa słów-kluczy specyficznych dla domeny
// -----------------------------

function _countByScriptAndClass(str, sampleLimit = 12000) {
  const s = String(str || '').slice(0, sampleLimit);
  let latin = 0;
  let cjk = 0;
  let letters = 0;
  let digits = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (!cp) continue;
    if (/\p{L}/u.test(ch)) letters++;
    if (/\p{N}/u.test(ch)) digits++;
    if (/\p{Script=Latin}/u.test(ch)) latin++;
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch)) cjk++;
  }
  return { latin, cjk, letters, digits };
}

function _normalizeCommon(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\r\n?/g, '\n')
    .normalize('NFKC');
}

function _collapseSpacesPreserveNewlines(s) {
  // Zbijamy spacje/taby wewnątrz linii, ale nie dotykamy \n.
  return String(s)
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function _mergeHyphenatedAcrossNewlines(s) {
  return String(s).replace(/([\p{L}])-[\n]+([\p{L}])/gu, '$1$2');
}

function _stripLeadingIsolatedIcons(line, docIsLatinDominant) {
  // Bezpieczne: jeśli tekst jest głównie łaciński, a w linii są pojedyncze CJK znaki jako "ikonki".
  // Nie ruszamy stron w CJK (docIsLatinDominant = false).
  let s = String(line);
  if (!docIsLatinDominant) return s;
  // Usuń pojedyncze znaki CJK występujące jako osobne tokeny na początku / końcu
  s = s.replace(/^(?:\s*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\s+)+/gu, '');
  s = s.replace(/(?:\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\s*)+$/gu, '');
  return s;
}

function _stripCjkCharsEverywhere(line, docIsLatinDominant) {
  // Paddle często myli ikony UI jako znaki CJK (np. 回/女). Jeśli dokument jest łaciński,
  // bezpiecznie usuwamy WSZYSTKIE znaki CJK w linii (zostawiając resztę treści).
  // Nie aktywuj tego dla stron w językach CJK.
  if (!docIsLatinDominant) return String(line);
  return String(line).replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, '');
}

function _stripUiGlyphTokens(line, docIsLatinDominant) {
  // Uniwersalne: usuń tokeny-ikonki z OCR (checkboxy, pojedyncze CJK, gwiazdki, strzałki itp.)
  // Działa tylko, jeśli dokument jest głównie łaciński — nie psuj stron CJK.
  if (!docIsLatinDominant) return String(line);

  let s = String(line);

  // Najpierw usuń wszystkie znaki CJK (często są to fałszywe "ikonki" po OCR)
  s = _stripCjkCharsEverywhere(s, docIsLatinDominant);

  // Usuń pojedyncze znaki CJK występujące jako osobne tokeny w środku linii.
  // Przykład: "czego szukasz? 回 Pamiec" -> "czego szukasz? Pamiec"
  s = s.replace(/\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\s+/gu, ' ');

  // Usuń najczęstsze "ikonowe" tokeny jako osobne elementy.
  // (nie usuwamy ich, jeśli są sklejone ze słowami — wtedy to może być prawdziwy tekst)
  s = s.replace(/(?:^|\s)(?:[□■▢▣▤▥▦▧▨▩◆◇◈○●◎◉◌◍◯◻◼☐☑☒]|[↑↓←→⇧⇩⇦⇨➔➜➤]|[★☆✦✧✩✪✫✬✭✮✯])(?:\s|$)/gu, ' ');

  // Usuń powtarzalne "gwiazdki ratingu" (często zalewają tekst)
  s = s.replace(/[★☆]{3,}/g, ' ');

  return s.replace(/\s{2,}/g, ' ').trim();
}

function _fixSpacingHeuristics(line) {
  // Uniwersalne, ostrożne: popraw typowe sklejenia po OCR.
  // Nie dotykamy UPPERCASE+digit (kody produktów) — tylko lowercase.
  let s = String(line);
  // "1osoba" -> "1 osoba"
  s = s.replace(/(\p{N})(\p{Ll})/gu, '$1 $2');
  // "wersja2" -> "wersja 2"
  s = s.replace(/(\p{Ll})(\p{N})/gu, '$1 $2');
  // "PropozycjeDla" -> "Propozycje Dla"
  s = s.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
  // przecinek/kropka bez spacji
  s = s.replace(/([,.;:!?])(\p{L})/gu, '$1 $2');
  // nawiasy
  s = s.replace(/([\)\]])(\p{L})/gu, '$1 $2');
  s = s.replace(/(\p{L})([\(\[])/gu, '$1 $2');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function _stripWeirdControlAndBoxChars(line) {
  // Usuń znaki kontrolne/zero-width/box-drawing itp. (uniwersalne)
  return String(line)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '')
    .replace(/[\u2500-\u257F]/g, '');
}

function _lineFingerprint(line) {
  // Fingerprint do dedupe/boilerplate.
  // UWAGA: nie usuwamy cyfr — inaczej ceny/parametry z różnymi liczbami zleją się w jedno.
  return String(line)
    .toLowerCase()
    .replace(/[\p{Sc}]/gu, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/[\s]+/g, ' ')
    .trim();
}

function _lineExactKey(line) {
  // Klucz do bezpiecznej deduplikacji "dokładnej": zachowuje cyfry i większość treści.
  // Normalizuje tylko whitespace + casing.
  return String(line)
    .toLowerCase()
    .replace(/[\u00A0]/g, ' ')
    .replace(/[\s]+/g, ' ')
    .trim();
}

function _lineQuality(line) {
  const s = String(line);
  const len = s.length || 1;
  let letters = 0;
  let digits = 0;
  let spaces = 0;
  let other = 0;
  let latinLetters = 0;
  for (const ch of s) {
    if (/\p{L}/u.test(ch)) {
      letters++;
      if (/\p{Script=Latin}/u.test(ch)) latinLetters++;
    } else if (/\p{N}/u.test(ch)) digits++;
    else if (ch === ' ') spaces++;
    else other++;
  }
  const alphaRatio = letters / len;
  const digitRatio = digits / len;
  const otherRatio = other / len;
  const tokenCount = s.trim().split(/\s+/).filter(Boolean).length;

  // prosta detekcja bełkotu: długi token prawie bez samogłosek (dla łacińskiego)
  let gibberish = false;
  const vowels = /[aeiouyąęóAEIOUYĄĘÓ]/g;
  const tokens = s.split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    const alphaOnly = t.replace(/[^\p{L}]/gu, '');
    if (alphaOnly.length >= 18) {
      const v = (alphaOnly.match(vowels) || []).length;
      if (v / alphaOnly.length < 0.16) {
        gibberish = true;
        break;
      }
    }
  }

  return { alphaRatio, digitRatio, otherRatio, tokenCount, letters, digits, latinLetters, gibberish };
}

function cleanOcrToLines(rawText, opts = {}) {
  const {
    mergeHyphenated = true,
    fixCommon = true,
    keepNewlines = true,
    // dedupe
    dedupeWindow = 80,
    boilerplateMinFreq = 2,
    boilerplateMaxLineLen = 90,
    dropMostlyJunkLines = true,
    // usuń tokeny-ikonki (checkboxy, pojedyncze CJK itp.)
    stripUiGlyphs = true,
    // usuń znaki CJK nawet gdy są "sklejone" (np. ★女★★) — tylko dla łacińskich dokumentów
    stripCjkChars = true,
    // popraw typowe sklejenia po OCR (ostrożne heurystyki)
    fixSpacing = true,
    // deduplikacja dokładna (globalnie) — usuwa powtórzenia bez wycinania treści
    dedupeExact = true,
    collapseSpaces = true,
  } = opts;

  let s = _normalizeCommon(rawText);
  if (mergeHyphenated) s = _mergeHyphenatedAcrossNewlines(s);
  if (!keepNewlines) s = s.replace(/\n+/g, ' ');
  if (collapseSpaces) s = keepNewlines ? _collapseSpacesPreserveNewlines(s) : s.replace(/\s+/g, ' ').trim();

  // split
  let lines = s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  const docStats = _countByScriptAndClass(lines.join('\n'));
  // trochę bardziej tolerancyjne niż 0.55, bo UI potrafi generować fałszywe CJK
  const latinShare = docStats.letters > 0 ? (docStats.latin / docStats.letters) : 1;
  const cjkShare = docStats.letters > 0 ? (docStats.cjk / docStats.letters) : 0;
  const docIsLatinDominant = docStats.letters > 0 ? (latinShare >= 0.45 && cjkShare <= 0.35) : true;

  const removed = { junk: 0, window_dup: 0, boilerplate: 0, exact_dup: 0 };
  const counts = { in_lines: lines.length, out_lines: 0 };

  // 1) per-line cleanup + quality filter
  const cleaned = [];
  const fingerprints = [];
  const exactKeys = [];
  for (const line0 of lines) {
    let line = line0;
    if (fixCommon) line = _normalizeCommon(line);
    line = _stripWeirdControlAndBoxChars(line);
    line = _stripLeadingIsolatedIcons(line, docIsLatinDominant);
    if (stripCjkChars) line = _stripCjkCharsEverywhere(line, docIsLatinDominant);
    if (stripUiGlyphs) line = _stripUiGlyphTokens(line, docIsLatinDominant);
    if (fixSpacing) line = _fixSpacingHeuristics(line);
    if (collapseSpaces) line = line.replace(/[\t\f\v ]+/g, ' ').trim();
    if (!line) continue;

    const q = _lineQuality(line);
    // Odrzucaj oczywiste śmieci (uniwersalne, statystyczne)
    if (dropMostlyJunkLines) {
      const alnum = q.letters + q.digits;
      if (alnum < 3 && q.tokenCount <= 2) {
        removed.junk++;
        continue;
      }
      if (q.gibberish && q.alphaRatio < 0.6) {
        removed.junk++;
        continue;
      }
      if (q.alphaRatio < 0.18 && q.digitRatio < 0.12 && q.otherRatio > 0.45 && line.length < 120) {
        removed.junk++;
        continue;
      }
    }

    cleaned.push(line);
    fingerprints.push(_lineFingerprint(line));
    exactKeys.push(_lineExactKey(line));
  }

  // 2) window dedupe (dokładne) — usuwa powtórki generowane przez slicing/scrolling
  const win = Math.max(0, Number(dedupeWindow) || 0);
  const lastSeen = new Map();
  const winFiltered = [];
  const winFp = [];
  const winKeys = [];
  for (let i = 0; i < cleaned.length; i++) {
    const key = exactKeys[i];
    const fp = fingerprints[i];
    const last = lastSeen.get(key);
    if (win > 0 && key && last !== undefined && (i - last) <= win) {
      removed.window_dup++;
      continue;
    }
    lastSeen.set(key, i);
    winFiltered.push(cleaned[i]);
    winFp.push(fp);
    winKeys.push(key);
  }

  // 3) boilerplate freq (ostrożne): zostaw pierwsze wystąpienie
  const freq = new Map();
  for (const fp of winFp) {
    if (!fp) continue;
    freq.set(fp, (freq.get(fp) || 0) + 1);
  }

  const seenBoiler = new Set();
  const out = [];
  for (let i = 0; i < winFiltered.length; i++) {
    const line = winFiltered[i];
    const fp = winFp[i];
    if (!fp) {
      out.push(line);
      continue;
    }

    const f = freq.get(fp) || 0;
    if (f >= boilerplateMinFreq && line.length <= boilerplateMaxLineLen) {
      // filtr ostrożny: usuń tylko kolejne wystąpienia, jeśli to wygląda jak UI (mało "treści")
      const q = _lineQuality(line);
      const uiLike = q.tokenCount <= 10 && (q.alphaRatio < 0.78 || q.digitRatio > 0.22);
      if (uiLike) {
        if (seenBoiler.has(fp)) {
          removed.boilerplate++;
          continue;
        }
        seenBoiler.add(fp);
      }
    }
    out.push(line);
  }

  // 4) global exact dedupe — usuń identyczne linie, ale zachowaj pierwsze wystąpienie.
  // To jest "algorytm", który bezpiecznie redukuje np. wielokrotne "allegro czego szukasz?"
  // bez ręcznego blacklistowania fraz.
  let finalOut = out;
  if (dedupeExact) {
    const seen = new Set();
    const deduped = [];
    for (const line of out) {
      const key = _lineExactKey(line);
      if (key && seen.has(key)) {
        removed.exact_dup++;
        continue;
      }
      if (key) seen.add(key);
      deduped.push(line);
    }
    finalOut = deduped;
  }

  counts.out_lines = finalOut.length;
  return {
    raw_text: String(rawText || ''),
    clean_lines: finalOut,
    clean_text: finalOut.join('\n').trim(),
    clean_meta: {
      mode: 'lines',
      counts,
      removed,
      params: {
        mergeHyphenated,
        fixCommon,
        keepNewlines,
        dedupeWindow: win,
        boilerplateMinFreq,
        boilerplateMaxLineLen,
        dropMostlyJunkLines,
        stripUiGlyphs,
        stripCjkChars,
        dedupeExact,
        fixSpacing,
        collapseSpaces,
      },
      doc: {
        isLatinDominant: docIsLatinDominant,
      },
    },
  };
}

/**
 * Główna funkcja OCR
 */
export async function ocrImageWithPaddle({
  base64,
  lang = 'en',
  timeoutMs = 120000,
  clean = true,
  cleanOptions = {},
  pythonBin,
} = {}) {
  const b64 = normalizeBase64(base64);

  // Domyślne ścieżki
  const defaultPython = process.env.OCR_PYTHON_BIN || 'python3';
  const py = pythonBin || defaultPython;

  // Bezwzględna ścieżka do skryptu
  const scriptPath = path.resolve(__dirname, 'paddle_ocr.py');

  if (!fs.existsSync(scriptPath)) {
    return { error: `MISSING_SCRIPT: ${scriptPath}`, engine: 'paddleocr', text: '' };
  }

  if (!b64) {
    return { error: 'NO_BASE64', engine: 'paddleocr', text: '' };
  }

  const effectiveLang = mapLang(lang);
  const args = [scriptPath, '--lang', effectiveLang];

  // ENV: wymuszamy kodowanie + workarounds
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',

    // Paddle noise reduction (nie zawsze uciszy tqdm, ale pomaga)
    GLOG_minloglevel: process.env.GLOG_minloglevel ?? '3',
    FLAGS_minloglevel: process.env.FLAGS_minloglevel ?? '3',
    PADDLE_LOG_LEVEL: process.env.PADDLE_LOG_LEVEL ?? '3',

    // Modele / network check
    DISABLE_MODEL_SOURCE_CHECK: process.env.DISABLE_MODEL_SOURCE_CHECK ?? 'True',

    // Workaround na oneDNN/PIR crashe (można nadpisać env)
    FLAGS_use_mkldnn: process.env.FLAGS_use_mkldnn ?? '0',
    FLAGS_enable_pir_api: process.env.FLAGS_enable_pir_api ?? '0',
  };

  const hardTimeout = Math.max(2000, Number(timeoutMs) || 60000);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(py, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
      return resolve({ error: `SPAWN_FAIL: ${e.message}`, engine: 'paddleocr', text: '' });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      if (child) child.kill('SIGKILL');
    }, hardTimeout);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);

      const baseMeta = {
        engine: 'paddleocr',
        python_used: py,
        script_used: scriptPath,
        lang: effectiveLang,
      };

      resolve({ ...baseMeta, ...result });
    };

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    // CRITICAL FIX: Ignore EPIPE on stdin.
    child.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') {
        stderr += `\nSTDIN_ERROR: ${err.message}`;
      }
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        return finish({ error: `TIMEOUT_${hardTimeout}MS`, text: '', stderr: stderr.slice(0, 2000) });
      }

      // Parse JSON output
      const trimmed = stdout.trim();
      let parsed = null;

      try {
        // 1. Próba: Czysty JSON
        parsed = JSON.parse(trimmed);
      } catch (e) {
        // 2. Próba: Znalezienie ostatniego obiektu JSON w śmieciach
        const matches = trimmed.match(/\{[\s\S]*\}/g);
        if (matches && matches.length) {
          try {
            parsed = JSON.parse(matches[matches.length - 1]);
          } catch {}
        }

        // 3. Próba: Szukanie wzorca {"ok":...}
        if (!parsed) {
          const match = stdout.match(/\{.*"ok":.*\}/s);
          if (match) {
            try {
              parsed = JSON.parse(match[0]);
            } catch {}
          }
        }
      }

      if (signal) {
        return finish({
          error: `KILLED_${signal}`,
          stderr: stderr.slice(0, 2000),
          stdout: stdout.slice(0, 2000),
          text: '',
        });
      }

      if (!parsed) {
        return finish({
          error: code !== 0 ? `PYTHON_EXIT_${code}` : 'BAD_JSON_OUTPUT',
          stderr: stderr.slice(0, 2000),
          stdout: stdout.slice(0, 2000),
          text: '',
        });
      }

      if (!parsed.ok) {
        return finish({
          error: parsed.error || 'PYTHON_LOGIC_ERROR',
          text: '',
          stderr: stderr.slice(0, 2000),
          stdout: stdout.slice(0, 2000),
        });
      }

      // Success
      const rawText = parsed.text || '';
      const normalized = clean ? cleanOcrToLines(rawText, cleanOptions) : {
        raw_text: rawText,
        clean_lines: rawText ? String(rawText).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [],
        clean_text: String(rawText || '').trim(),
        clean_meta: null,
      };

      finish({
        // kompatybilność wstecz
        text: rawText,
        confidence: parsed.confidence,

        // nowe pola
        raw_text: normalized.raw_text,
        clean_text: normalized.clean_text,
        clean_lines: normalized.clean_lines,
        clean_meta: normalized.clean_meta,

        stderr: stderr,
        stdout: stdout,
      });
    });

    // Write data and close stream
    try {
      child.stdin.write(b64);
      child.stdin.end();
    } catch (e) {
      finish({
        error: `WRITE_ERROR: ${e.message}`,
        text: '',
        stderr: (stderr || '').slice(0, 2000),
        stdout: (stdout || '').slice(0, 2000),
      });
      try {
        child.kill();
      } catch {}
    }
  });
}

