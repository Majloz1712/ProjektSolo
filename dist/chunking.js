import crypto from "node:crypto";

const DEFAULT_OPTIONS = {
  ollamaUrl: "http://localhost:11434/api/chat",
  model: "llama3.2:3b",
  temperature: 0.2,
  seed: 42,
  timeoutMs: 12_000,
  maxRetries: 2,
  maxPromptChars: 120_000,
  maxDescriptorsPerBatch: 120,
  forceFallback: false,
};

export async function chunkPageText(input, options = {}) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const notes = [];
  const units = buildUnits(input.text);
  if (units.length === 0) {
    return emptyResult(input, mergedOptions, notes);
  }

  const baseTarget =
    input.previous?.chunks.length ??
    input.targetChunkCount ??
    guessChunkCount(input.text.length);
  let targetCount = Math.min(baseTarget, units.length);
  if (targetCount !== baseTarget) {
    notes.push(
      `Adjusted target_chunk_count from ${baseTarget} to ${targetCount} because there are fewer units.`,
    );
  }

  let ranges = null;
  if (!mergedOptions.forceFallback) {
    try {
      if (input.previous?.chunks?.length) {
        ranges = await chunkWithAnchors(
          units,
          input.previous.chunks,
          targetCount,
          mergedOptions,
        );
      } else {
        ranges = await chunkWithLLM(units, targetCount, mergedOptions);
      }
    } catch (error) {
      notes.push(`LLM error, using heuristic fallback: ${error}`);
    }
  }

  if (!ranges) {
    ranges = heuristicRanges(units);
    ranges = rebalanceRanges(ranges, targetCount, units.length, notes);
  }

  const chunkResults = buildChunks(units, ranges);
  const unitMap = buildUnitMap(ranges, units.length);
  return {
    version: "1.0",
    model: {
      provider: "ollama",
      name: mergedOptions.model,
      options: {
        temperature: mergedOptions.temperature,
        seed: mergedOptions.seed,
      },
    },
    source: {
      url: input.url ?? null,
      input_chars: input.text.length,
      input_units: units.length,
    },
    target_chunk_count: chunkResults.length,
    chunks: chunkResults,
    unit_map: unitMap,
    notes,
  };
}

function emptyResult(input, options, notes) {
  notes.push("No units detected in input text.");
  return {
    version: "1.0",
    model: {
      provider: "ollama",
      name: options.model,
      options: { temperature: options.temperature, seed: options.seed },
    },
    source: {
      url: input.url ?? null,
      input_chars: input.text.length,
      input_units: 0,
    },
    target_chunk_count: 0,
    chunks: [],
    unit_map: [],
    notes,
  };
}

