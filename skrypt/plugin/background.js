// background.js (screenshot-only)
// Zadanie pluginu: otworzyć URL, zrobić fullpage screenshot (scroll + stitch) i wysłać do backendu.

import { BACKEND_BASE_URL, POLL_INTERVAL_SECONDS, AUTH_TOKEN } from './config.js';

const MAX_CONCURRENT_TASKS = 2;
const taskQueue = [];
let inFlightCount = 0;
let isPolling = false;

async function apiFetch(path, options = {}) {
  const url = `${BACKEND_BASE_URL}${path}`;
  const headers = options.headers || {};
  if (AUTH_TOKEN) headers.Authorization = AUTH_TOKEN;
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

    const data = await res.json().catch(() => null);
    if (!data || !data.url || !data.task_id) return null;

    const normId = (v) => {
      const s = String(v ?? '').trim();
      return s.length ? s : null;
    };

    return {
      task_id: normId(data.task_id ?? data.taskId ?? data.id),
      monitor_id: normId(data.monitor_id ?? data.monitorId),
      zadanie_id: normId(data.zadanie_id ?? data.zadanieId),
      url: data.url,
    };
  } catch (err) {
    console.error('[plugin] fetchNextPluginTask error', err);
    return null;
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

// W kontekście strony: spróbuj kliknąć cookies (żeby overlay nie zasłaniał treści na screenie)
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

  const totalWidth = Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0, doc?.clientWidth || 0);
  const totalHeight = Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0, doc?.clientHeight || 0);

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

async function scrollToYAndWait(y) {
  const doc = document.documentElement;
  const body = document.body;

  // wymuś brak smooth scroll
  const prevDocSB = doc?.style?.scrollBehavior;
  const prevBodySB = body?.style?.scrollBehavior;
  try {
    if (doc?.style) doc.style.scrollBehavior = 'auto';
    if (body?.style) body.style.scrollBehavior = 'auto';
  } catch {
    // ignore
  }

  try {
    window.scrollTo({ top: y, left: 0, behavior: 'auto' });
  } catch {
    window.scrollTo(0, y);
  }

  // poczekaj aż scroll się ustabilizuje (lub timeout)
  let lastY = -1;
  let stableFrames = 0;
  const t0 = performance.now();

  while (performance.now() - t0 < 1500) {
    await new Promise((r) => requestAnimationFrame(r));
    const curY = window.scrollY || 0;

    if (curY === lastY) {
      stableFrames += 1;
      if (stableFrames >= 2) break;
    } else {
      stableFrames = 0;
      lastY = curY;
    }
  }

  // przywróć style
  try {
    if (doc?.style) doc.style.scrollBehavior = prevDocSB ?? '';
    if (body?.style) body.style.scrollBehavior = prevBodySB ?? '';
  } catch {
    // ignore
  }

  const totalHeight = Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0, doc?.clientHeight || 0);
  const viewportHeight = window.innerHeight || doc?.clientHeight || 0;
  const maxScrollY = Math.max(0, totalHeight - viewportHeight);

  return { ok: true, y: window.scrollY || 0, maxScrollY };
}

