// Plays random games and prints how often each side wins, to help tune the role
// table. Usage: node scripts/simulate.js [gamesPerSize] [firstSeed]
import { simulateGame } from '../src/engine/simulate.js';

const games = Number(process.argv[2] ?? 500);
const firstSeed = Number(process.argv[3] ?? 1);

console.log('players  games  mafia wins  citizen wins  avg phases');
for (let players = 6; players <= 12; players++) {
  let mafia = 0;
  let phases = 0;
  for (let i = 0; i < games; i++) {
    const r = simulateGame({ seed: firstSeed + i * 13 + players, players });
    if (r.state.winner === 'mafia') mafia += 1;
    phases += r.phases;
  }
  const row = [players, games, `${((mafia / games) * 100).toFixed(0)}%`, `${(((games - mafia) / games) * 100).toFixed(0)}%`, (phases / games).toFixed(1)];
  console.log(row.map((c, i) => String(c).padEnd([9, 7, 12, 14, 10][i])).join(''));
}
console.log('\nBots here vote and act at random, so real games will lean differently.');
