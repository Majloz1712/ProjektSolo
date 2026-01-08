// ===== JWT FETCH HELPER (jedyny, spójny wrapper) =====
(function setupJwtFetch() {
  const nativeFetch = window.fetch;

  function shouldAttachToken(url) {
    try {
      // Rozwiąż URL (obsługa względnych ścieżek)
      const u = new URL(url, window.location.origin);
      // Nie wysyłaj JWT do endpointów autoryzacji
      return !/^\/auth\//.test(u.pathname);
    } catch {
      return true;
    }
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url || "";
    const token = localStorage.getItem("jwt");

    const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined) || {});
    if (token && shouldAttachToken(url)) headers.set("Authorization", `Bearer ${token}`);

    const nextInit = { ...init, headers };
    return nativeFetch(input, nextInit);
  };
})();

// ===== UI HELPERS =====
function setMsg(el, text, type) {
  if (!el) return;
  el.textContent = text || "";
  el.className = "messages " + (type === "ok" ? "msg-ok" : type === "error" ? "msg-error" : "");
}

// ===== LOGIN =====
(function initLogin() {
  const form = document.getElementById("loginForm");
  if (!form) return;

  const emailEl = document.getElementById("email");
  const passEl = document.getElementById("password");
  const msg = document.getElementById("messages");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!emailEl.checkValidity()) return setMsg(msg, "Podaj poprawny adres e-mail.", "error");
    if (!passEl.value) return setMsg(msg, "Podaj hasło.", "error");

    setMsg(msg, "Logowanie…");

    try {
      const r = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEl.value.trim(), password: passEl.value }),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) return setMsg(msg, data.msg || "Błąd logowania.", "error");

      // 🔐 backend zwraca token — zapis i przejście do panelu
      try {
        localStorage.setItem("userFullname", data.user?.fullname || "");
        localStorage.setItem("userEmail", data.user?.email || "");
        if (data.token) localStorage.setItem("jwt", data.token);
      } catch {}

      setMsg(msg, "Zalogowano. Przekierowanie…");
      setTimeout(() => (window.location.href = "/panel.html"), 600);
    } catch (err) {
      console.error(err);
      setMsg(msg, "Błąd połączenia z serwerem.", "error");
    }
  });
})();

// ===== REJESTRACJA =====
(function initRegister() {
  const form = document.getElementById("registerForm");
  if (!form) return;

  const fullname = document.getElementById("fullname");
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const password2 = document.getElementById("password2");
  const terms = document.getElementById("terms");
  const msg = document.getElementById("messages");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!fullname.value.trim() || fullname.value.trim().length < 2) return setMsg(msg, "Podaj imię i nazwisko.", "error");
    if (!email.checkValidity()) return setMsg(msg, "Podaj poprawny adres e-mail.", "error");
    if (!password.value || password.value.length < 8) return setMsg(msg, "Hasło musi mieć min. 8 znaków.", "error");
    if (password.value !== password2.value) return setMsg(msg, "Hasła nie są takie same.", "error");
    if (!terms.checked) return setMsg(msg, "Musisz zaakceptować regulamin.", "error");

    setMsg(msg, "Tworzenie konta…");

    try {
      const r = await fetch("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullname: fullname.value.trim(),
          email: email.value.trim(),
          password: password.value,
          password2: password2.value,
          terms: terms.checked,
        }),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) return setMsg(msg, data.msg || "Nie udało się utworzyć konta.", "error");

      // 🔐 backend zwraca token — od razu logujemy i przechodzimy do panelu
      try {
        localStorage.setItem("userFullname", data.user?.fullname || "");
        localStorage.setItem("userEmail", data.user?.email || "");
        if (data.token) localStorage.setItem("jwt", data.token);
      } catch {}

      setMsg(msg, "Konto utworzone. Przekierowanie…");
      setTimeout(() => (window.location.href = "/panel.html"), 800);
    } catch (err) {
      console.error(err);
      setMsg(msg, "Błąd połączenia z serwerem.", "error");
    }
  });
})();

