const baseUrl = process.env.SERVICE_BASE_URL;

if (!baseUrl) {
  console.error('SERVICE_BASE_URL is required.');
  process.exit(2);
}

let parsed;
try {
  parsed = new URL(baseUrl);
} catch {
  console.error('SERVICE_BASE_URL must be a valid URL.');
  process.exit(2);
}
if (!['http:', 'https:'].includes(parsed.protocol)) {
  console.error('SERVICE_BASE_URL must use HTTP or HTTPS.');
  process.exit(2);
}

const origin = parsed.origin;
const checks = ['/health', '/ready'];
const results = [];

for (const path of checks) {
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL(path, origin), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    const passed = response.ok && (path === '/health' ? body.ok === true : body.ready === true);
    results.push({
      path,
      ok: passed,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      ...(passed ? {} : { reason: body.reason || body.error || 'Health check did not return ready.' }),
    });
  } catch (error) {
    results.push({
      path,
      ok: false,
      latencyMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.name : 'RequestFailed',
    });
  }
}

for (const result of results) console.log(JSON.stringify(result));
if (results.some(result => !result.ok)) process.exit(1);
