// background.js
// FULLPAGE screenshot (scroll + stitch) z poprawkami:
// - zapisuje REALNE scrollY (actualY) po scrollu
// - zawsze dobija do maxScrollY
// - docina canvas do realnie złapanego dołu (maxBottomCss)
// - wypełnia białe tło (JPEG nie ma alpha -> nie będzie czarnego)
// - anti-gap: koryguje destY w device px, żeby nie robić dziur przez rounding/DPR
// + DODATKOWO:
// - retry+focus gdy captureVisibleTab zwraca null
// - waitTwoRafs po scrollu (anti “puste/ciemne” klatki)
// - próba auto-kliknięcia banera cookies (Allegro i podobne)

import { BACKEND_BASE_URL, POLL_INTERVAL_SECONDS, AUTH_TOKEN } from './config.js';

const MAX_CONCURRENT_TASKS = 2;
const taskQueue = [];
let inFlightCount = 0;
let isPolling = false;

async function apiFetch(path, options = {}) {
  const url = `${BACKEND_BASE_URL}${path}`;
  const headers = options.headers || {};
  if (AUTH_TOKEN) {
    headers.Authorization = AUTH_TOKEN;
  }
  return fetch(url, { ...options, headers });
}

async function fetchNextPluginTask() {
  try {
    const res = await apiFetch('/api/plugin-tasks/next', { method: 'GET' });

    if (res.status === 204) return null;
    if (!res.ok) {
      console.warn('[plugin] fetchNextPluginTask non-OK', res.status);
      return null;
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      console.warn('[plugin] fetchNextPluginTask json parse error', e);
      return null;
    }

    if (!data || !data.url || !data.task_id) return null;
    return data;
  } catch (err) {
    console.error('[plugin] fetchNextPluginTask error', err);
    return null;
  }
}

// ===== DOM extractor do backendu (HTML + tekst) =====
function extractDomForBackend() {
  try {
    const htmlEl = document.documentElement;
    const body = document.body;

    const html = htmlEl ? htmlEl.outerHTML : null;
    const text = body ? body.innerText : null;

    return {
      html,
      text,
      finalUrl: window.location.href,
    };
  } catch (e) {
    return {
      html: null,
      text: null,
      finalUrl: window.location.href,
    };
  }
}

// ===== Utils =====
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wykonywane w kontekście strony: poczekaj na 2 klatki renderu (anti “puste/ciemne” klatki)
function waitTwoRafsInPage() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

// W kontekście strony: spróbuj kliknąć cookies
function tryAcceptCookies() {
  const targets = [
    'ok, zgadzam się',
    'zgadzam się',
    'akceptuj',
    'zaakceptuj',
    'accept',
    'agree',
    'i agree',
    'allow all',
    'accept all',
  ];

  const nodes = Array.from(
    document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'),
  );

  for (const n of nodes) {
    const t = (n.innerText || n.value || '').trim().toLowerCase();
    if (!t) continue;
    if (targets.some((x) => t.includes(x))) {
      try {
        n.click();
        return { clicked: true, text: t };
      } catch {
        // ignore
      }
    }
  }

  return { clicked: false };
}

// Zwraca metryki potrzebne do fullpage screena (w CSS px)
function getPageMetrics() {
  const doc = document.documentElement;
  const body = document.body;

  const totalWidth = Math.max(
    doc?.scrollWidth || 0,
    body?.scrollWidth || 0,
    doc?.clientWidth || 0,
  );

  const totalHeight = Math.max(
    doc?.scrollHeight || 0,
    body?.scrollHeight || 0,
    doc?.clientHeight || 0,
  );

  const viewportWidth = window.innerWidth || doc?.clientWidth || 0;
  const viewportHeight = window.innerHeight || doc?.clientHeight || 0;

  return {
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    totalWidth,
    totalHeight,
    viewportWidth,
    viewportHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    url: window.location.href,
  };
}

