// Genesis Agent CV — portable, unfakeable work history built from on-chain
// and local records. The NFT itself is the CV; this module formats it.
// Use: node src/cv.js genesis-gen-3   or   node src/cli.js cv <token>
const fs = require('fs');
const path = require('path');
const { standings } = require('./league');

function loadLeague() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'league.json'), 'utf8'));
  } catch {
    return { matches: [] };
  }
}

function loadFamilyTree() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'family-tree-generations.json'), 'utf8'));
  } catch {
    return { agents: [], events: [] };
  }
}

/**
 * Build a portable CV object for an agent.
 * tokenId examples: genesis-gen-2, genesis-gen-3
 */
function buildCV(tokenId) {
  const league = loadLeague();
  const tree = loadFamilyTree();
  const standingsRows = standings();

  // Find agent in family tree (id style gen-2 / gen-3)
  const shortId = tokenId.replace('genesis-', '').replace(/-/g, '-');
  const agent = (tree.agents || []).find(a =>
    a.id === shortId ||
    a.id === tokenId ||
    ('genesis-' + a.id) === tokenId ||
    a.id === tokenId.replace('genesis-', '')
  ) || null;

  // League record
  const row = standingsRows.find(r =>
    r.token === tokenId ||
    r.agent === tokenId ||
    r.agent === shortId ||
    ('genesis-' + r.agent) === tokenId
  ) || null;

  // Matches this agent played
  const matches = (league.matches || []).filter(m =>
    (m.results || []).some(r => r.agent === shortId || r.agent === tokenId || ('genesis-' + r.agent) === tokenId)
  ).map(m => ({
    job: m.job || m.brief || 'arena job',
    score: (m.results || []).find(r => r.agent === shortId || r.agent === tokenId)?.score,
    won: m.winner === shortId || m.winner === tokenId,
    paymentTx: m.paymentTx || null,
  }));

  const cv = {
    tokenId,
    title: agent ? `Genesis Agent ${agent.id}` : tokenId,
    generation: agent?.generation ?? null,
    parent: agent?.parent ?? null,
    status: agent?.status ?? 'unknown',
    skill: agent?.skill ?? null,
    jobsDone: agent?.jobsDone ?? 0,
    earned: agent?.earned ?? 0,
    consecutiveFails: agent?.consecutiveFails ?? 0,
    league: row ? {
      played: row.played,
      wins: row.wins,
      losses: row.losses,
      winRate: row.win_rate,
      bestScore: row.best_score,
      arenaEarnings: row.arena_earnings,
    } : null,
    recentMatches: matches.slice(-5),
    lineageNote: agent?.parent
      ? `Child of ${agent.parent}. Skills mutated from parent.`
      : 'Generation 0 — funded by treasury.',
    portable: true,
    generatedAt: new Date().toISOString(),
    note: 'This CV is derived from public demo records and league data. On-chain traits live in the NFT extra field and subaccount history.',
  };
  return cv;
}

function printCV(tokenId) {
  const cv = buildCV(tokenId);
  console.log('\n══════════════════════════════════════');
  console.log(`  GENESIS AGENT CV — ${cv.tokenId}`);
  console.log('══════════════════════════════════════');
  console.log(`Title:        ${cv.title}`);
  console.log(`Generation:   ${cv.generation}`);
  console.log(`Parent:       ${cv.parent || '—'}`);
  console.log(`Status:       ${cv.status}`);
  if (cv.skill) {
    console.log(`Skills:       speed ${cv.skill.speed} | quality ${cv.skill.quality} | costEff ${cv.skill.costEff}`);
  }
  console.log(`Jobs done:    ${cv.jobsDone}`);
  console.log(`Earned:       ${cv.earned}`);
  if (cv.league) {
    console.log(`League:       ${cv.league.wins}W-${cv.league.losses}L (${cv.league.winRate}) | best score ${cv.league.bestScore} | earnings ${cv.league.arenaEarnings}`);
  } else {
    console.log('League:       no matches yet');
  }
  console.log(`Lineage:      ${cv.lineageNote}`);
  if (cv.recentMatches.length) {
    console.log('Recent matches:');
    cv.recentMatches.forEach(m => {
      console.log(`  - ${m.won ? 'WIN' : 'LOSS'} score ${m.score} | ${m.job}`);
    });
  }
  console.log('══════════════════════════════════════\n');
  return cv;
}

if (require.main === module) {
  const token = process.argv[2] || 'genesis-gen-3';
  printCV(token);
}

module.exports = { buildCV, printCV };
