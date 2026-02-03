// skrypt/llm/llmChunker.js
// Semantic chunking via LLM + stable "anchor template" reuse.
//
// Problem, który naprawiamy:
// - Model potrafił "odpłynąć" i zamiast template chunków zwracał ekstrakcję produktów itp.
// - Anchory bywały niedopasowane (OCR ma inne białe znaki / nowe linie).
// - Gdy template był niepoprawny, pipeline i tak traktował analizę jako "last good".
//
// Ten moduł:
// - wymusza ścisły schemat JSON dla template,
// - waliduje + naprawia (retry) odpowiedź LLM,
// - w ostateczności buduje fallback template deterministycznie,
// - dopasowuje anchory w trybie "whitespace tolerant" (\s+), co stabilizuje reuse.

import { performance } from 'node:perf_hooks';
import {
  sha1,
  slugifyKey,
  normalizeWhitespace,
  excerpt,
  extractEvidenceSnippetsFromPair,
  headTailSnippets,
} from './analysisUtils.js';
import { generateTextWithOllama } from './ollamaClient.js';

const TEMPLATE = {
  MAX_CHUNKS: Number(process.env.LLM_CHUNK_MAX_CHUNKS || 18),
  MIN_CHUNKS: Number(process.env.LLM_CHUNK_MIN_CHUNKS || 3),
  // Anchory powinny być krótkie i stabilne.
  ANCHOR_MIN_CHARS: Number(process.env.LLM_CHUNK_ANCHOR_MIN_CHARS || 14),
  ANCHOR_MAX_CHARS: Number(process.env.LLM_CHUNK_ANCHOR_MAX_CHUNKS || process.env.LLM_CHUNK_ANCHOR_MAX_CHARS || 96),
  // Reuse: jaki % chunków musi się odnaleźć.
  MIN_FIT_RATIO: Number(process.env.LLM_CHUNK_MIN_FIT_RATIO || 0.6),
  // Nowy template: minimalny fit już na tekście źródłowym (jeśli za niski -> naprawa/fallback).
  MIN_FIT_RATIO_NEW: Number(process.env.LLM_CHUNK_MIN_FIT_RATIO_NEW || 0.75),
  // Ile zmienionych chunków trzymać jako evidence.
  MAX_CHANGED_FOR_JUDGE: Number(process.env.LLM_CHUNK_MAX_CHANGED_FOR_JUDGE || 8),
  // Retry count dla naprawy.
  MAX_TEMPLATE_REPAIR_ATTEMPTS: Number(process.env.LLM_CHUNK_TEMPLATE_REPAIR_ATTEMPTS || 2),
};

const CHUNK_DIFF = {
  NGRAM: Number(process.env.TEXT_CHUNK_NGRAM || 1),
  CHANGE_THRESHOLD: Number(process.env.TEXT_CHUNK_CHANGE_THRESHOLD || 0.12),
  CHANGE_THRESHOLD_NUM: Number(process.env.TEXT_CHUNK_CHANGE_THRESHOLD_NUM || 0.08),
  SIGNIFICANT_THRESHOLD: Number(process.env.TEXT_CHUNK_SIGNIFICANT_THRESHOLD || 0.18),
  SIGNIFICANT_THRESHOLD_NUM: Number(process.env.TEXT_CHUNK_SIGNIFICANT_THRESHOLD_NUM || 0.14),
  SIGNIFICANT_RATIO: Number(process.env.TEXT_CHUNK_SIGNIFICANT_RATIO || 0.08),
  SIGNIFICANT_CHANGED_CHUNKS: Number(process.env.TEXT_CHUNK_SIGNIFICANT_CHANGED_CHUNKS || 2),
};

function safeParseJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  try {
    return JSON.parse(s);
  } catch {}
  // fallback: wytnij największe {...}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const v = normalizeWhitespace(x);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function normalizeAnchorCandidates(obj) {
  const a1 = Array.isArray(obj?.anchor_candidates) ? obj.anchor_candidates : [];
  const a2 = Array.isArray(obj?.anchors) ? obj.anchors : [];
  const a3 = obj?.anchor ? [obj.anchor] : [];
  const a4 = Array.isArray(obj?.anchorCandidates) ? obj.anchorCandidates : [];
  const combined = uniq([...a1, ...a2, ...a3, ...a4]);

  return combined
    .map((x) => normalizeWhitespace(x))
    .filter(Boolean)
    .map((x) => x.slice(0, TEMPLATE.ANCHOR_MAX_CHARS))
    .filter((x) => x.length >= TEMPLATE.ANCHOR_MIN_CHARS);
}