function scrollToY(y) {
  window.scrollTo(0, y);
  const doc = document.documentElement;
  const body = document.body;
  const totalHeight = Math.max(
    doc?.scrollHeight || 0,
    body?.scrollHeight || 0,
    doc?.clientHeight || 0,
  );
  const viewportHeight = window.innerHeight || doc?.clientHeight || 0;
  const maxScrollY = Math.max(0, totalHeight - viewportHeight);

  return {
    ok: true,
    y: window.scrollY || 0,
    maxScrollY,
  };
}

// Wykonuje screenshot aktywnej zakładki w danym oknie.
function captureVisibleTabDataUrl(windowId, { format = 'jpeg', quality = 90 } = {}) {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(
      windowId,
      format === 'jpeg' ? { format: 'jpeg', quality } : { format: 'png' },
      (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          resolve(null);
          return;
        }
        resolve(dataUrl);
      },
    );
  });
}

async function focusAndActivate(windowId, tabId) {
  await new Promise((r) => chrome.windows.update(windowId, { focused: true }, () => r()));
  await new Promise((r) => chrome.tabs.update(tabId, { active: true }, () => r()));
  await sleep(150);
}

async function captureVisibleTabDataUrlWithRetry(windowId, tabId, opts) {
  let shot = await captureVisibleTabDataUrl(windowId, opts);
  if (shot) return shot;

  await focusAndActivate(windowId, tabId);
  shot = await captureVisibleTabDataUrl(windowId, opts);
  if (shot) return shot;

  await sleep(250);
  shot = await captureVisibleTabDataUrl(windowId, opts);
  return shot;
}

async function dataUrlToImageBitmap(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  const mime = blob.type || 'application/octet-stream';
  return `data:${mime};base64,${base64}`;
}

/**
 * Full-page screenshot: scroll + captureVisibleTab + stitch na OffscreenCanvas.
 * Poprawki na "czarne tło":
 * - canvas docinany do realnie złapanego dołu (maxBottomCss)
 * - białe tło w canvasie (JPEG)
 * - anti-gap przy destY (clamp do poprzedniej klatki)
 * Dodatkowo:
 * - waitTwoRafs po scrollu (anti “puste/ciemne” klatki)
 * - retry+focus gdy captureVisibleTab zwróci null
 */
