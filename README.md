# ProjektSolo

Repository for the ProjektSolo codebase and supporting assets.

## Semantic chunking module

### Build artifacts
The chunking module is implemented in `src/` and its compiled artifacts are in `dist/`.

### CLI usage
```bash
node dist/cli.js --in page.txt --out chunks.json --prev prev.json --url https://example.com
```

### Programmatic usage
```js
import { chunkPageText } from "./dist/index.js";

const result = await chunkPageText({ text: "Page content..." });
```

### Tests
```bash
npm test
```