function normalizeTemplate(rawTemplate) {
  if (!rawTemplate) return null;

  // OBSŁUGA popularnych "odchyłek" formatów (model czasem opakowuje)
  let t = rawTemplate;
  if (typeof t === 'string') t = safeParseJson(t);
  if (!t || typeof t !== 'object') return null;

  if (t.template && typeof t.template === 'object') t = t.template;
  if (!t.chunks && Array.isArray(t.sections)) t = { ...t, chunks: t.sections };
  if (!t.chunks && Array.isArray(t.parts)) t = { ...t, chunks: t.parts };

  const chunksRaw = Array.isArray(t.chunks) ? t.chunks : [];
  const chunks = [];

  for (let idx = 0; idx < chunksRaw.length; idx++) {
    const c = chunksRaw[idx];
    if (!c || typeof c !== 'object') continue;

    const title = normalizeWhitespace(c.title || c.label || c.name || c.heading || '') || null;
    const keyRaw = normalizeWhitespace(c.key || c.id || c.slug || '') || (title ? slugifyKey(title) : null);
    const key = keyRaw ? slugifyKey(keyRaw) : `chunk_${idx + 1}`;

    const anchorCandidates = normalizeAnchorCandidates(c);
    if (!anchorCandidates.length) continue;

    chunks.push({
      key,
      title: title || key,
      anchor_candidates: anchorCandidates,
    });
  }

  // de-dup keys, keep first
  const seen = new Set();
  const dedup = [];
  for (const c of chunks) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    dedup.push(c);
  }

  return {
    version: normalizeWhitespace(t.version) || 'anchor_template_v3',
    source: normalizeWhitespace(t.source) || null,
    chunks: dedup.slice(0, TEMPLATE.MAX_CHUNKS),
  };
}

function validateTemplate(template) {
  if (!template || typeof template !== 'object') return { ok: false, error: 'TEMPLATE_NOT_OBJECT' };
  if (!Array.isArray(template.chunks)) return { ok: false, error: 'TEMPLATE_NO_CHUNKS_ARRAY' };
  if (template.chunks.length < 1) return { ok: false, error: 'TEMPLATE_EMPTY' };

  for (const c of template.chunks) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'CHUNK_NOT_OBJECT' };
    if (!c.key || typeof c.key !== 'string') return { ok: false, error: 'CHUNK_KEY_MISSING' };
    if (!Array.isArray(c.anchor_candidates) || c.anchor_candidates.length < 1) {
      return { ok: false, error: `CHUNK_ANCHORS_MISSING:${c.key}` };
    }
  }

  return { ok: true, error: null };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function anchorRegexFromPhrase(phrase) {
  const src = normalizeWhitespace(phrase);

  // Tokeny: litery/cyfry (w tym unicode, np. polskie znaki).
  const tokens = (src.match(/[\p{L}\p{N}]+/gu) || []).filter(Boolean);
  if (!tokens.length) return null;

  const parts = tokens.map((t) => escapeRegex(t));

  // Między tokenami dopuszczamy dowolne znaki niebędące \w oraz '_' (czyli także spacje, \n, przecinki, kropki, itp.).
  // Uwaga: używamy dokładnie separatora [\W_]+, żeby lepiej znosić brudny OCR.
  return new RegExp(parts.join('[\\W_]+'), 'iu');
}




function findBestAnchorIndex(text, anchorCandidates, fromIndex = 0) {
  const src = String(text || '');
  const slice = src.slice(Math.max(0, fromIndex));
  if (!slice) return null;

  let best = null;

  for (const candidate of anchorCandidates || []) {
    const rx = anchorRegexFromPhrase(candidate);
    if (!rx) continue;
    const m = slice.match(rx);
    if (!m) continue;

    const index = (m.index ?? 0) + fromIndex;
    const score = 1000000 - index + String(candidate).length; // prefer earlier + longer

    if (!best || score > best.score) {
      best = { index, anchor: candidate, score };
    }
  }

  return best;
}