async function captureFullPageScreenshotDataUrl(windowId, tabId, { format = 'jpeg', quality = 90 } = {}) {
  // 1) pobierz metryki
  const [mRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: getPageMetrics,
  });

  const m = (mRes && mRes.result) || null;
  if (!m || !m.viewportHeight || !m.totalHeight) {
    return await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format, quality });
  }

  // limity bezpieczeństwa (żeby nie wywalić pamięci)
  const dpr = Math.max(1, Math.min(3, Number(m.devicePixelRatio) || 1));
  const estW = Math.round(m.viewportWidth * dpr);
  const estH = Math.round(m.totalHeight * dpr);
  const estPixels = estW * estH;

  const MAX_PIXELS = 35_000_000;
  if (!Number.isFinite(estPixels) || estPixels > MAX_PIXELS) {
    console.warn('[plugin] fullpage too large, fallback to visible', {
      estW,
      estH,
      estPixels,
      totalHeight: m.totalHeight,
      viewportHeight: m.viewportHeight,
      dpr,
    });
    return await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format, quality });
  }

  const originalY = m.scrollY || 0;

  // 2) listę pozycji scrolla (CSS px)
  const step = Math.max(1, m.viewportHeight);
  const maxScrollY = Math.max(0, m.totalHeight - m.viewportHeight);

  const positions = [];
  for (let y = 0; y <= maxScrollY; y += step) {
    positions.push(y);
    if (positions.length >= 60) break; // limit
  }
  // zawsze dobij do końca
  if (positions.length && positions[positions.length - 1] !== maxScrollY) {
    positions.push(maxScrollY);
  }

  // 3) przejedź stronę i zbierz viewporty
  const shots = [];
  let lastActualY = -1;

  for (const requestedY of positions) {
    const [scrollRes] = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrollToY,
      args: [requestedY],
    });

    const actualY = scrollRes?.result?.y ?? requestedY;

    // brak postępu => jesteś na dole / scroll clamp -> kończ
    if (actualY === lastActualY && shots.length > 0) break;

    // poczekaj aż strona się dorysuje po scrollu
    await chrome.scripting.executeScript({
      target: { tabId },
      func: waitTwoRafsInPage,
    });
    await sleep(550);

    const shot = await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format, quality });
    if (!shot) {
      console.warn('[plugin] captureVisibleTab returned null during fullpage');
      break;
    }

    shots.push({ y: actualY, dataUrl: shot });
    lastActualY = actualY;
  }

  // 4) przywróć scroll
  await chrome.scripting.executeScript({
    target: { tabId },
    func: scrollToY,
    args: [originalY],
  });

  if (shots.length <= 1) {
    return shots[0]?.dataUrl || (await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format, quality }));
  }

  // 5) stitch
  const firstBitmap = await dataUrlToImageBitmap(shots[0].dataUrl);
  const canvasWidth = firstBitmap.width;

  // REALNY dół na podstawie złapanych klatek
  const maxBottomCss = Math.max(...shots.map((s) => (Number(s.y) || 0) + m.viewportHeight));
  const effectiveCssHeight = Math.min(m.totalHeight, maxBottomCss);
  const canvasHeight = Math.max(1, Math.round(effectiveCssHeight * dpr));

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    console.warn('[plugin] OffscreenCanvas 2d ctx missing, fallback to visible');
    return await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format, quality });
  }

  // JPEG nie ma alpha -> wypełnij tło na biało (usuwa "czarne")
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Anti-gap: pilnujemy, by destY nie zostawiał dziur między kaflami
  let lastDestYDev = 0;
  let lastBitmapH = firstBitmap.height;

  // pierwsza klatka
  ctx.drawImage(firstBitmap, 0, 0);

  for (let i = 1; i < shots.length; i++) {
    const bm = await dataUrlToImageBitmap(shots[i].dataUrl);

    let destYDev = Math.round((Number(shots[i].y) || 0) * dpr);

    // Jeśli destY wskazuje "za nisko" (powstałaby dziura) -> dociśnij do końca poprzedniej bitmapy
    const expectedMin = lastDestYDev + lastBitmapH;
    if (destYDev > expectedMin) destYDev = expectedMin;

    // Jeśli cofnięcie (rzadkie) -> ignoruj
    if (destYDev < lastDestYDev) continue;

    // Jeśli bitmapa wychodzi poza canvas -> docięcie do dołu
    const remaining = canvasHeight - destYDev;
    if (remaining <= 0) continue;

    if (bm.height > remaining) {
      ctx.drawImage(
        bm,
        0, 0, bm.width, remaining,
        0, destYDev, bm.width, remaining,
      );
      lastDestYDev = destYDev;
      lastBitmapH = remaining;
    } else {
      ctx.drawImage(bm, 0, destYDev);
      lastDestYDev = destYDev;
      lastBitmapH = bm.height;
    }
  }

  // 6) export do dataURL
  let blob;
  if (format === 'png') {
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: Math.max(0.1, Math.min(1, quality / 100)),
    });
  }

  return await blobToDataUrl(blob);
}

// ===== Fallback: screenshot =====

