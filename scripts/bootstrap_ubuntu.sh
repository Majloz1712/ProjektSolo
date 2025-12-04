#!/usr/bin/env bash
set -euo pipefail

# Kompletny setup środowiska dla ProjektSolo na czystym Ubuntu.
# - tworzy wymagane tabele w PostgreSQL
# - zakłada podstawowe kolekcje w MongoDB
# - instaluje zależności npm
# Wymaga działających usług PostgreSQL i MongoDB oraz narzędzi psql/mongosh.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/skrypt/.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

PGUSER=${PGUSER:-postgres}
PGPASSWORD=${PGPASSWORD:-}
PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGDATABASE=${PGDATABASE:-postgres}

MONGO_URL=${MONGO_URL:-mongodb://127.0.0.1:27017}
MONGO_DB=${MONGO_DB:-inzynierka}

PSQL_BIN=$(command -v psql || true)
MONGO_BIN=$(command -v mongosh || command -v mongo || true)

if [[ -z "$PSQL_BIN" ]]; then
  echo "❌ Brak polecenia psql. Zainstaluj PostgreSQL (sudo apt install postgresql postgresql-contrib)."
  exit 1
fi

if [[ -z "$MONGO_BIN" ]]; then
  echo "❌ Brak polecenia mongosh/mongo. Zainstaluj MongoDB (sudo apt install mongodb || pakiet mongodb-org)."
  exit 1
fi

export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE

SQL_SETUP=$(cat <<'SQL'
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS uzytkownicy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pelna_nazwa TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  haslo_hash TEXT NOT NULL,
  utworzono_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monitory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uzytkownik_id UUID NOT NULL REFERENCES uzytkownicy(id) ON DELETE CASCADE,
  nazwa TEXT NOT NULL,
  url TEXT NOT NULL,
  llm_prompt TEXT,
  interwal_sec INTEGER NOT NULL,
  aktywny BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'ok',
  tryb_skanu TEXT NOT NULL DEFAULT 'static',
  css_selector TEXT,
  utworzono_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zadania_skanu (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id UUID NOT NULL REFERENCES monitory(id) ON DELETE CASCADE,
  zaplanowano_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  rozpoczecie_at TIMESTAMP WITHOUT TIME ZONE,
  zakonczenie_at TIMESTAMP WITHOUT TIME ZONE,
  status TEXT NOT NULL,
  blad_opis TEXT,
  tresc_hash TEXT,
  snapshot_mongo_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_zadania_skanu_status ON zadania_skanu(status, zaplanowano_at);
CREATE INDEX IF NOT EXISTS idx_zadania_skanu_monitor ON zadania_skanu(monitor_id);

CREATE TABLE IF NOT EXISTS plugin_tasks (
  id BIGSERIAL PRIMARY KEY,
  monitor_id UUID NOT NULL REFERENCES monitory(id) ON DELETE CASCADE,
  zadanie_id UUID NOT NULL REFERENCES zadania_skanu(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  mode TEXT NOT NULL DEFAULT 'fallback',
  utworzone_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  zaktualizowane_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plugin_tasks_status ON plugin_tasks(status, utworzone_at);
CREATE INDEX IF NOT EXISTS idx_plugin_tasks_monitor ON plugin_tasks(monitor_id);

CREATE TABLE IF NOT EXISTS wykrycia (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zadanie_id UUID NOT NULL REFERENCES zadania_skanu(id) ON DELETE CASCADE,
  url TEXT,
  tytul TEXT,
  pewnosc NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  monitor_id UUID NOT NULL REFERENCES monitory(id) ON DELETE CASCADE,
  snapshot_mongo_id TEXT,
  category TEXT,
  important BOOLEAN DEFAULT FALSE,
  reason TEXT,
  diff_json JSONB,
  utworzono_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wykrycia_monitor ON wykrycia(monitor_id, utworzono_at DESC);

CREATE TABLE IF NOT EXISTS powiadomienia (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uzytkownik_id UUID NOT NULL REFERENCES uzytkownicy(id) ON DELETE CASCADE,
  monitor_id UUID NOT NULL REFERENCES monitory(id) ON DELETE CASCADE,
  wykrycie_id UUID REFERENCES wykrycia(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'oczekuje',
  tresc TEXT NOT NULL,
  tytul TEXT,
  utworzono_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  wyslano_at TIMESTAMP WITHOUT TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_powiadomienia_status ON powiadomienia(status, utworzono_at);
SQL
)

echo "➡️ Tworzę tabele w PostgreSQL (${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE})..."
$PSQL_BIN -v ON_ERROR_STOP=1 -q -d "$PGDATABASE" -h "$PGHOST" -p "$PGPORT" -c "$SQL_SETUP"
echo "✅ PostgreSQL gotowy."

MONGO_SCRIPT=$(cat <<'JS'
const url = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const dbName = process.env.MONGO_DB || 'inzynierka';

const conn = new Mongo(url);
const db = conn.getDB(dbName);

['snapshots', 'analizy', 'oceny_zmian'].forEach((name) => {
  if (!db.getCollectionNames().includes(name)) {
    db.createCollection(name);
  }
});

db.snapshots.createIndex({ monitor_id: 1, zadanie_id: 1 }, { name: 'by_monitor_task' });
db.snapshots.createIndex({ ts: -1 }, { name: 'by_timestamp' });
db.analizy.createIndex({ snapshot_id: 1 }, { name: 'by_snapshot' });
db.oceny_zmian.createIndex({ snapshot_id: 1 }, { name: 'by_snapshot' });

print(`MongoDB gotowe: ${url}/${dbName}`);
JS
)

echo "➡️ Tworzę kolekcje w MongoDB (${MONGO_URL}/${MONGO_DB})..."
MONGO_URL="$MONGO_URL" MONGO_DB="$MONGO_DB" $MONGO_BIN "$MONGO_URL/$MONGO_DB" --quiet --eval "$MONGO_SCRIPT"

echo "➡️ Instaluję zależności npm..."
(cd "$ROOT_DIR" && npm install)

echo "🎉 Setup zakończony. Użyj konfiguracji z $ENV_FILE aby uruchomić serwer (node skrypt/serwerStart.js)."
