// skrypt/llm/semaforOllama.js
import { performance } from 'node:perf_hooks';

const MAX_CONCURRENT = Number(process.env.OLLAMA_MAX_CONCURRENT || 1);

let current = 0;
/** @type {{ resolve: (waitMs:number)=>void, enqueuedAt:number }[]} */
const queue = [];

function acquire() {
  // dostęp od razu
  if (current < MAX_CONCURRENT) {
    current += 1;
    return Promise.resolve(0); // waitMs = 0
  }

  // kolejka
  const enqueuedAt = performance.now();
  return new Promise((resolve) => {
    queue.push({
      enqueuedAt,
      resolve: (waitMs) => resolve(waitMs),
    });
  });
}

function release() {
  // jeśli ktoś czeka w kolejce, wpuszczamy następnego
  if (queue.length > 0) {
    const next = queue.shift();
    const waitMs = Math.round(performance.now() - next.enqueuedAt);
    // current zostaje bez zmian (zwalniamy 1 i natychmiast zajmuje go następny)
    next.resolve(waitMs);
    return;
  }

  // nikt nie czeka — realnie zmniejszamy licznik
  current = Math.max(0, current - 1);
}

/**
 * Uruchamia fn w semaforze (max równoległych = MAX_CONCURRENT)
 * Opcjonalnie loguje czas oczekiwania w kolejce.
 *
 * @param {Function} fn
 * @param {{ logger?: Console, label?: string, logWaitEveryMs?: number }} [opts]
 */
export async function withOllamaSemaphore(fn, opts = {}) {
  const log = opts.logger || console;
  const label = opts.label || 'ollama';
  const logWaitEveryMs = Number(opts.logWaitEveryMs || 1); // loguj jeśli waitMs >= 1ms

  const waitMs = await acquire();

  // Loguj tylko jak faktycznie było czekanie (żeby nie spamować)
  if (waitMs >= logWaitEveryMs) {
    log.info('ollama_semaphore_wait', {
      label,
      waitMs,
      current,
      queueLen: queue.length,
      maxConcurrent: MAX_CONCURRENT,
    });
  }

  try {
    return await fn();
  } finally {
    release();
  }
}

// (opcjonalnie) do debugowania w razie potrzeby
export function getOllamaSemaphoreState() {
  return { current, queueLen: queue.length, maxConcurrent: MAX_CONCURRENT };
}

