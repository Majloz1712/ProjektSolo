(function () {
  function $(sel) { return document.querySelector(sel); }

  // znajdz <pre> w danym panelu zakladki historii
  function panePre(paneName, fallbackId) {
    const pane = document.querySelector(`[data-hist-pane="${paneName}"]`);
    const preInPane = pane ? pane.querySelector('pre') : null;
    return preInPane || (fallbackId ? $(fallbackId) : null);
  }

  function setActiveTab(name) {
    document.querySelectorAll('[data-hist-tab]').forEach((b) => {
      b.classList.toggle('tab--active', b.dataset.histTab === name);
    });
    document.querySelectorAll('[data-hist-pane]').forEach((p) => {
      p.style.display = (p.dataset.histPane === name) ? 'block' : 'none';
    });
  }

  function showModal(backdrop) {
    backdrop.style.display = 'grid';
    document.body.style.overflow = 'hidden';
  }

  function hideModal(backdrop) {
    backdrop.style.display = 'none';
    document.body.style.overflow = '';
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function fetchText(url) {
    const jwt = localStorage.getItem('jwt') || '';
    const headers = jwt ? { Authorization: `Bearer ${jwt}` } : {};
    const r = await fetch(url, { headers, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status} przy ${url}`);
    return await r.text();
  }

  async function fetchMaybeJson(url) {
    const txt = await fetchText(url);
    try {
      return { ok: true, data: JSON.parse(txt), raw: txt };
    } catch {
      return { ok: false, data: null, raw: txt };
    }
  }

  // wycinamy tylko poczatek (do block_reason) + clean_lines + chunki
  function buildSnapshotView(snap) {
    const top = {};
    const TOP_KEYS = [
      '_id',
      'monitor_id',
      'zadanie_id',
      'url',
      'ts',
      'mode',
      'final_url',
      'llm_prompt',
      'blocked',
      'block_reason',
    ];

    for (const k of TOP_KEYS) {
      if (k in (snap || {})) top[k] = snap[k];
    }

    const cleanLines =
      snap?.extracted_v2?.clean_lines ||
      snap?.clean_lines ||
      snap?.extracted?.clean_lines ||
      null;

    // rozne mozliwe lokalizacje chunkow w zaleznosci od wersji
    const chunks =
      snap?.text_chunks_v1?.chunks ||
      snap?.text_chunks?.chunks ||
      snap?.extracted_v2?.text_chunks_v1?.chunks ||
      snap?.extracted_v2?.text_chunks?.chunks ||
      snap?.extracted_v2?.chunks ||
      snap?.chunks ||
      null;

    // Minimalny widok w zakladce "migawka"
    return {
      ...top,
      clean_lines: Array.isArray(cleanLines)
        ? cleanLines
        : (cleanLines ? [String(cleanLines)] : []),
      chunks: Array.isArray(chunks) ? chunks : [],
    };
  }

  async function fetchSnapshot(id) {
    // probujemy kilka popularnych endpointow, bo w projektach czesto sie roznia
    const candidates = [
      `/api/historia/${encodeURIComponent(id)}/snapshot`,
      `/api/historia/${encodeURIComponent(id)}/migawka`,
      `/api/historia/${encodeURIComponent(id)}/json`,
      `/api/historia/${encodeURIComponent(id)}`,
    ];

    for (const url of candidates) {
      try {
        const res = await fetchMaybeJson(url);
        if (res.ok && res.data && typeof res.data === 'object') {
          return { ok: true, data: res.data, source: url };
        }
      } catch {
        // idziemy dalej
      }
    }

    return { ok: false, data: null, source: null };
  }

  function init() {
    const tbody = $('#histBody');
    const backdrop = $('#histModalBackdrop');
    const closeX = $('#histModalClose');
    const closeBtn = $('#histCloseBtn');
    const downloadBtn = $('#histDownload');
    const titleEl = $('#histModalTitle');
    const preLog = $('#histLog');

    // W Twoim HTML jest: <pre id="histMigawka" ...></pre>
    const preSnap =
      panePre('migawka', '#histMigawka') ||
      panePre('snapshot', '#histMigawka');

    if (!tbody || !backdrop || !closeX || !closeBtn || !downloadBtn || !titleEl || !preLog) return;

    let lastText = '';
    let lastId = '';
    let lastTab = 'log';

    function syncDownloadText() {
      if (lastTab === 'migawka' || lastTab === 'snapshot') {
        lastText = preSnap ? (preSnap.textContent || '') : '';
      } else if (lastTab === 'log') {
        lastText = preLog ? (preLog.textContent || '') : '';
      } else {
        // meta/analiza -> pobieramy z aktywnego pre jesli istnieje
        const activePane = document.querySelector(`[data-hist-pane="${lastTab}"]`);
        const pre = activePane ? activePane.querySelector('pre') : null;
        lastText = pre ? (pre.textContent || '') : '';
      }
    }

    // tab click
    document.querySelectorAll('[data-hist-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        lastTab = btn.dataset.histTab;
        setActiveTab(lastTab);
        syncDownloadText();
      });
    });

    closeX.addEventListener('click', () => hideModal(backdrop));
    closeBtn.addEventListener('click', () => hideModal(backdrop));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) hideModal(backdrop);
    });

    downloadBtn.addEventListener('click', () => {
      syncDownloadText();
      if (!lastText) return;
      downloadText(`trackly-szczegoly-${lastId}.txt`, lastText);
    });

    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;

      const label = (btn.textContent || '').trim().toLowerCase();
      if (!label.includes('szczeg')) return;

      const tr = btn.closest('tr');
      const id =
        btn.dataset.id ||
        btn.dataset.taskId ||
        tr?.dataset?.id ||
        tr?.querySelector('td')?.textContent?.trim();

      if (!id) return;

      lastId = id;
      lastText = '';
      titleEl.textContent = `Szczegóły: ${id}`;
      preLog.textContent = 'Ładowanie…';

      if (preSnap) preSnap.textContent = 'Ładowanie…';

      setActiveTab('log');
      lastTab = 'log';
      showModal(backdrop);

      try {
        const text = await fetchText(`/api/historia/${encodeURIComponent(id)}/log`);
        lastText = text;
        preLog.textContent = text;
      } catch (err) {
        console.error(err);
        preLog.textContent = `Nie udało się pobrać szczegółów.\n${err?.message || err}`;
      }

      // Migawka: pokazujemy TYLKO poczatek do block_reason + clean_lines + chunki
      if (preSnap) {
        try {
          const snapRes = await fetchSnapshot(id);
          if (snapRes.ok) {
            const filtered = buildSnapshotView(snapRes.data);
            preSnap.textContent = JSON.stringify(filtered, null, 2);
          } else {
            preSnap.textContent = 'Brak danych migawki (snapshot) dla tego wpisu historii.';
          }
        } catch (err) {
          console.error(err);
          preSnap.textContent = `Nie udało się pobrać migawki.\n${err?.message || err}`;
        }
      }
    });
  }

  // uruchom po załadowaniu DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
