# Dokumentacja plików

Szczegółowy opis wszystkich plików w repozytorium. Ścieżki są pogrupowane według katalogów.

## Katalog główny
- `README.md` – ogólny opis monorepo, szybki start oraz odnośniki do kluczowych komponentów i dokumentacji architektury.
- `package.json` – manifest npm z zależnościami (Express, Puppeteer, JSDOM, bcrypt, nodemailer) oraz skryptem `npm test` uruchamiającym sprawdzenie ekstraktorów.
- `package-lock.json` – zamrożone wersje zależności npm dla deterministycznych instalacji.
- `readme.txt` – krótka notatka inicjalizacyjna repozytorium git.
- `struktura_czysta.txt` – tekstowy zrzut struktury katalogów z wczesnego etapu projektu.

## `docs/`
- `architecture.md` – przekrojowy opis architektury (pipeline ekstrakcji, API Express, plugin, LLM, powiadomienia).
- `file_reference.md` (ten dokument) – lista plików i ich ról.

## `extractors/`
- `README.md` – wprowadzenie do warstwowego pipeline'u ekstrakcji oraz przykład użycia `fetchAndExtract`.
- `jsonldExtractor.js` – parser JSON-LD; wybiera wpisy Product/Article/WebPage, normalizuje tytuł/opis/tekst, ceny z `offers`, obrazy i atrybuty produktu oraz zwraca `contentType` na podstawie typu i treści.
- `metaOgExtractor.js` – ekstrakcja z metadanych OpenGraph/Twitter/klasycznych meta; zbiera tytuł, opis, ogólny tekst strony, obrazy oraz ceny z meta `product:price:*`.
- `readabilityExtractor.js` – wyszukuje najbogatszy kontener treści (`article`/`main`/inne sekcje), usuwa skrypty/style, zwraca tekst, tytuł, opis, opcjonalną cenę z heurystyki tekstu oraz listę obrazów.
- `visibleTextExtractor.js` – przechodzi drzewo DOM `TreeWalkerem`, filtruje niewidoczne/śmieciowe węzły, zwraca uogólniony tekst strony, heurystyczny kontener HTML, tytuł/opis oraz detekcję ceny w treści.

## `orchestrator/`
- `extractOrchestrator.js` – koordynator pobierania i ekstrakcji: pobiera statycznie (z retry) lub przez render Puppeteera, wykrywa blokady (statusy/CAPTCHA), wybiera najlepszy ekstraktor według wyniku `detect`, loguje działania i zwraca wynik z fallbackiem oraz flagami `blocked/human_review` gdy wymagane.

## `utils/`
- `normalize.js` – pomocnicze funkcje normalizacji: białe znaki, parsowanie ceny/waluty, obcinanie tekstu, inferencja typu treści (product/article/page), sanityzacja tablic oraz konwersja daty do ISO.
- `retryBackoff.js` – generyczna pętla retry z wykładniczym backoffem i jitterem, stosowana np. przy fetchu w orkiestratorze.

## `scripts/`
- `testExtractors.js` – prosty runner testowy wywołujący `fetchAndExtract` na kilku przykładowych stronach (wiki, sklep, strona statyczna) i wypisujący wyniki.

## `skrypt/` – backend, agent i logika LLM
- `.env` – przykładowa konfiguracja środowiska dla Postgresa/Mongo/portu serwera Express.
- `serwerStart.js` – uruchamia Express, podpina połączenia PG/Mongo do `req`, montuje route'y `/auth`, `/api/monitory`, `/api/plugin-tasks`, serwuje statyczne pliki i startuje serwer na porcie 3001.
- `polaczeniePG.js` – konfiguracja puli połączeń do Postgresa na podstawie zmiennych `.env`.
- `polaczenieMDB.js` – klient MongoDB i funkcje `connectMongo`/`getDb` z prostym cachem połączenia.
- `jwt.js` – pomocnicze funkcje podpisywania (`signJwt`) i weryfikacji (`verifyJwt` middleware) tokenów JWT.
- `app.js` – frontendowy skrypt obsługujący logowanie/rejestrację/reset hasła, przechowywanie JWT w `localStorage`, globalne owijanie `fetch` (doklejanie tokenu) oraz podstawową ochronę tras panelu.
- `agentSkanu.js` – rozbudowany agent Puppeteer: polityka trybów skanowania, konfiguracja proxy/fingerprintu, logika sesji (zapisywanie/odtwarzanie cookies/localStorage w Mongo), heurystyki cen, obsługa zadań skanu w Postgresie i zapisywanie snapshotów.
- `workerPowiadomien.js` – worker SMTP pobierający oczekujące powiadomienia z Postgresa, wysyłający e-maile przez nodemailer i oznaczający rekordy jako wysłane.

