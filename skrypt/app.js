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
    const token = localStorage.getItem("jwt");
    const headers = new Headers(init.headers || {});
    const url = typeof input === "string" ? input : (input?.url || "");

    if (token && shouldAttachToken(url) && !headers.has("Authorization")) {
      headers.set("Authorization", "Bearer " + token);
    }

    const resp = await nativeFetch(input, { ...init, headers });

    // Globalna obsługa wygaśnięcia / braku uprawnień
    if (resp.status === 401 && shouldAttachToken(url)) {
      try {
        localStorage.removeItem("jwt");
        localStorage.removeItem("userFullname");
        localStorage.removeItem("userEmail");
      } catch {}
      if (window.location.pathname !== "/logowanie.html") {
        window.location.href = "/logowanie.html";
      }
    }
    return resp;
  };
})();

// (opcjonalnie) Blokada dostępu do chronionych stron
(function checkAuth() {
  const publicPaths = ["/logowanie.html", "/rejestracja.html", "/resetHasla.html", "/"];
  const path = window.location.pathname;
  const token = localStorage.getItem("jwt");
  const isPublic = publicPaths.includes(path);
  if (!token && !isPublic) {
    window.location.href = "/logowanie.html";
  }
})();

// ===== helpers =====
function setMsg(container, text, type = "ok") {
  if (!container) return;
  if (type === "error" || type === "err") {
    container.textContent = text;
    container.className = "messages error msg-error";
  } else {
    container.textContent = text;
    container.className = "messages success msg-ok";
  }
}

window.togglePassword = function (id, btn) {
  const input = document.getElementById(id);
  if (!input) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  if (btn) btn.textContent = show ? "Ukryj" : "Pokaż";
};

window.logoutUser = function () {
  try {
    localStorage.removeItem("jwt");
    localStorage.removeItem("userFullname");
    localStorage.removeItem("userEmail");
  } catch {}
  window.location.href = "/logowanie.html";
};

// ===== LOGOWANIE =====
(function initLogin() {
  const form = document.getElementById("loginForm");
  if (!form) return;

  const emailEl = document.getElementById("email");
  const passEl = document.getElementById("password");
  const msg = document.getElementById("messages");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = (emailEl.value || "").trim();
    const password = passEl.value || "";

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
      return setMsg(msg, "Błędne dane logowania.", "error");
    }

    try {
      setMsg(msg, "Logowanie…");
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        return setMsg(msg, data.msg || "Nie udało się zalogować.", "error");
      }

      // 🔐 zapisz dane użytkownika i token JWT
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

  const nameEl = document.getElementById("fullname");
  const emailEl = document.getElementById("email");
  const passEl = document.getElementById("password");
  const pass2El = document.getElementById("password2");
  const termsEl = document.getElementById("terms");
  const msg = document.getElementById("messages");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const payload = {
      fullname: (nameEl.value || "").trim(),
      email: (emailEl.value || "").trim(),
      password: passEl.value || "",
      password2: pass2El.value || "",
      terms: !!termsEl.checked,
    };

    if (payload.fullname.length < 2) return setMsg(msg, "Podaj imię i nazwisko.", "error");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return setMsg(msg, "Nieprawidłowy e-mail.", "error");
    if (payload.password.length < 8) return setMsg(msg, "Hasło musi mieć min. 8 znaków.", "error");
    if (payload.password !== payload.password2) return setMsg(msg, "Hasła nie są identyczne.", "error");
    if (!payload.terms) return setMsg(msg, "Zaakceptuj regulamin.", "error");

    try {
      setMsg(msg, "Tworzenie konta…");
      const res = await fetch("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        return setMsg(msg, data.msg || "Błąd rejestracji.", "error");
      }

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

// ===== RESET HASŁA (placeholder) =====
(function initReset() {
  const form = document.getElementById("resetForm");
  if (!form) return;

  const emailEl = document.getElementById("email");
  const msg = document.getElementById("messages");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!emailEl.checkValidity()) return setMsg(msg, "Podaj poprawny adres e-mail.", "error");

    setMsg(msg, "Wysyłanie linku resetującego…");
    // TODO: podłącz /auth/reset, gdy dodasz endpoint
    setTimeout(() => setMsg(msg, "Jeśli adres istnieje, otrzymasz wiadomość e-mail."), 700);
  });
})();

