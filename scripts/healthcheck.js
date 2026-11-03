// Asks the running server if it is fine. Exit code 0 when it is, 1 when it is not.
//   node scripts/healthcheck.js                    checks http://127.0.0.1:$PORT
//   HEALTH_URL=https://play.example.com node scripts/healthcheck.js
// On a VM a systemd timer runs this every minute. A failure shows up in
// `journalctl -u mafianight-health.service` and in `systemctl --failed`.
// There is no outside alert service on purpose, that would need an account.
const base = process.env.HEALTH_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const started = Date.now();

try {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 || body.ok !== true) throw new Error(`answered ${res.status}`);
  console.log(`ok in ${Date.now() - started} ms`);
} catch (err) {
  console.error(`health check failed: ${err.cause?.code ?? err.message}`);
  process.exit(1);
}
