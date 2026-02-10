# ProjektSolo

Aplikacja do monitorowania zmian treści stron WWW z panelem użytkownika, API backendowym (Express), bazami PostgreSQL + MongoDB oraz agentem skanującym i pipeline'em analizy zmian.

## Wymagania

- Node.js 20+
- npm 10+
- PostgreSQL
- MongoDB
- (Opcjonalnie) Ollama dla analizy LLM
- (Opcjonalnie) SMTP dla wysyłki e-mail

## Instalacja

1. Zainstaluj zależności:
   ```bash
   npm install
   ```
2. Przygotuj konfigurację środowiska:
   ```bash
   cp .env.example .env
   ```
3. Uzupełnij wartości w `.env` (minimum: PostgreSQL, MongoDB, JWT).

## Uruchomienie

### Backend HTTP
```bash
npm run start
```

### Agent skanujący (osobny proces)
```bash
npm run start:agent
```

### Worker powiadomień (osobny proces)
```bash
npm run start:worker
```

## Konfiguracja środowiskowa

Podstawowe zmienne (pełna lista startowa w `.env.example`):

- `PORT`, `APP_BASE_URL`, `JWT_SECRET`, `JWT_EXPIRES`
- `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- `MONGO_URI`, `MONGO_DB`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `OLLAMA_HOST`, `OLLAMA_TEXT_MODEL`, `LLM_MODEL` (opcjonalne)

## Struktura katalogów (skrót)

- `skrypt/` — backend, routing API, agent, worker, pipeline LLM, plugin.
- `orchestrator/` — orkiestracja ekstrakcji treści ze stron.
- `extractors/` — warstwy ekstrakcji (JSON-LD, Meta/OG, readability, visible text).
- `strona/` — statyczne widoki HTML panelu użytkownika.
- `styl/` — arkusze CSS frontendu.
- `utils/` — funkcje pomocnicze (normalizacja, retry, czyszczenie tekstu).
