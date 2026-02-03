PATCH v2 — Structured extraction + auto browser fallback when static HTML is JS-only

Dlaczego widziałeś tylko:
  "Napoje | Candy POP"
  "Candy POP"
i extractor = meta-og?

Bo w trybie STATIC wiele stron (Nuxt/Next/SPA) zwraca HTML prawie bez treści listy produktów.
W DOM jest wtedy głównie <meta> + <script> (JS bundles), a lista pojawia się dopiero po uruchomieniu JS w przeglądarce.

Co robi ten patch:
1) extractOrchestrator.js
   - structured-first wybór (headings/listy/tabele) zamiast "pierwszy z confidence>=0.5"
   - meta-og traktowany jako meta-only (nie może wygrywać, jeśli istnieje sensowny tekst z DOM)
   - JSON-LD nie jest już meta-only (może być użyty jako tekst, jeśli daje strukturę)

2) jsonldExtractor.js
   - obsługa ItemList / Product -> generuje ustrukturyzowany tekst (lista - nazwy + ceny)

3) agentSkanu.js
   - jeśli scan=static i:
       (a) HTML wygląda jak SPA (Nuxt/Next/itp.)
       (b) ekstrakcja jest "za cienka" (meta-only / kilka linii)
     → ten JEDEN skan przełącza się automatycznie na browser flow i powtarza ekstrakcję na wyrenderowanym HTML.

Pliki do podmiany:
- skrypt/orchestrator/extractOrchestrator.js
- skrypt/orchestrator/extractors/domStructuredText.js
- skrypt/orchestrator/extractors/visibleTextExtractor.js
- skrypt/orchestrator/extractors/readabilityExtractor.js
- skrypt/orchestrator/extractors/metaOgExtractor.js
- skrypt/orchestrator/extractors/jsonldExtractor.js
- skrypt/agentSkanu.js

Po wdrożeniu:
- dla stron SPA w static mode nie utkniesz na meta-og: system sam zrobi browser fallback,
  więc clean_lines powinny zawierać listę produktów i nagłówki/sekcje.
