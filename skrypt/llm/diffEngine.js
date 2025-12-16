// skrypt/llm/diffEngine.js
import { mongoClient } from '../polaczenieMDB.js';
import { performance } from 'node:perf_hooks';
const db = mongoClient.db(process.env.MONGO_DB || 'inzynierka');
const snapshotsCol = db.collection('snapshots');
const analizyCol = db.collection('analizy');

// Znajdź poprzedni snapshot tego samego monitora (starszy po ts)
export async function getPreviousSnapshot(currentSnapshot, { logger } = {}) {
  if (!currentSnapshot) return null;

  const log = logger || console;
  const t0 = performance.now();

  const query = {
    monitor_id: currentSnapshot.monitor_id,
    ts: { $lt: currentSnapshot.ts },
  };

  const prev = await snapshotsCol
    .find(query)
    .sort({ ts: -1 })
    .limit(1)
    .next();

  const durationMs = Math.round(performance.now() - t0);

  // nie spamuj: loguj tylko jak trwało "długo"
  if (durationMs >= 20) {
    log.info('diff_prev_snapshot_done', {
      monitorId: String(currentSnapshot.monitor_id || ''),
      snapshotId: currentSnapshot?._id?.toString?.() || null,
      durationMs,
      found: !!prev,
    });
  }

  return prev || null;
}


// Bardzo prosty score różnicy tekstu (0 = identyczny, 1 = zupełnie inny)
function simpleTextDiffScore(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 1;
  if (a === b) return 0;

  const aWords = new Set(a.split(/\s+/).filter(Boolean));
  const bWords = new Set(b.split(/\s+/).filter(Boolean));

  if (aWords.size === 0 && bWords.size === 0) return 0;

  let intersection = 0;
  for (const w of aWords) {
    if (bWords.has(w)) intersection += 1;
  }

  const union = new Set([...aWords, ...bWords]).size;
  if (union === 0) return 0;

  // im większa różnica, tym bliżej 1
  return 1 - intersection / union;
}

export async function computeMachineDiff(prevSnapshot, newSnapshot, { logger } = {}) {
  if (!prevSnapshot) {
    return {
      hasAnyChange: false,
      hasSignificantMachineChange: false,
      reasons: ['brak poprzedniego snapshotu'],
      metrics: {},
      prevSnapshotId: null,
      newSnapshotId: newSnapshot?._id ?? null,
    };
  }

  const log = logger || console;
  const t0 = performance.now();

  const prev = prevSnapshot.extracted_v2 || {};
  const now = newSnapshot.extracted_v2 || {};

  const reasons = [];
  const metrics = {};

  const prevPluginPrices = Array.isArray(prevSnapshot.plugin_prices)
    ? prevSnapshot.plugin_prices
    : [];
  const nowPluginPrices = Array.isArray(newSnapshot.plugin_prices)
    ? newSnapshot.plugin_prices
    : [];

  if (JSON.stringify(prevPluginPrices) !== JSON.stringify(nowPluginPrices)) {
    metrics.pluginPricesChanged = true;
    reasons.push('zmiana cen z pluginu');
  } else {
    metrics.pluginPricesChanged = false;
  }

  if (prev.price && now.price) {
    const oldVal = prev.price.value;
    const newVal = now.price.value;

    if (typeof oldVal === 'number' && typeof newVal === 'number') {
      const absChange = newVal - oldVal;
      const relChange = oldVal !== 0 ? absChange / oldVal : null;

      metrics.price = { oldVal, newVal, absChange, relChange };

      if (absChange !== 0) {
        reasons.push(
          `zmiana ceny z ${oldVal} na ${newVal} (Δ=${absChange}, rel=${relChange})`,
        );
      }
    }
  }

  if (prev.title !== now.title) {
    metrics.titleChanged = true;
    reasons.push('zmiana tytułu strony');
  } else {
    metrics.titleChanged = false;
  }

  if (prev.description !== now.description) {
    metrics.descriptionChanged = true;
    reasons.push('zmiana opisu strony');
  } else {
    metrics.descriptionChanged = false;
  }

  const prevText = prev.text || '';
  const nowText = now.text || '';
  const textDiffScore = simpleTextDiffScore(prevText, nowText);
  metrics.textDiffScore = textDiffScore;

  if (textDiffScore > 0.05) {
    reasons.push(`zmiana treści strony (score ~${textDiffScore.toFixed(3)})`);
  }

  const prevImages = (prev.images || []).length;
  const nowImages = (now.images || []).length;
  metrics.imagesCount = { prev: prevImages, now: nowImages };

  if (prevImages !== nowImages) {
    reasons.push('zmieniła się liczba obrazów / ofert');
  }

  const hasAnyChange = reasons.length > 0;

  let hasSignificantMachineChange = false;

  if (metrics.price && metrics.price.relChange != null) {
    if (Math.abs(metrics.price.relChange) >= 0.05) {
      hasSignificantMachineChange = true;
    }
  }

  if (textDiffScore > 0.15) {
    hasSignificantMachineChange = true;
  }

  if (metrics.pluginPricesChanged) {
    hasSignificantMachineChange = true;
  }

  const durationMs = Math.round(performance.now() - t0);
  if (durationMs >= 10) {
    log.info('diff_compute_done', {
      prevSnapshotId: prevSnapshot?._id?.toString?.() || null,
      newSnapshotId: newSnapshot?._id?.toString?.() || null,
      durationMs,
      hasAnyChange,
      hasSignificantMachineChange,
    });
  }

  return {
    hasAnyChange,
    hasSignificantMachineChange,
    reasons,
    metrics,
    prevSnapshotId: prevSnapshot._id,
    newSnapshotId: newSnapshot._id,
  };
}


export async function getSnapshotAnalysis(snapshotId, { logger } = {}) {
  const log = logger || console;
  const t0 = performance.now();

  const doc = await analizyCol.findOne({
    snapshot_id: snapshotId,
    type: 'snapshot',
  });

  const durationMs = Math.round(performance.now() - t0);
  if (durationMs >= 20) {
    log.info('diff_get_analysis_done', {
      snapshotId: snapshotId?.toString?.() || String(snapshotId),
      durationMs,
      found: !!doc,
    });
  }

  return doc;
}

