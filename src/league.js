// Genesis league table — computed from arena matches, nothing invented.
// Source: demo/league.json
// Standings rule: most wins first, then best score, then fewest losses.
// Run: node src/league.js   or   node src/cli.js league
const fs = require('fs');
const path = require('path');

function load() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'league.json'), 'utf8'));
}

function standings() {
  const data = load();
  const table = {};
  for (const m of data.matches || []) {
    for (const r of m.results || []) {
      const key = r.agent;
      const t = table[key] || {
        agent: key,
        token: key.startsWith('gen') ? `genesis-${key}` : key,
        played: 0,
        wins: 0,
        losses: 0,
        best_score: 0,
        total_score: 0,
        arena_earnings: 0,
      };
      t.played += 1;
      t.total_score += r.score || 0;
      if (m.winner === r.agent) {
        t.wins += 1;
        t.arena_earnings += m.pay || 0.01;
      } else {
        t.losses += 1;
      }
      if ((r.score || 0) > t.best_score) t.best_score = r.score;
      table[key] = t;
    }
  }
  const rows = Object.values(table).map(t => ({
    ...t,
    win_rate: t.played ? Math.round((t.wins / t.played) * 100) + '%' : '—',
    avg_score: t.played ? +(t.total_score / t.played).toFixed(2) : 0,
    arena_earnings: (+t.arena_earnings).toFixed(2) + ' NEAR',
  }));
  rows.sort((a, b) => b.wins - a.wins || b.best_score - a.best_score || a.losses - b.losses);
  return rows;
}

function printLeague() {
  const rows = standings();
  console.log('\n═══ GENESIS AGENT LEAGUE ═══');
  console.log('Rule: most wins → best score → fewest losses\n');
  if (!rows.length) {
    console.log('No matches yet. Run an arena first.');
    return rows;
  }
  rows.forEach((r, i) => {
    console.log(`${i + 1}. ${r.agent} (${r.token})`);
    console.log(`   ${r.wins}W-${r.losses}L  win rate ${r.win_rate}  best ${r.best_score}  avg ${r.avg_score}  earnings ${r.arena_earnings}`);
  });
  console.log('');
  return rows;
}

if (require.main === module) {
  printLeague();
}

module.exports = { standings, printLeague, load };