// Wykonuje screenshot aktywnej zakładki w danym oknie.
function captureVisibleTabDataUrl(windowId, { format = 'jpeg', quality = 90 } = {}) {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(
      windowId,
      format === 'jpeg' ? { format: 'jpeg', quality } : { format: 'png' },
      (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) return resolve(null);
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
  return await captureVisibleTabDataUrl(windowId, opts);
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
 * Full-page screenshot: scroll + captureVisibleTab + stitch (OffscreenCanvas).
 * - anti “puste/ciemne” klatki (2 RAFy + sleep)
 * - retry+focus gdy captureVisibleTab zwróci null
 * - białe tło dla JPEG
 * - docinanie canvas do realnie złapanego dołu
 */
async function captureFullPageScreenshotDataUrl(windowId, tabId, { format = 'jpeg', quality = 90 } = {}) {
  const [mRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: getPageMetrics,
  });

  const m = (mRes && mRes.result) || null;
  if (!m || !m.viewportHeight || !m.totalHeight) {
    return await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format, quality });
  }

  const dpr = Math.max(1, Math.min(3, Number(m.devicePixelRatio) || 1));
  const estW = Math.round(m.viewportWidth * dpr);
  const estH = Math.round(m.totalHeight * dpr);
  const estPixels = estW * estH;

  const MAX_PIXELS = 35_000_000;
  if (!Number.isFinite(estPixels) || estPixels > MAX_PIXELS) {
    console.warn('[plugin] fullpage too large, fallback to visible', { estW, estH, estPixels });
    return await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format, quality });
  }

  const originalY = m.scrollY || 0;

  const step = Math.max(1, m.viewportHeight);
  const maxScrollY = Math.max(0, m.totalHeight - m.viewportHeight);

  const positions = [];
  for (let y = 0; y <= maxScrollY; y += step) {
    positions.push(y);
    if (positions.length >= 60) break;
  }
  if (positions.length && positions[positions.length - 1] !== maxScrollY) positions.push(maxScrollY);

  const shots = [];
  let lastActualY = -1;

  for (const requestedY of positions) {
    const scrollOnce = async () => {
      const [scrollRes] = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrollToYAndWait,
        args: [requestedY],
      });
      return scrollRes?.result?.y ?? requestedY;
    };

    let actualY = await scrollOnce();

    if (actualY === lastActualY && shots.length > 0) {
      if (requestedY > lastActualY) {
        await focusAndActivate(windowId, tabId);
        actualY = await scrollOnce();
      }
      if (actualY === lastActualY) break;
    }

    await chrome.scripting.executeScript({ target: { tabId }, func: waitTwoRafsInPage });
    await sleep(550);

    const shot = await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format, quality });
    if (!shot) {
      console.warn('[plugin] captureVisibleTab returned null during fullpage');
      break;
    }

    shots.push({ y: actualY, dataUrl: shot });
    lastActualY = actualY;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: scrollToYAndWait,
    args: [originalY],
  });

  if (shots.length <= 1) {
    return shots[0]?.dataUrl || (await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format, quality }));
  }

  const firstBitmap = await dataUrlToImageBitmap(shots[0].dataUrl);
  const canvasWidth = firstBitmap.width;

  const maxBottomCss = Math.max(...shots.map((s) => (Number(s.y) || 0) + m.viewportHeight));
  const effectiveCssHeight = Math.min(m.totalHeight, maxBottomCss);
  const canvasHeight = Math.max(1, Math.round(effectiveCssHeight * dpr));

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    console.warn('[plugin] OffscreenCanvas ctx missing, fallback to visible');
    return await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format, quality });
  }

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  let lastDestYDev = 0;
  let lastBitmapH = firstBitmap.height;

  ctx.drawImage(firstBitmap, 0, 0);

  for (let i = 1; i < shots.length; i++) {
    const bm = await dataUrlToImageBitmap(shots[i].dataUrl);
    let destYDev = Math.round((Number(shots[i].y) || 0) * dpr);

    const expectedMin = lastDestYDev + lastBitmapH;
    if (destYDev > expectedMin) destYDev = expectedMin;
    if (destYDev < lastDestYDev) continue;

    const remaining = canvasHeight - destYDev;
    if (remaining <= 0) continue;

    if (bm.height > remaining) {
      ctx.drawImage(bm, 0, 0, bm.width, remaining, 0, destYDev, bm.width, remaining);
      lastDestYDev = destYDev;
      lastBitmapH = remaining;
    } else {
      ctx.drawImage(bm, 0, destYDev);
      lastDestYDev = destYDev;
      lastBitmapH = bm.height;
    }
  }

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

async function captureBestEffortScreenshot(windowId, tabId) {
  let shot = await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format: 'jpeg', quality: 90 });
  if (shot) return shot;
  await focusAndActivate(windowId, tabId);
  return await captureVisibleTabDataUrlWithRetry(windowId, tabId, { format: 'jpeg', quality: 90 });
}

async function captureBestEffortFullPageScreenshot(windowId, tabId) {
  const tryCap = async (focused) => {
    if (focused) await focusAndActivate(windowId, tabId);
    else await new Promise((r) => chrome.tabs.update(tabId, { active: true }, () => r()));

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

    if (!res.ok) console.warn('[plugin] sendPluginScreenshotOnly non-OK', res.status);
    else console.log('[plugin] sendPluginScreenshotOnly OK');
  } catch (err) {
    console.error('[plugin] sendPluginScreenshotOnly error', err);
  }
}

function openWindowForTask(task) {
  return new Promise((resolve, reject) => {
    chrome.windows.create({ url: task.url, state: 'normal', focused: false }, (win) => {
      if (chrome.runtime.lastError || !win || !win.tabs || !win.tabs.length) {
        reject(chrome.runtime.lastError || new Error('windows.create failed'));
      } else {
        const tab = win.tabs[0];
        resolve({ windowId: win.id, tabId: tab.id });
      }
    });
  });
}

function waitForLoadAndSendScreenshot(windowId, tabId, task) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);

        setTimeout(async () => {
          try {
            await chrome.scripting.executeScript({ target: { tabId }, func: tryAcceptCookies });
            await sleep(500);

            const screenshotDataUrl = await captureBestEffortFullPageScreenshot(windowId, tabId);
            if (!screenshotDataUrl) {
              console.warn('[plugin] screenshot: capture failed');
              return resolve(false);
            }

            await sendPluginScreenshotOnly({
              task_id: task.task_id,
              monitor_id: task.monitor_id,
              zadanie_id: task.zadanie_id,
              screenshotDataUrl,
              url: tab.url,
            });

            chrome.windows.remove(windowId, () => {
              if (chrome.runtime.lastError) console.warn('[plugin] windows.remove error', chrome.runtime.lastError);
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

  try {
    const { windowId, tabId } = await openWindowForTask(task);
    const ok = await waitForLoadAndSendScreenshot(windowId, tabId, task);
    console.log('[plugin] screenshot task done ok=', ok);
  } catch (err) {
    console.error('[plugin] processTask error', err);
  } finally {
    const durationMs = Math.round(performance.now() - startTime);
    console.log('[plugin] task_finished', { task_id: task.task_id, duration_ms: durationMs });
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('pollPluginTasks', { periodInMinutes: POLL_INTERVAL_SECONDS / 60 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollPluginTasks') {
    pollForTasks().catch((err) => console.error('[plugin] pollForTasks alarm error', err));
  }
});

chrome.action.onClicked.addListener(() => {
  pollForTasks().catch((err) => console.error('[plugin] pollForTasks click error', err));
});

