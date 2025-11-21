// background.js
import { BACKEND_BASE_URL, POLL_INTERVAL_SECONDS, AUTH_TOKEN } from './config.js';

let currentTask = null;

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

    if (res.status === 204) {
      return null;
    }
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

    if (!data || !data.url || !data.task_id) {
      return null;
    }
    return data;
  } catch (err) {
    console.error('[plugin] fetchNextPluginTask error', err);
    return null;
  }
}

// ===== Fallback: screenshot =====

async function sendPluginScreenshotResult({ task_id, monitor_id, screenshotDataUrl, url }) {
  try {
    // obetnij prefix data:image/png;base64,
    const base64 = screenshotDataUrl.split(',')[1] || screenshotDataUrl;

    const res = await apiFetch(`/api/plugin-tasks/${encodeURIComponent(task_id)}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monitor_id,
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

        setTimeout(() => {
          chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, async (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
              console.error('[plugin] captureVisibleTab error', chrome.runtime.lastError);
              resolve(false);
              return;
            }

            console.log('[plugin] screenshot captured, sending to backend...');
            await sendPluginScreenshotResult({
              task_id: task.task_id,
              monitor_id: task.monitor_id,
              screenshotDataUrl: dataUrl,
              url: task.url,
            });

            chrome.windows.remove(windowId, () => {
              if (chrome.runtime.lastError) {
                console.warn('[plugin] windows.remove error', chrome.runtime.lastError);
              }
            });

            resolve(true);
          });
        }, 3000);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ===== Price only: wyciąganie cen z DOM =====

async function sendPluginPriceResult({ task_id, monitor_id, url, prices }) {
  try {
    const res = await apiFetch(`/api/plugin-tasks/${encodeURIComponent(task_id)}/price`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monitor_id: monitor_id,
        url: url || null,
        prices,
      }),
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

// ta funkcja wykonuje się w kontekście strony (content script)
function extractPricesFromDom() {
  const currencyRegex = /(zł|pln|eur|€|usd|\$)/i;
  const digitRegex = /\d/;

  const candidates = [];
  const elements = Array.from(document.querySelectorAll('body *'));

  for (const el of elements) {
    const text = (el.innerText || el.textContent || '').trim();
    if (!text) continue;
    if (!currencyRegex.test(text)) continue;
    if (!digitRegex.test(text)) continue;      // <--- NOWE: musi być cyfra
    if (text.length > 100) continue;           // odrzuć bardzo długie opisy

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

async function processOneTask() {
  if (currentTask) return;

  const task = await fetchNextPluginTask();
  if (!task) {
    return;
  }

  currentTask = task;
  console.log('[plugin] got task', task);

  try {
    const { windowId, tabId } = await openWindowForTask(task);

    if (task.mode === 'price_only') {
      const ok = await waitForLoadAndExtractPrices(windowId, tabId, task);
      console.log('[plugin] price_only task done ok=', ok);
    } else {
      const ok = await waitForLoadAndScreenshot(windowId, tabId, task);
      console.log('[plugin] fallback task done ok=', ok);
    }
  } catch (err) {
    console.error('[plugin] processOneTask error', err);
  } finally {
    currentTask = null;
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
    processOneTask().catch((err) => console.error('[plugin] processOneTask alarm error', err));
  }
});

// klik w ikonę – ręczne odpalenie (debug)
chrome.action.onClicked.addListener(() => {
  processOneTask().catch((err) => console.error('[plugin] processOneTask click error', err));
});

