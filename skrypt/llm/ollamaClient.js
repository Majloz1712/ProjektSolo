// ./skrypt/llm/ollamaClient.js


const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL || 'llama3';

export async function generateTextWithOllama({prompt, model = TEXT_MODEL}) {
  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false, // łatwiej na początek
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error (${res.status}): ${text}`);
  }

  const data = await res.json();
  // data.response zawiera tekst
  return data.response;
}

export async function analyzeImageWithOllama({ model, prompt, base64Image }) {
  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [base64Image], // tu wrzucasz samo base64 BEZ prefixu data:image/png;base64,
      stream: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama vision error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.response;
}
