// Review reports on a running server through its admin endpoints.
//   npm run reports                  list open reports
//   npm run reports -- dismiss <id>  close a report with no action
//   npm run reports -- ban <id>      remove the reported player's session
// Needs ADMIN_TOKEN set in .env (the server turns the endpoints off without it).
const base = process.env.REPORTS_URL ?? `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? 3000}`;
const token = process.env.ADMIN_TOKEN;
const [command = 'list', id] = process.argv.slice(2);

if (!token) {
  console.error('ADMIN_TOKEN is not set. Set it in .env and restart the server to use this tool.');
  process.exit(1);
}

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

if (command === 'list') {
  const { status, data } = await call('GET', '/api/admin/reports');
  if (status !== 200) { console.error(`Server said ${status}: ${data.error ?? 'error'}`); process.exit(1); }
  if (data.reports.length === 0) console.log('No open reports.');
  for (const r of data.reports) {
    console.log(`\n${r.id}  ${r.reason}  ${new Date(r.created_at).toISOString()}`);
    console.log(`  room ${r.snapshot.roomCode}, reported player: ${r.snapshot.reported}`);
    for (const m of r.snapshot.recent.slice(-8)) console.log(`    ${m.from}: ${m.body}`);
  }
} else if ((command === 'dismiss' || command === 'ban') && id) {
  const { status, data } = await call('POST', `/api/admin/reports/${id}`, { action: command });
  console.log(status === 200 ? `Done: ${command}` : `Failed (${status}): ${data.error}`);
  process.exit(status === 200 ? 0 : 1);
} else {
  console.error('Usage: reports [list] | dismiss <id> | ban <id>');
  process.exit(1);
}
