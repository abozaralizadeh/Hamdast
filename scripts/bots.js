// Fills a room with bot players so one person can try a full game alone.
//   npm run bots -- ABC234 5            join 5 bots to room ABC234
//   BOTS_URL=http://127.0.0.1:3000 npm run bots -- ABC234
// Bots play at random. They are for trying the interface, not for judging balance.
import { Client } from '../test/helpers.js';

const [code, count = '5'] = process.argv.slice(2);
const url = process.env.BOTS_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
if (!code) {
  console.error('Usage: npm run bots -- ROOMCODE [count]');
  process.exit(1);
}

const bots = [];
for (let i = 1; i <= Number(count); i++) {
  const bot = new Client(url, `Bot${i}`);
  const joined = await bot.join(code);
  if (!joined.ok) {
    console.error(`Bot${i} could not join: ${joined.error}`);
    process.exit(1);
  }
  await bot.connect();
  bots.push(bot);
}
console.log(`${bots.length} bots joined ${code}. Start the game from your own window. Ctrl+C to stop them.`);
for (;;) {
  await Promise.all(bots.map((b) => b.autoplay().catch(() => {}))); // returns when the game is over
  console.log('Game over. The bots stay in the room for a rematch.');
  await bots[0].waitFor((v) => v.game === null, 60 * 60 * 1000).catch(() => {});
}
