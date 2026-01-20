import { readFile, writeFile } from "node:fs/promises";
import { chunkPageText } from "./chunking.js";

type CliArgs = {
  inputPath: string;
  outputPath: string;
  prevPath?: string;
  url?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i += 1;
    }
  }
  if (!args.in || !args.out) {
    throw new Error("Missing required arguments --in and --out.");
  }
  return {
    inputPath: args.in,
    outputPath: args.out,
    prevPath: args.prev,
    url: args.url,
  };
}

async function loadPrev(path?: string) {
  if (!path) return null;
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as { chunks: Array<{ id: number; title?: string; text: string }> };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const inputText = await readFile(args.inputPath, "utf-8");
  const previous = await loadPrev(args.prevPath);
  const result = await chunkPageText({
    text: inputText,
    url: args.url,
    previous,
  });
  await writeFile(args.outputPath, JSON.stringify(result, null, 2));
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