export function applyChunkTemplate(text, template, { maxChunks } = {}) {
  const tpl = normalizeTemplate(template);
  const v = validateTemplate(tpl);
  if (!v.ok) {
    return { ok: false, error: v.error, chunks: [] };
  }
  const chunks = [];
  const src = String(text || '');

  let cursor = 0;
  const tplChunks = tpl.chunks.slice(0, maxChunks || tpl.chunks.length);

  for (let i = 0; i < tplChunks.length; i++) {
    const c = tplChunks[i];
    const found = findBestAnchorIndex(src, c.anchor_candidates, cursor);
    if (!found) {
      // brak kotwicy -> pomijamy ten chunk
      continue;
    }

    const start = found.index;

    // end = start następnego chunk-a (jeśli znajdzie się później)
    let end = src.length;
    if (i + 1 < tplChunks.length) {
      const next = tplChunks[i + 1];
      const foundNext = findBestAnchorIndex(src, next.anchor_candidates, start + 1);
      if (foundNext) end = foundNext.index;
    }

    const chunkText = src.slice(start, end);
    chunks.push({
      id: c.key,
      title: c.title,
      anchor_used: found.anchor,
      text: normalizeWhitespace(chunkText),
      sha1: sha1(chunkText),
      len: chunkText.length,
    });

    cursor = start + 1;
  }

  return {
    ok: chunks.length > 0,
    error: chunks.length > 0 ? null : 'NO_ANCHORS_MATCHED',
    chunks,
  };
}

export function extractChunksByTemplate(text, template) {
  return applyChunkTemplate(text, template, { maxChunks: TEMPLATE.MAX_CHUNKS });
}

export function scoreTemplateFit(text, template) {
  const tpl = normalizeTemplate(template);
  const v = validateTemplate(tpl);
  if (!v.ok) return 0;

  const src = String(text || '');
  if (!src.trim()) return 0;

  let cursor = 0;
  let found = 0;

  for (const c of tpl.chunks) {
    const hit = findBestAnchorIndex(src, c.anchor_candidates, cursor);
    if (hit) {
      found += 1;
      cursor = hit.index + 1;
    }
  }

  return tpl.chunks.length ? found / tpl.chunks.length : 0;
}

// ---------- Diff per-chunk ----------

function tokenizeForDiff(text) {
  const s = normalizeWhitespace(text).toLowerCase();
  if (!s) return [];
  // n-gram = 1 by default, but allow small n-grams for robustness
  const tokens = s.split(/\s+/).filter(Boolean);
  if (CHUNK_DIFF.NGRAM <= 1) return tokens;

  const grams = [];
  for (let i = 0; i < tokens.length - CHUNK_DIFF.NGRAM + 1; i++) {
    grams.push(tokens.slice(i, i + CHUNK_DIFF.NGRAM).join(' '));
  }
  return grams;
}

