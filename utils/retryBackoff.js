export async function retryWithBackoff(fn, {
  retries = 3,
  minDelay = 200,
  maxDelay = 5000,
  factor = 2,
  jitter = 0.3,
  onRetry,
} = {}) {
  let attempt = 0;
  let delay = minDelay;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries) {
        throw err;
      }
      if (typeof onRetry === 'function') {
        try {
          onRetry(err, attempt + 1);
        } catch (_) {
          // ignore logging errors
        }
      }
      const jitterFactor = 1 + (Math.random() * 2 - 1) * jitter;
      const waitMs = Math.min(delay * jitterFactor, maxDelay);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt += 1;
      delay = Math.min(delay * factor, maxDelay);
    }
  }
}
