(function () {
  function $(sel) { return document.querySelector(sel); }

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

  function init() {
    const tbody = $('#histBody');
    const backdrop = $('#histModalBackdrop');
    const closeX = $('#histModalClose');
    const closeBtn = $('#histCloseBtn');
    const downloadBtn = $('#histDownload');
    const titleEl = $('#histModalTitle');
    const preLog = $('#histLog');

    if (!tbody || !backdrop || !closeX || !closeBtn || !downloadBtn || !titleEl || !preLog) return;

    let lastText = '';
    let lastId = '';

    // tab click
    document.querySelectorAll('[data-hist-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.histTab));
    });

    closeX.addEventListener('click', () => hideModal(backdrop));
    closeBtn.addEventListener('click', () => hideModal(backdrop));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) hideModal(backdrop);
    });

    downloadBtn.addEventListener('click', () => {
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

      setActiveTab('log');
      showModal(backdrop);

      try {
        const text = await fetchText(`/api/historia/${encodeURIComponent(id)}/log`);
        lastText = text;
        preLog.textContent = text;
      } catch (err) {
        console.error(err);
        preLog.textContent = `Nie udało się pobrać szczegółów.\n${err?.message || err}`;
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