async function sendPluginScreenshotResult({ task_id, monitor_id, zadanie_id, screenshotDataUrl, url }) {
  try {
    const base64 = screenshotDataUrl.split(',')[1] || screenshotDataUrl;

    const res = await apiFetch(`/api/plugin-tasks/${encodeURIComponent(task_id)}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monitor_id,
        zadanie_id,
        screenshot_b64: base64,
        url: url || null,
      }),
    });

    if (!res.ok) {
      console.warn('[plugin] sendPluginScreenshotResult non-OK', res.status);
    } else {
      console.log('[plugin] sendPluginScreenshotResult OK');
    }
  } catch (err) {
    console.error('[plugin] sendPluginScreenshotResult error', err);
  }
}

async function sendPluginScreenshotOnly({ task_id, monitor_id, zadanie_id, screenshotDataUrl, url }) {
  try {
    const base64 = screenshotDataUrl.split(',')[1] || screenshotDataUrl;
    const res = await apiFetch(`/api/plugin-tasks/${encodeURIComponent(task_id)}/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monitor_id,
        zadanie_id,
        screenshot_b64: base64,
        url: url || null,
      }),
    });

    if (!res.ok) {
      console.warn('[plugin] sendPluginScreenshotOnly non-OK', res.status);
    } else {
      console.log('[plugin] sendPluginScreenshotOnly OK');
    }
  } catch (err) {
    console.error('[plugin] sendPluginScreenshotOnly error', err);
  }
}

// ===== Fallback: DOM (plus opcjonalny screenshot) =====

async function sendPluginDomResult({
  task_id,
  monitor_id,
  zadanie_id,
  url,
  html,
  text,
}) {
  try {
    const body = {
      monitor_id,
      zadanie_id,
      url: url || null,
    };

    if (typeof html === 'string') body.html = html;
    if (typeof text === 'string') body.text = text;

    const res = await apiFetch(
      `/api/plugin-tasks/${encodeURIComponent(task_id)}/result`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      console.warn('[plugin] sendPluginDomResult non-OK', res.status);
    } else {
      console.log('[plugin] sendPluginDomResult OK');
    }
  } catch (err) {
    console.error('[plugin] sendPluginDomResult error', err);
  }
}

async function captureBestEffortScreenshot(windowId, tabId) {
  const capture = (focused) => new Promise((resolve) => {
    const doCap = async () => {
      const shot = await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format: 'jpeg', quality: 90 });
      resolve(shot);
    };

    if (focused) {
      chrome.windows.update(windowId, { focused: true }, () => {
        chrome.tabs.update(tabId, { active: true }, () => doCap());
      });
    } else {
      chrome.tabs.update(tabId, { active: true }, () => doCap());
    }
  });

  let shot = await capture(false);
  if (shot) return shot;
  shot = await capture(true);
  return shot;
}

async function captureBestEffortFullPageScreenshot(windowId, tabId) {
  const tryCap = async (focused) => {
    if (focused) {
      await focusAndActivate(windowId, tabId);
    } else {
      await new Promise((r) => chrome.tabs.update(tabId, { active: true }, () => r()));
    }

    try {
      return await captureFullPageScreenshotDataUrl(windowId, tabId, { format: 'jpeg', quality: 90 });
    } catch (e) {
      console.warn('[plugin] fullpage capture error', e);
      return null;
    }
  };

  let shot = await tryCap(false);
  if (shot) return shot;

  shot = await tryCap(true);
  if (shot) return shot;

  return await captureBestEffortScreenshot(windowId, tabId);
}

function openWindowForTask(task) {
  return new Promise((resolve, reject) => {
    chrome.windows.create(
      {
        url: task.url,
        state: 'normal',
        focused: false,
      },
      (win) => {
        if (chrome.runtime.lastError || !win || !win.tabs || !win.tabs.length) {
          console.error('[plugin] windows.create error', chrome.runtime.lastError);
          reject(chrome.runtime.lastError || new Error('windows.create failed'));
        } else {
          const tab = win.tabs[0];
          resolve({ windowId: win.id, tabId: tab.id });
        }
      },
    );
  });
}