function guessChunkCount(charCount) {
  if (charCount < 8_000) {
    return 4;
  }
  const rough = Math.round(charCount / 15_000);
  return clamp(rough, 8, 32);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildUnits(text) {
  const lines = text.split(/\n/);
  const units = [];
  let buffer = null;
  let bufferType = "paragraph";
  let offset = 0;

  const flush = () => {
    if (!buffer) return;
    const raw = text.slice(buffer.start, buffer.end);
    const normalized = normalizeWhitespace(raw);
    if (normalized.length > 0) {
      units.push({
        index: units.length,
        text: raw,
        normalized,
        type: bufferType,
        startChar: buffer.start,
        endChar: buffer.end,
      });
    }
    buffer = null;
    bufferType = "paragraph";
  };

  lines.forEach((line, idx) => {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const trimmed = line.trim();
    const hasNext = idx < lines.length - 1;
    offset += line.length + (hasNext ? 1 : 0);

    if (!trimmed) {
      flush();
      return;
    }

    if (isHeading(trimmed)) {
      flush();
      units.push({
        index: units.length,
        text: text.slice(lineStart, lineEnd),
        normalized: normalizeWhitespace(trimmed),
        type: "heading",
        startChar: lineStart,
        endChar: lineEnd,
      });
      return;
    }

    if (!buffer) {
      buffer = { start: lineStart, end: lineEnd };
      bufferType = isListLine(trimmed) ? "list" : "paragraph";
    } else {
      buffer.end = lineEnd;
      if (bufferType === "paragraph" && isListLine(trimmed)) {
        bufferType = "list";
      }
    }
  });

  flush();
  return units;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isHeading(text) {
  if (/^#{1,6}\s/.test(text)) return true;
  if (text.length <= 80 && /:$/.test(text)) return true;
  if (text.length <= 80 && /^[A-Z0-9][A-Z0-9\s\-]{3,}$/.test(text)) return true;
  return false;
}

function isListLine(text) {
  return /^([-*•]|\d+\.)\s/.test(text);
}

function createDescriptor(unit) {
  const maxHead = 320;
  const maxTail = 140;
  const normalized = unit.normalized;
  if (normalized.length <= maxHead + maxTail + 10) {
    return { index: unit.index, type: unit.type, excerpt: normalized };
  }
  const head = normalized.slice(0, maxHead);
  const tail = normalized.slice(-maxTail);
  return {
    index: unit.index,
    type: unit.type,
    excerpt: `${head} … ${tail}`,
  };
}

async function chunkWithLLM(units, targetCount, options) {
  const descriptors = units.map(createDescriptor);
  const compact = compactDescriptors(descriptors, options.maxPromptChars);
  const promptDescriptors = compact.descriptors;
  const mapping = compact.mapping;
  const prompt = buildChunkPrompt(promptDescriptors, targetCount);
  const response = await callOllamaJson(prompt, options, "chunk-boundaries");
  const boundaries = parseBoundaries(
    response,
    promptDescriptors.length,
    targetCount,
  );
  const mappedBoundaries = boundaries.map(
    (boundary) => mapping[boundary] ?? mapping[mapping.length - 1],
  );
  return rangesFromBoundaries(
    mappedBoundaries,
    units.length,
    targetCount,
  );
}

async function chunkWithAnchors(units, previous, targetCount, options) {
  const anchorPrompt = buildAnchorPrompt(previous, targetCount);
  const anchorsResponse = await callOllamaJson(
    anchorPrompt,
    options,
    "anchors",
  );
  const anchors = parseAnchors(anchorsResponse, targetCount);
  const descriptors = units.map(createDescriptor);
  const assignments = [];
  let startIndex = 0;
  let lastChunk = 0;
  while (startIndex < descriptors.length) {
    const batch = takeDescriptorBatch(
      descriptors,
      startIndex,
      options.maxDescriptorsPerBatch,
      options.maxPromptChars,
    );
    const batchPrompt = buildAssignPrompt(
      anchors,
      batch,
      lastChunk,
      targetCount,
    );
    const batchResponse = await callOllamaJson(
      batchPrompt,
      options,
      "assignments",
    );
    const batchAssignments = parseAssignments(
      batchResponse,
      batch.length,
      targetCount,
    );
    for (const value of batchAssignments) {
      const safe = clamp(value, lastChunk, targetCount - 1);
      assignments.push(safe);
      lastChunk = safe;
    }
    startIndex += batch.length;
  }

  let ranges = rangesFromAssignments(assignments);
  ranges = rebalanceRanges(ranges, targetCount, units.length, []);
  return ranges;
}

function compactDescriptors(descriptors, maxPromptChars) {
  const totalChars = descriptors.reduce((sum, desc) => sum + desc.excerpt.length, 0);
  if (totalChars <= maxPromptChars) {
    return { descriptors, mapping: descriptors.map((desc) => desc.index) };
  }
  const blockSize = Math.ceil(descriptors.length / Math.max(1, Math.floor(maxPromptChars / 800)));
  const compacted = [];
  const mapping = [];
  for (let i = 0; i < descriptors.length; i += blockSize) {
    const block = descriptors.slice(i, i + blockSize);
    const first = block[0];
    const last = block[block.length - 1];
    compacted.push({
      index: compacted.length,
      type: first.type,
      excerpt: `${first.excerpt} … ${last.excerpt}`,
    });
    mapping.push(last.index);
  }
  return { descriptors: compacted, mapping };
}

function buildChunkPrompt(descriptors, targetCount) {
  return {
    system:
      "You split ordered units into semantic chunks. Return only JSON. No markdown.",
    user: {
      task: "chunk-boundaries",
      target_chunk_count: targetCount,
      units: descriptors,
      instructions:
        "Return JSON with {\"boundaries\": [unit_end_indices]}. The array length must equal target_chunk_count. Indices must be non-decreasing, last must be the final unit index. No extra text.",
    },
  };
}

function buildAnchorPrompt(previous, targetCount) {
  const chunkDescriptors = previous.map((chunk) => ({
    id: chunk.id,
    title: chunk.title ?? "",
    excerpt: createExcerpt(chunk.text, 380, 160),
  }));
  return {
    system:
      "You generate short anchor summaries. Return only JSON. No markdown.",
    user: {
      task: "anchors",
      target_chunk_count: targetCount,
      chunks: chunkDescriptors,
      instructions:
        "Return JSON with {\"anchors\": [{\"id\": number, \"title\": string, \"keywords\": [string]}]}. Provide exactly one anchor per chunk id in order.",
    },
  };
}

function buildAssignPrompt(anchors, descriptors, minChunkId, targetCount) {
  return {
    system:
      "You assign each unit to a chunk anchor. Return only JSON. No markdown.",
    user: {
      task: "assignments",
      min_chunk_id: minChunkId,
      target_chunk_count: targetCount,
      anchors,
      units: descriptors,
      instructions:
        "Return JSON with {\"assignments\": [chunk_id]}. Length must equal units length. chunk_id must be between min_chunk_id and target_chunk_count-1, and non-decreasing.",
    },
  };
}

async function callOllamaJson(prompt, options, label) {
  const payload = {
    model: options.model,
    stream: false,
    messages: [
      { role: "system", content: prompt.system },
      {
        role: "user",
        content: JSON.stringify(prompt.user),
      },
    ],
    options: {
      temperature: options.temperature,
      seed: options.seed,
    },
  };

  const responseText = await callOllama(payload, options);
  try {
    return JSON.parse(responseText);
  } catch (error) {
    const repaired = await repairJson(responseText, label, options);
    return JSON.parse(repaired);
  }
}

async function callOllama(payload, options) {
  let attempt = 0;
  let lastError;
  while (attempt <= options.maxRetries) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(options.ollamaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`Ollama HTTP ${response.status}`);
      }
      const json = await response.json();
      const content = json.message?.content;
      if (!content) {
        throw new Error("Ollama response missing content.");
      }
      return content.trim();
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
    }
  }
  throw lastError;
}