### `skrypt/routes/`
- `auth.js` – endpointy rejestracji i logowania; walidacja danych, hashowanie haseł w bcrypt i generowanie JWT.
- `monitory.js` – zabezpieczone middlewarem JWT CRUD/PATCH dla monitorów (filtrowanie, paginacja, toggle statusu, usuwanie) w tabeli `monitory`.
- `pluginTasks.js` – kolejka zadań dla pluginu: pobieranie następnego zadania, przyjmowanie wyników DOM/screenshotów, aktualizacja snapshotu o ceny z pluginu oraz wywołanie pipeline'u LLM.

### `skrypt/llm/`
- `ollamaClient.js` – klient HTTP do Ollamy (tekst i obraz), z konfiguracją hosta/modelu przez zmienne środowiskowe.
- `analizaSnapshotu.js` – warstwa 1 pipeline'u: generuje prompt z tytułu/opisu/tekstu/cen, wywołuje Ollamę, zapisuje analizę snapshotu w kolekcji `analizy` (lub błąd gdy analiza niemożliwa).
- `diffEngine.js` – narzędzia warstwy 2: pobieranie poprzedniego snapshota, prosta metryka różnicy tekstu, wykrywanie zmian cen (w tym `plugin_prices`), tytułu/opisu/tekstów/obrazów i budowanie obiektu `diff`.
- `ocenaZmianyLLM.js` – warstwa 3: prompt do LLM oceniający istotność zmiany na podstawie analizy/diffu, parsowanie odpowiedzi JSON i zapis oceny w Mongo oraz rekordów wykryć/powiadomień w Postgresie.
- `pipelineZmian.js` – spina kroki analizy: ładuje snapshot (po ID lub obiekcie), wymusza analizę, pobiera poprzedni snapshot, liczy diff, wywołuje ocenę LLM i w razie istotności zapisuje wykrycie/powiadomienie.

### `skrypt/plugin/`
- `manifest.json` – manifest MV3 rozszerzenia Chrome z uprawnieniami do zakładek/skriptowania/host_permissions oraz workerem `background.js`.
- `config.js` – konfiguracja pluginu (adres backendu, interwał odpytywania, opcjonalny token autoryzacji).
- `background.js` – service worker: pobiera zadania z backendu, otwiera nowe okno, próbuje wysłać DOM+tekst (lub screenshot jako fallback), tryb `price_only` do ekstrakcji cen z DOM i wysyłki na endpoint `/price`.

## `strona/` – statyczny frontend panelu
- `logowanie.html` – formularz logowania z obsługą „pokaż hasło” i linkiem do resetu; korzysta z `skrypt/app.js`.
- `rejestracja.html` – formularz rejestracji z walidacją pól, checkboxem regulaminu i komunikatami o błędach.
- `resetHasla.html` – placeholder resetu hasła z prostym formularzem e-mail i komunikatem potwierdzenia.
- `panel.html` – layout panelu (header, sidebar, menu użytkownika, kontent dynamiczny); wstrzykuje widoki z podkatalogu `widoki/` i używa logiki z `skrypt/app.js`.
- `widoki/dodaj-sonde.html` – widok dodawania sondy: formularz nazwy/URL/interwału/promptu, licznik znaków, walidacja URL-i i wysyłka POST na `/api/monitory`.
- `widoki/moje-sondy.html` – widok listy sond użytkownika z tabelą, filtrami statusów, paginacją oraz akcjami wstrzymania/usunięcia (zależne od odpowiednich endpointów API).

## `styl/`
- `styles.css` – wspólne style w ciemnej tonacji dla formularzy logowania/rejestracji/panelu i widoków: siatka layoutu, przyciski, pola input, komunikaty, sidebar/panel nawigacyjny.