function waitForLoadAndScreenshot(windowId, tabId, task) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);

        setTimeout(async () => {
          try {
            const [result] = await chrome.scripting.executeScript({
              target: { tabId },
              func: extractDomForBackend,
            });

            const payload = (result && result.result) || {};
            const html = payload?.html || null;
            const text = payload?.text || null;
            const finalUrl = payload?.finalUrl || tab.url;

            if (html || text) {
              console.log('[plugin] DOM extracted, sending to backend (DOM only)...');

              await sendPluginDomResult({
                task_id: task.task_id,
                monitor_id: task.monitor_id,
                zadanie_id: task.zadanie_id,
                url: finalUrl,
                html,
                text,
              });

              chrome.windows.remove(windowId, () => {
                if (chrome.runtime.lastError) {
                  console.warn('[plugin] windows.remove error', chrome.runtime.lastError);
                }
              });

              resolve(true);
              return;
            }

            console.warn('[plugin] DOM empty/undefined – robimy FULLPAGE screenshot jako fallback...');

            // spróbuj kliknąć cookies zanim zaczniemy stitchować
            await chrome.scripting.executeScript({
              target: { tabId },
              func: tryAcceptCookies,
            });
            await sleep(500);

            const dataUrl = await captureBestEffortFullPageScreenshot(windowId, tabId);
            if (!dataUrl) {
              console.warn('[plugin] fullpage screenshot fallback: capture failed');
              resolve(false);
              return;
            }

            await sendPluginScreenshotOnly({
              task_id: task.task_id,
              monitor_id: task.monitor_id,
              zadanie_id: task.zadanie_id,
              screenshotDataUrl: dataUrl,
              url: finalUrl,
            });

            chrome.windows.remove(windowId, () => {
              if (chrome.runtime.lastError) {
                console.warn('[plugin] windows.remove error', chrome.runtime.lastError);
              }
            });

            resolve(true);
          } catch (err) {
            console.error('[plugin] waitForLoadAndScreenshot error', err);
            resolve(false);
          }
        }, 3000);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ===== Price only: wyciąganie cen z DOM =====

async function sendPluginPriceResult({
  task_id,
  monitor_id,
  zadanie_id,
  url,
  prices,
}) {
  try {
    const body = {
      monitor_id: monitor_id,
      zadanie_id: zadanie_id,
      url: url || null,
      prices,
    };

    const res = await apiFetch(`/api/plugin-tasks/${encodeURIComponent(task_id)}/price`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.warn('[plugin] sendPluginPriceResult non-OK', res.status);
    } else {
      console.log('[plugin] sendPluginPriceResult OK');
    }
  } catch (err) {
    console.error('[plugin] sendPluginPriceResult error', err);
  }
}

function extractPricesFromDom() {
  const currencyRegex = /(zł|pln|eur|€|usd|\$)/i;
  const digitRegex = /\d/;

  const candidates = [];
  const elements = Array.from(document.querySelectorAll('body *'));

  for (const el of elements) {
    const text = (el.innerText || el.textContent || '').trim();
    if (!text) continue;
    if (!currencyRegex.test(text)) continue;
    if (!digitRegex.test(text)) continue;
    if (text.length > 100) continue;

    candidates.push(text.replace(/\s+/g, ' ').trim());
  }

  const unique = Array.from(new Set(candidates));
  return unique.slice(0, 50);
}

function waitForLoadAndExtractPrices(windowId, tabId, task) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);

        setTimeout(async () => {
          try {
            const [result] = await chrome.scripting.executeScript({
              target: { tabId },
              func: extractPricesFromDom,
            });

            const prices = (result && result.result) || [];
            console.log('[plugin] extracted prices:', prices);

            await sendPluginPriceResult({
              task_id: task.task_id,
              monitor_id: task.monitor_id,
              zadanie_id: task.zadanie_id,
              url: tab.url,
              prices,
            });

            chrome.windows.remove(windowId, () => {
              if (chrome.runtime.lastError) {
                console.warn('[plugin] windows.remove error', chrome.runtime.lastError);
              }
            });

            resolve(true);
          } catch (err) {
            console.error('[plugin] waitForLoadAndExtractPrices error', err);
            resolve(false);
          }
        }, 3000);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ===== Dispatcher: wybór trybu =====