async function repairJson(invalidText, label, options) {
  const prompt = {
    model: options.model,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You fix JSON. Return only valid JSON. No markdown or commentary.",
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "repair-json",
          label,
          invalid: invalidText.slice(0, 2000),
          instructions:
            "Return only valid JSON matching the expected schema for the task label.",
        }),
      },
    ],
    options: {
      temperature: 0.1,
      seed: options.seed,
    },
  };
  return callOllama(prompt, options);
}

function parseBoundaries(response, unitCount, targetCount) {
  if (
    !response ||
    typeof response !== "object" ||
    !Array.isArray(response.boundaries)
  ) {
    throw new Error("Invalid boundaries response.");
  }
  const boundaries = response.boundaries
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isFinite(value));
  if (boundaries.length !== targetCount) {
    throw new Error("Incorrect boundaries length.");
  }
  return boundaries.map((value, idx) => {
    const min = idx === 0 ? 0 : boundaries[idx - 1];
    return clamp(value, min, unitCount - 1);
  });
}

function parseAnchors(response, targetCount) {
  if (
    !response ||
    typeof response !== "object" ||
    !Array.isArray(response.anchors)
  ) {
    throw new Error("Invalid anchors response.");
  }
  const anchors = response.anchors;
  if (anchors.length !== targetCount) {
    throw new Error("Incorrect anchors length.");
  }
  return anchors.map((anchor, index) => ({
    id: Number(anchor.id ?? index),
    title: String(anchor.title ?? ""),
    keywords: Array.isArray(anchor.keywords)
      ? anchor.keywords.map((keyword) => String(keyword))
      : [],
  }));
}

function parseAssignments(response, expectedLength, targetCount) {
  if (
    !response ||
    typeof response !== "object" ||
    !Array.isArray(response.assignments)
  ) {
    throw new Error("Invalid assignments response.");
  }
  const assignments = response.assignments
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isFinite(value));
  if (assignments.length !== expectedLength) {
    throw new Error("Incorrect assignments length.");
  }
  return assignments.map((value) => clamp(value, 0, targetCount - 1));
}

function rangesFromBoundaries(boundaries, unitCount, targetCount) {
  const ranges = [];
  let start = 0;
  boundaries.forEach((end, idx) => {
    const safeEnd =
      idx === boundaries.length - 1 ? unitCount - 1 : Math.min(end, unitCount - 1);
    const adjustedEnd = safeEnd < start ? Math.min(start, unitCount - 1) : safeEnd;
    ranges.push({ start, end: adjustedEnd });
    start = safeEnd + 1;
  });
  if (ranges.length !== targetCount) {
    return rebalanceRanges(ranges, targetCount, unitCount, []);
  }
  return ranges;
}

