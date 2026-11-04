// Genesis league table — computed from arena matches, nothing invented.
// Source: demo/league.json (matches with scores and payment txs).
// Standings rule: most wins first, then best score, then fewest losses.
// A tie on all three is a genuine tie and is shown as one. Run with
// `node src/league.js` or `node src/cli.js league`.
const fs = require('fs');
const path = require('path');
function standings() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'league.json'), 'utf8'));
  const table = {};
  for (const m of data.matches) {
    for (const r of m.results) {
      const t = table[r.agent] || { agent: r.agent, token: r.agent.startsWith('gen3') ? 'genesis-gen-3' : r.agent.startsWith('gen2') ? 'genesis-gen-2' : '', played: 0, wins: 0, losses: 0, best_score: 0, arena_earnings: 0 };
      t.played += 1;
      if (m.winner === r.agent) { t.wins += 1; t.arena_earnings += 0.01; } else t.losses += 1;
      if (r.score > t.best_score) t.best_score = r.score;
      table[r.agent] = t;
    }
  }
  const rows = Object.values(table).map(t => ({ ...t, win_rate: t.played ? Math.round(t.wins / t.played * 100) + '%' : '—', arena_earnings: t.arena_earnings.toFixed(2) + ' NEAR' }));
  rows.sort((a, b) => b.wins - a.wins || b.best_score - a.best_score || a.losses - b.losses);
  return rows;
}
if (require.main === module) {
  for (const r of standings()) console.log(`${r.agent} (${r.token}): ${r.wins}W-${r.losses}L, win rate ${r.win_rate}, best score ${r.best_score}, arena earnings ${r.arena_earnings}`);
}
module.exports = { standings };
