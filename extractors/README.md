# Extractor pipeline

Warstwowy pipeline ekstrakcji w katalogu `extractors/` oraz `orchestrator/` działa według ustalonego priorytetu:

1. **JSON-LD (`jsonldExtractor`)** – analizuje skrypty `application/ld+json`, preferując typy `Product`, `Article`, `NewsArticle`.
2. **Meta/OG (`metaOgExtractor`)** – wykorzystuje Open Graph, Twitter Card i klasyczne metadane HTML.
3. **Readability (`readabilityExtractor`)** – wybiera najbogatszy fragment treści (article/main) na podstawie liczby akapitów i długości tekstu.
4. **Widoczny tekst (`visibleTextExtractor`)** – zbiera tekst z widocznych węzłów i proste heurystyki selektorów.
5. **Fallback** – dostarcza minimalny wynik, gdy poprzednie kroki nie osiągną wymaganej jakości.

Każdy ekstraktor eksponuje metody `detect(doc, html)` (zwraca wynik 0..1) oraz `extract(doc, context)` (zwraca obiekt wynikowy). Orkiestrator (`orchestrator/extractOrchestrator.js`) ocenia detekcję wszystkich warstw, wybiera najwyższą (z zachowaniem priorytetu) i w razie niskiej pewności przechodzi do kolejnych. Gdy wszystkie zawiodą, wynik pochodzi z fallbacku.

Orkiestrator potrafi automatycznie sięgnąć po renderowanie Puppeteera, jeśli dane ze statycznego fetchu są niewystarczające (chyba że wyraźnie wyłączono render). W przypadku wykrycia blokady (CAPTCHA, 403/429 itp.) zapisuje screenshot w `logs/blocked/`, oznacza wynik flagami `blocked` i `human_review` oraz loguje szczegóły do `logs/extractor.log`.

Wywołanie przykładowe:

```js
import { fetchAndExtract } from '../orchestrator/extractOrchestrator.js';

const result = await fetchAndExtract('https://example.com/some-article');
console.log(result.extractor, result.confidence);
```

Struktura zwracanego obiektu jest opisana w dokumentacji zadania (`Extracted`).