function rangesFromAssignments(assignments) {
  const ranges = [];
  let start = 0;
  let current = assignments[0] ?? 0;
  for (let i = 1; i < assignments.length; i += 1) {
    if (assignments[i] !== current) {
      ranges.push({ start, end: i - 1 });
      start = i;
      current = assignments[i];
    }
  }
  ranges.push({ start, end: assignments.length - 1 });
  return ranges;
}

function heuristicRanges(units) {
  const ranges = [];
  let start = 0;
  for (let i = 0; i < units.length; i += 1) {
    if (i !== start && units[i].type === "heading") {
      ranges.push({ start, end: i - 1 });
      start = i;
    }
  }
  ranges.push({ start, end: units.length - 1 });
  return ranges;
}

function rebalanceRanges(ranges, targetCount, unitCount, notes) {
  let balanced = ranges.slice();
  while (balanced.length > targetCount) {
    let smallestIndex = 0;
    let smallestSize = rangeSize(balanced[0]);
    for (let i = 1; i < balanced.length; i += 1) {
      const size = rangeSize(balanced[i]);
      if (size < smallestSize) {
        smallestSize = size;
        smallestIndex = i;
      }
    }
    const mergeIndex = smallestIndex === 0 ? 0 : smallestIndex - 1;
    const merged = {
      start: balanced[mergeIndex].start,
      end: balanced[mergeIndex + 1].end,
    };
    balanced.splice(mergeIndex, 2, merged);
  }

  while (balanced.length < targetCount) {
    let largestIndex = 0;
    let largestSize = rangeSize(balanced[0]);
    for (let i = 1; i < balanced.length; i += 1) {
      const size = rangeSize(balanced[i]);
      if (size > largestSize) {
        largestSize = size;
        largestIndex = i;
      }
    }
    if (largestSize < 2) {
      notes.push("Unable to split further to reach target chunk count.");
      break;
    }
    const range = balanced[largestIndex];
    const mid = range.start + Math.floor(largestSize / 2) - 1;
    const left = { start: range.start, end: mid };
    const right = { start: mid + 1, end: range.end };
    balanced.splice(largestIndex, 1, left, right);
  }

  if (balanced.length === 0 && unitCount > 0) {
    balanced = [{ start: 0, end: unitCount - 1 }];
  }

  return balanced;
}

function rangeSize(range) {
  return range.end - range.start + 1;
}

function buildChunks(units, ranges) {
  return ranges.map((range, idx) => {
    const chunkUnits = units.slice(range.start, range.end + 1);
    const text = chunkUnits.map((unit) => unit.text).join("\n\n");
    const title = deriveTitle(chunkUnits, text);
    return {
      id: idx,
      title,
      unit_start: range.start,
      unit_end: range.end,
      start_char: chunkUnits[0].startChar,
      end_char: chunkUnits[chunkUnits.length - 1].endChar,
      text,
      sha256: sha256(text),
    };
  });
}

function buildUnitMap(ranges, unitCount) {
  const map = new Array(unitCount).fill(0);
  ranges.forEach((range, idx) => {
    for (let i = range.start; i <= range.end; i += 1) {
      map[i] = idx;
    }
  });
  return map;
}

function deriveTitle(units, fallback) {
  const heading = units.find((unit) => unit.type === "heading");
  if (heading) {
    return heading.normalized.slice(0, 120);
  }
  return normalizeWhitespace(fallback).slice(0, 120);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function createExcerpt(text, headSize, tailSize) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= headSize + tailSize + 10) {
    return normalized;
  }
  const head = normalized.slice(0, headSize);
  const tail = normalized.slice(-tailSize);
  return `${head} … ${tail}`;
}

function takeDescriptorBatch(
  descriptors,
  startIndex,
  maxCount,
  maxPromptChars,
) {
  const batch = [];
  let totalChars = 0;
  for (let i = startIndex; i < descriptors.length; i += 1) {
    const descriptor = descriptors[i];
    const size = descriptor.excerpt.length + 30;
    if (batch.length >= maxCount || totalChars + size > maxPromptChars) {
      break;
    }
    batch.push({ ...descriptor, index: i });
    totalChars += size;
  }
  return batch;
}