function jaccard(a, b) {
  if (!a.length && !b.length) return 1;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function numericRatioDelta(prevText, nowText) {
  // W OCR liczby dominują; sprawdzamy czy zmieniło się dużo "liczb".
  const numsPrev = (String(prevText).match(/\d+[\d.,]*/g) || []).join(' ');
  const numsNow = (String(nowText).match(/\d+[\d.,]*/g) || []).join(' ');
  if (!numsPrev && !numsNow) return 0;

  const tPrev = tokenizeForDiff(numsPrev);
  const tNow = tokenizeForDiff(numsNow);
  return 1 - jaccard(tPrev, tNow);
}

export function computeChunkDiff(prevChunks, nowChunks) {
  const prev = Array.isArray(prevChunks) ? prevChunks : [];
  const now = Array.isArray(nowChunks) ? nowChunks : [];

  const prevMap = new Map(prev.map((c) => [c.id, c]));
  const nowMap = new Map(now.map((c) => [c.id, c]));

  const allIds = Array.from(new Set([...prevMap.keys(), ...nowMap.keys()]));

  const changed = [];
  const added = [];
  const removed = [];

  // Evidence snippets must be short and must include the actual change region.
  const evidenceOpts = {
    windowChars: Number(process.env.EVIDENCE_WINDOW_CHARS || 140),
    maxChars: Number(process.env.EVIDENCE_SNIPPET_MAX_CHARS || 320),
    maxSnippets: Number(process.env.EVIDENCE_MAX_SNIPPETS || 2),
    includeNumbers: true,
  };

  for (const id of allIds) {
    const a = prevMap.get(id);
    const b = nowMap.get(id);

    if (a && !b) {
      const before_snippets = headTailSnippets(a.text, { maxChars: evidenceOpts.maxChars });
      removed.push({
        key: id,
        id,
        title: a.title,
        before_snippets,
        before_preview: before_snippets[0] || excerpt(a.text, 220),
      });
      continue;
    }

    if (!a && b) {
      const after_snippets = headTailSnippets(b.text, { maxChars: evidenceOpts.maxChars });
      added.push({
        key: id,
        id,
        title: b.title,
        after_snippets,
        after_preview: after_snippets[0] || excerpt(b.text, 220),
      });
      continue;
    }

    const ta = tokenizeForDiff(a.text);
    const tb = tokenizeForDiff(b.text);

    const sim = jaccard(ta, tb);
    const delta = 1 - sim;

    const numDelta = numericRatioDelta(a.text, b.text);

    const threshold = numDelta >= 0.12 ? CHUNK_DIFF.CHANGE_THRESHOLD_NUM : CHUNK_DIFF.CHANGE_THRESHOLD;
    if (delta >= threshold) {
      const snippets = extractEvidenceSnippetsFromPair(a.text, b.text, evidenceOpts);
      changed.push({
        key: id,
        id,
        title: b.title || a.title,
        similarity: Number(sim.toFixed(3)),
        delta: Number(delta.toFixed(3)),
        numericDelta: Number(numDelta.toFixed(3)),
        before_snippets: snippets.before_snippets,
        after_snippets: snippets.after_snippets,
        // Backward-friendly fields (small)
        before_preview: snippets.before_snippets?.[0] || excerpt(a.text, 220),
        after_preview: snippets.after_snippets?.[0] || excerpt(b.text, 220),
      });
    }
  }

  const changedChunks = changed.length;
  const nowChunksCount = now.length || 0;

  const significant =
    changedChunks >= CHUNK_DIFF.SIGNIFICANT_CHANGED_CHUNKS ||
    (nowChunksCount ? changedChunks / nowChunksCount >= CHUNK_DIFF.SIGNIFICANT_RATIO : false) ||
    changed.some((c) => {
      const thr = c.numericDelta >= 0.12 ? CHUNK_DIFF.SIGNIFICANT_THRESHOLD_NUM : CHUNK_DIFF.SIGNIFICANT_THRESHOLD;
      return c.delta >= thr;
    });

  return {
    mode: 'llm_anchor_template',
    changedChunks,
    nowChunks: nowChunksCount,
    significant,
    changed,
    added,
    removed,
    // "for judge" (limit)
    changed_for_judge: changed.slice(0, TEMPLATE.MAX_CHANGED_FOR_JUDGE),
  };
}

// ---------- LLM template generation ----------

function buildChunkingSystemPrompt() {
  return [
    'Jesteś narzędziem do SEMANTYCZNEGO CHUNKOWANIA TEKSTU ze strony.',
    'Wejście: surowy TEXT (OCR/EXTRACTED).',
    '',
    'Twoje zadanie: podzielić TEXT na sensowne sekcje (tematy).',
    'Sekcje mają być stabilne między snapshotami (np. "Opinie", "Parametry", "Kontakt", "FAQ", "Regulamin", "Cennik" itd.).',
    '',
    'WAŻNE: NIE wyciągaj danych (nie rób list produktów, cen, itd.).',
    'WAŻNE: anchor_candidates MUSZĄ być dosłownymi fragmentami skopiowanymi z TEXT (dokładny copy/paste).',
    'Anchory powinny mieć 4-12 słów, najlepiej z nagłówka lub stałej etykiety sekcji.',
    '',
    'Zwróć WYŁĄCZNIE poprawny JSON o strukturze:',
    '{',
    '  "version": "anchor_template_v3",',
    '  "chunks": [',
    '    { "key": "stable_id", "title": "Nazwa sekcji", "anchor_candidates": ["dokladny fragment z TEXT", "..." ] }',
    '  ]',
    '}',
    '',
    'Reguły:',
    '- key: krótki, stabilny identyfikator (slug), bez spacji.',
    '- Nie powtarzaj key.',
    '- Podaj 3-6 anchor_candidates na chunk (zwiększa szansę dopasowania).',
    '- Jeśli TEXT jest długi -> daj 6-18 chunków. Jeśli krótki -> 2-6 chunków.',
  ].join('\n');
}

function buildChunkingPrompt({ text, url, source }) {
  // Uwaga: tu NIE wkładamy userPrompt, bo to rozjeżdża model w ekstrakcję domenową.
  const header = [
    `URL: ${url || 'unknown'}`,
    `SOURCE: ${source || 'unknown'}`,
    '',
    'TEXT:',
  ].join('\n');
  return header + '\n' + String(text || '').trim();
}

function fallbackTemplateFromText(text) {
  const src = String(text || '').trim();
  if (!src) {
    return {
      version: 'anchor_template_v3',
      source: null,
      chunks: [],
    };
  }

  // 1) spróbuj podzielić po pustych liniach
  let parts = src.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // 2) jeżeli OCR jest "spłaszczony" (mało \n), rozbij po pojedynczych \n
  if (parts.length < 3) {
    parts = src.split(/\n/).map((p) => p.trim()).filter(Boolean);
  }

  // 3) jeżeli dalej mało, rozbij po zdaniach / separatorach
  if (parts.length < 3) {
    parts = src
      .split(/(?<=[.!?])\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  // Grupuj w ~równe kawałki (ogólnie, bez domenowych heurystyk).
  const targetChunks = Math.min(
    TEMPLATE.MAX_CHUNKS,
    Math.max(TEMPLATE.MIN_CHUNKS, Math.round(src.length / 1200)),
  );

  if (parts.length > targetChunks) {
    const grouped = [];
    const groupSize = Math.ceil(parts.length / targetChunks);
    for (let i = 0; i < parts.length; i += groupSize) {
      grouped.push(parts.slice(i, i + groupSize).join('\n'));
    }
    parts = grouped;
  }

  const chunks = [];
  for (let i = 0; i < Math.min(parts.length, TEMPLATE.MAX_CHUNKS); i++) {
    const p = parts[i];
    // Anchor = pierwsze 10-14 słów (z tego samego tekstu => zawsze występuje).
    const words = normalizeWhitespace(p).split(/\s+/).filter(Boolean);
    const anchor = words.slice(0, 12).join(' ');
    const title = words.slice(0, 4).join(' ') || `Sekcja ${i + 1}`;

    chunks.push({
      key: `section_${i + 1}`,
      title: title,
      anchor_candidates: anchor.length >= TEMPLATE.ANCHOR_MIN_CHARS ? [anchor] : [normalizeWhitespace(p).slice(0, TEMPLATE.ANCHOR_MAX_CHARS)],
    });
  }

  return {
    version: 'anchor_template_v3',
    source: null,
    chunks,
  };
}

async function repairTemplateWithLLM({ model, text, url, source, badJson, errorHint }, { logger } = {}) {
  const log = logger || console;

  const system = buildChunkingSystemPrompt();
  const prompt = [
    'Twoja poprzednia odpowiedź JSON była NIEPOPRAWNA dla wymaganego schematu chunk template.',
    errorHint ? `Powód: ${errorHint}` : null,
    '',
    'POPRAW to i zwróć TYLKO JSON o schemacie {version, chunks:[{key,title,anchor_candidates}]}.',
    'Nie zwracaj żadnych innych kluczy typu products, price_info, itp.',
    'anchor_candidates MUSZĄ być skopiowane dosłownie z TEXT (copy/paste).',
    '',
    'Poniżej wadliwa odpowiedź (do przerobienia):',
    String(badJson || '').slice(0, 2000),
    '',
    '---',
    buildChunkingPrompt({ text, url, source }),
  ].filter(Boolean).join('\n');

const raw = await generateTextWithOllama({
  prompt,
  system,
  model,
  format: 'json',
  // Fail-fast: nie blokuj pipeline'u na długich odpowiedziach modelu.
  // Temperature ustawiamy przez wrapper (trafia do options.temperature).
  temperature: 0.1,
  timeoutMs: 15000,
  options: {
    num_predict: Number(process.env.OLLAMA_NUM_PREDICT_CHUNK || 900),
    top_p: 0.2,
    repeat_penalty: 1.1,
  },
  logger: log,
});



  return raw;
}

export async function buildChunkTemplateLLM(
  {
    text,
    source,
    url,
    // userPrompt jest celowo ignorowany (zbyt często powodował ekstrakcję domenową zamiast chunkowania)
    userPrompt,
    model,
  },
  { logger } = {},
) {
  const log = logger || console;
  const rawText = String(text || '').trim();
  const t0 = performance.now();

  let lastRaw = null;
  let lastError = null;
  let template = null;
  let repaired = 0;
  let fallbackUsed = false;

  const system = buildChunkingSystemPrompt();
  const prompt = buildChunkingPrompt({ text: rawText, url, source });

  // 1) pierwsza próba
  try {
    lastRaw = await generateTextWithOllama({
      prompt,
      system,
      model,
      format: 'json',
      temperature: 0.1,
      timeoutMs: 15000,
      options: {
        num_predict: Number(process.env.OLLAMA_NUM_PREDICT_CHUNK || 900),
        top_p: 0.2,
        repeat_penalty: 1.1,
      },
      logger: log,
    });

  } catch (e) {
    lastError = e?.message || String(e);
  }

  // 2) walidacja + ewentualne naprawy
  for (let attempt = 0; attempt <= TEMPLATE.MAX_TEMPLATE_REPAIR_ATTEMPTS; attempt++) {
    const parsed = safeParseJson(lastRaw);
    const normalized = parsed ? normalizeTemplate(parsed) : null;
    const v = validateTemplate(normalized);

    if (v.ok) {
      const fit = scoreTemplateFit(rawText, normalized);
      if (fit >= TEMPLATE.MIN_FIT_RATIO_NEW) {
        template = normalized;
        break;
      }
      // template ma schemat, ale anchory nie siadają -> naprawa
      lastError = `LOW_FIT_RATIO(${fit.toFixed(3)})`;
    } else {
      lastError = v.error || 'LLM_CHUNK_TEMPLATE_INVALID';
    }

    if (attempt >= TEMPLATE.MAX_TEMPLATE_REPAIR_ATTEMPTS) break;

    repaired += 1;
    try {
      lastRaw = await repairTemplateWithLLM(
        {
          model,
          text: rawText,
          url,
          source,
          badJson: lastRaw,
          errorHint: lastError,
        },
        { logger: log },
      );
    } catch (e) {
      lastError = e?.message || String(e);
      break;
    }
  }

  // 3) fallback deterministyczny (żeby chunking działał "zawsze")
  if (!template) {
    fallbackUsed = true;
    template = fallbackTemplateFromText(rawText);
    const v = validateTemplate(template);
    if (!v.ok) {
      // to praktycznie nie powinno się zdarzyć
      template = { version: 'anchor_template_v3', source: null, chunks: [] };
    }
  }

  const durationMs = Math.round(performance.now() - t0);
  const ok = !!(template && Array.isArray(template.chunks) && template.chunks.length >= 1);

  const out = {
    ok,
    model,
    createdAt: new Date().toISOString(),
    durationMs,
    text_sha1: sha1(rawText),
    template: ok ? template : null,
    chunks: ok ? template.chunks : [],
    error: ok ? null : (lastError || 'LLM_CHUNK_TEMPLATE_FAILED'),
    raw: lastRaw != null ? String(lastRaw) : null,
    repaired,
    fallbackUsed,
  };

  if (!ok) {
    log?.warn?.('llm_chunk_template_failed', {
      model,
      source,
      durationMs,
      error: out.error,
      rawPreview: out.raw ? out.raw.slice(0, 220) : null,
    });
  } else {
    log?.info?.('llm_chunk_template_ok', {
      model,
      source,
      durationMs,
      chunks: out.chunks.length,
      repaired,
      fallbackUsed,
    });
  }

  return out;
}
