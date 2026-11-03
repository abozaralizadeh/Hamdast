// Copies the database to DATA_DIR/backups/ and keeps the newest few.
// Uses SQLite's own backup, so it is safe while the server is running.
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const keep = Number(process.env.BACKUP_KEEP ?? 7);
const source = path.join(dataDir, 'mafianight.db');
if (!fs.existsSync(source)) {
  console.log('No database yet, nothing to back up.');
  process.exit(0);
}
const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, `mafianight-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(source, { readOnly: true });
await backup(db, target);
db.close();
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
for (const old of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, old));
console.log(`Backed up to ${target}`);
