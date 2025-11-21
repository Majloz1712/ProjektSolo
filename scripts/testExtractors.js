import { fetchAndExtract } from '../orchestrator/extractOrchestrator.js';

const samples = [
  { url: 'https://pl.wikipedia.org/wiki/Programowanie', label: 'article' },
  { url: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html', label: 'product' },
  { url: 'https://example.com/', label: 'page' },
];

async function run() {
  for (const { url, label } of samples) {
    const result = await fetchAndExtract(url, { correlationId: `test-${label}` });
    console.log(`\n=== ${label.toUpperCase()} :: ${url} ===`);
    console.log(JSON.stringify(result, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error('testExtractors failed', err);
    process.exitCode = 1;
  });
}