function waitForLoadAndSendScreenshot(windowId, tabId, task) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);

        setTimeout(async () => {
          try {
            // spróbuj kliknąć cookies zanim zaczniemy stitchować
            await chrome.scripting.executeScript({
              target: { tabId },
              func: tryAcceptCookies,
            });
            await sleep(500);

            const screenshotDataUrl = await captureBestEffortFullPageScreenshot(windowId, tabId);
            if (!screenshotDataUrl) {
              console.warn('[plugin] screenshot_only: capture failed');
              resolve(false);
              return;
            }

            await sendPluginScreenshotOnly({
              task_id: task.task_id,
              monitor_id: task.monitor_id,
              zadanie_id: task.zadanie_id,
              screenshotDataUrl,
              url: tab.url,
            });

            chrome.windows.remove(windowId, () => {
              if (chrome.runtime.lastError) {
                console.warn('[plugin] windows.remove error', chrome.runtime.lastError);
              }
            });

            resolve(true);
          } catch (err) {
            console.error('[plugin] waitForLoadAndSendScreenshot error', err);
            resolve(false);
          }
        }, 2500);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function processTask(task) {
  console.log('[plugin] got task', task);
  const startTime = performance.now();
  console.log('[plugin] task_started', { task_id: task.task_id, started_at: new Date().toISOString() });

  try {
    const { windowId, tabId } = await openWindowForTask(task);

    if (task.mode === 'price_only') {
      const ok = await waitForLoadAndExtractPrices(windowId, tabId, task);
      console.log('[plugin] price_only task done ok=', ok);
    } else if (task.mode === 'screenshot' || task.mode === 'plugin_screenshot') {
      const ok = await waitForLoadAndSendScreenshot(windowId, tabId, task);
      console.log('[plugin] screenshot task done ok=', ok);
    } else {
      const ok = await waitForLoadAndScreenshot(windowId, tabId, task);
      console.log('[plugin] fallback task done ok=', ok);
    }
  } catch (err) {
    console.error('[plugin] processTask error', err);
  } finally {
    const durationMs = Math.round(performance.now() - startTime);
    console.log('[plugin] task_finished', {
      task_id: task.task_id,
      duration_ms: durationMs,
      finished_at: new Date().toISOString(),
    });
  }
}

function drainQueue() {
  while (inFlightCount < MAX_CONCURRENT_TASKS && taskQueue.length > 0) {
    const nextTask = taskQueue.shift();
    if (!nextTask) continue;
    inFlightCount += 1;
    processTask(nextTask)
      .catch((err) => console.error('[plugin] task error', err))
      .finally(() => {
        inFlightCount = Math.max(0, inFlightCount - 1);
        drainQueue();
        pollForTasks().catch((err) => console.error('[plugin] pollForTasks error', err));
      });
  }
}

async function pollForTasks() {
  if (isPolling) return;
  if (inFlightCount >= MAX_CONCURRENT_TASKS && taskQueue.length === 0) return;
  isPolling = true;

  try {
    while (inFlightCount + taskQueue.length < MAX_CONCURRENT_TASKS) {
      const task = await fetchNextPluginTask();
      if (!task) break;
      taskQueue.push(task);
    }
  } catch (err) {
    console.error('[plugin] pollForTasks error', err);
  } finally {
    isPolling = false;
    drainQueue();
  }
}

// alarm – automatyczne pytanie o zadania
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('pollPluginTasks', {
    periodInMinutes: POLL_INTERVAL_SECONDS / 60,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollPluginTasks') {
    pollForTasks().catch((err) => console.error('[plugin] pollForTasks alarm error', err));
  }
});

// klik w ikonę – ręczne odpalenie (debug)
chrome.action.onClicked.addListener(() => {
  pollForTasks().catch((err) => console.error('[plugin] pollForTasks click error', err));
});