// ===== RESET HASŁA (request + confirm) =====
(function initResetHasla(){
  const form = document.getElementById('resetForm');
  if (!form) return;

  const emailEl = document.getElementById('email');
  const msgEl = document.getElementById('messages');

  const setMsgLocal = (text, type) => {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = 'messages ' + (type === 'ok' ? 'msg-ok' : (type === 'error' ? 'msg-error' : ''));
  };

  // token w URL => tryb ustawienia nowego hasła
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  function ensurePasswordFields(){
    let p1 = document.getElementById('newPassword');
    let p2 = document.getElementById('newPassword2');
    if (p1 && p2) return { p1, p2 };

    const emailField = emailEl?.closest('.field');
    if (!emailField) return null;

    emailField.style.display = 'none';

    const wrap1 = document.createElement('div');
    wrap1.className = 'field';
    wrap1.innerHTML = `
      <label for="newPassword">Nowe hasło</label>
      <input id="newPassword" class="input" type="password" required minlength="8" placeholder="min. 8 znaków" />
      <div class="hint">Użyj min. 8 znaków. Dla bezpieczeństwa zastosuj też cyfrę i znak specjalny.</div>
    `;

    const wrap2 = document.createElement('div');
    wrap2.className = 'field';
    wrap2.innerHTML = `
      <label for="newPassword2">Powtórz nowe hasło</label>
      <input id="newPassword2" class="input" type="password" required minlength="8" placeholder="powtórz hasło" />
    `;

    emailField.parentElement.insertBefore(wrap1, emailField.nextSibling);
    emailField.parentElement.insertBefore(wrap2, wrap1.nextSibling);

    p1 = document.getElementById('newPassword');
    p2 = document.getElementById('newPassword2');
    return { p1, p2 };
  }

  // UX: przełącz teksty jeśli token w URL
  try{
    if (token){
      const title = document.querySelector('.title');
      const subtitle = document.querySelector('.subtitle');
      if (title) title.textContent = 'Ustaw nowe hasło';
      if (subtitle) subtitle.textContent = 'Wpisz nowe hasło dla swojego konta';
      const btn = form.querySelector('button[type="submit"]');
      if (btn) btn.textContent = 'Zapisz nowe hasło';
      ensurePasswordFields();
    }
  } catch {}

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsgLocal('');

    try{
      // ===== TRYB 1: request reset link =====
      if (!token){
        const email = (emailEl?.value || '').trim();
        if (!email) return setMsgLocal('Podaj e-mail.', 'error');
        if (!emailEl.checkValidity()) return setMsgLocal('Podaj poprawny adres e-mail.', 'error');

        setMsgLocal('Wysyłanie linku resetującego…');

        const r = await fetch('/auth/password-reset/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.msg || 'Nie udało się wysłać linku.');

        // W trybie dev backend może zwrócić link (fallback bez maila)
        if (data?.dev_reset_url){
          setMsgLocal('Tryb DEV: link resetujący został zwrócony (poniżej).', 'ok');
          const pre = document.createElement('pre');
          pre.className = 'mono';
          pre.style.whiteSpace = 'pre-wrap';
          pre.style.marginTop = '10px';
          pre.textContent = data.dev_reset_url;
          msgEl.appendChild(pre);
        } else {
          setMsgLocal('Jeśli konto istnieje, wysłaliśmy link resetujący na e-mail.', 'ok');
        }
        return;
      }

      // ===== TRYB 2: confirm new password =====
      const fields = ensurePasswordFields();
      const p1 = (fields?.p1?.value || '').trim();
      const p2 = (fields?.p2?.value || '').trim();

      if (!p1 || p1.length < 8) return setMsgLocal('Hasło musi mieć min. 8 znaków.', 'error');
      if (p1 !== p2) return setMsgLocal('Hasła nie są takie same.', 'error');

      setMsgLocal('Zapisuję nowe hasło…');

      const r = await fetch('/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: p1, password2: p2 })
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.msg || 'Nie udało się zresetować hasła.');

      setMsgLocal('Hasło zmienione. Przekierowanie do logowania…', 'ok');
      setTimeout(() => (window.location.href = '/logowanie.html'), 800);

    } catch (err){
      console.error(err);
      setMsgLocal(err?.message || 'Błąd połączenia z serwerem.', 'error');
    }
  });
})();
// ===== WYLOGOWANIE (dla panel.html) =====
window.logoutUser = function logoutUser() {
  try {
    localStorage.removeItem("jwt");
    localStorage.removeItem("userFullname");
    localStorage.removeItem("userEmail");
  } catch {}
  window.location.href = "/logowanie.html";
};

