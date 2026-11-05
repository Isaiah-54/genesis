// Generate one distinct NFT card image (SVG) per Genesis generation.
// Each generation gets its own hue, subtitle, and ring motif, so every
// minted NFT carries a different card. Cards are served from the website
// (https://genesis-roan-eta.vercel.app/nft/gen-N.svg) and referenced as the
// `media` URL when minting. Gen 10+ uses the fallback card gen-x.svg.
// Existing tokens keep their old media: token metadata on the shared
// contract is immutable, so this only applies to new mints.
//
// Usage: node scripts/gen-nft-cards.js
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'nft');
fs.mkdirSync(OUT, { recursive: true });

const GENS = [
  { n: 0, hue: '#d4a017', sub: 'FOUNDER', glow: 'rgba(212,160,23,0.35)' },
  { n: 1, hue: '#3ddc84', sub: 'FIRSTBORN', glow: 'rgba(61,220,132,0.35)' },
  { n: 2, hue: '#4f8ef7', sub: 'SECOND LINE', glow: 'rgba(79,142,247,0.35)' },
  { n: 3, hue: '#a06bff', sub: 'THIRD LINE', glow: 'rgba(160,107,255,0.35)' },
  { n: 4, hue: '#ff5a5a', sub: 'FOURTH LINE', glow: 'rgba(255,90,90,0.35)' },
  { n: 5, hue: '#2dd4bf', sub: 'FIFTH LINE', glow: 'rgba(45,212,191,0.35)' },
  { n: 6, hue: '#ff8c42', sub: 'SIXTH LINE', glow: 'rgba(255,140,66,0.35)' },
  { n: 7, hue: '#ff6fb5', sub: 'SEVENTH LINE', glow: 'rgba(255,111,181,0.35)' },
  { n: 8, hue: '#a3e635', sub: 'EIGHTH LINE', glow: 'rgba(163,230,53,0.35)' },
  { n: 9, hue: '#818cf8', sub: 'NINTH LINE', glow: 'rgba(129,140,248,0.35)' },
];

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function card({ n, label, hue, sub, glow }) {
  // One concentric ring per generation (gen 0 gets 1 ring), plus a row of
  // pips: filled dots = generation number, so the card reads at a glance.
  const rings = Array.from({ length: n + 1 }, (_, i) => {
    const r = 150 - i * 22;
    return `<circle cx="300" cy="330" r="${r}" fill="none" stroke="${hue}" stroke-opacity="${0.55 - i * 0.04}" stroke-width="2"/>`;
  }).join('');
  const pips = Array.from({ length: 10 }, (_, i) =>
    `<circle cx="${105 + i * 44}" cy="640" r="9" fill="${i < n ? hue : 'none'}" stroke="${hue}" stroke-width="2"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 750" width="600" height="750" role="img" aria-label="Genesis agent card, generation ${esc(label)}">
  <defs>
    <radialGradient id="g" cx="50%" cy="44%" r="65%">
      <stop offset="0%" stop-color="${glow}"/>
      <stop offset="100%" stop-color="#0b1020" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${hue}"/>
      <stop offset="100%" stop-color="#0b1020"/>
    </linearGradient>
  </defs>
  <rect width="600" height="750" fill="#0b1020"/>
  <rect width="600" height="750" fill="url(#g)"/>
  <rect x="14" y="14" width="572" height="722" rx="28" fill="none" stroke="url(#frame)" stroke-width="3"/>
  <text x="48" y="72" font-family="sans-serif" font-size="30" font-weight="bold" fill="#f5f0dc" letter-spacing="4">◆ GENESIS</text>
  <text x="552" y="72" font-family="sans-serif" font-size="20" fill="#9aa5b1" text-anchor="end" letter-spacing="2">NEAR TESTNET</text>
  <line x1="48" y1="92" x2="552" y2="92" stroke="${hue}" stroke-opacity="0.5" stroke-width="2"/>
  ${rings}
  <text x="300" y="360" font-family="sans-serif" font-size="150" font-weight="bold" text-anchor="middle" fill="${hue}">${esc(label)}</text>
  <text x="300" y="420" font-family="sans-serif" font-size="34" font-weight="bold" text-anchor="middle" fill="#f5f0dc" letter-spacing="6">GEN ${esc(label)}</text>
  <text x="300" y="462" font-family="sans-serif" font-size="24" text-anchor="middle" fill="#9aa5b1" letter-spacing="4">${esc(sub)}</text>
  ${pips}
  <text x="300" y="700" font-family="sans-serif" font-size="20" text-anchor="middle" fill="#9aa5b1" letter-spacing="2">Born, verified, paid — or gone.</text>
</svg>
`;
}

for (const g of GENS) {
  const file = path.join(OUT, `gen-${g.n}.svg`);
  fs.writeFileSync(file, card({ ...g, label: String(g.n) }));
  console.log('wrote', file);
}
const fallback = path.join(OUT, 'gen-x.svg');
fs.writeFileSync(fallback, card({ n: 10, label: 'X', hue: '#9aa5b1', sub: 'BEYOND THE NINTH LINE', glow: 'rgba(154,165,177,0.35)' }));
console.log('wrote', fallback);
