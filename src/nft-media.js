// Per-generation NFT card image URL for Genesis mints.
// Cards live at https://genesis-roan-eta.vercel.app/nft/gen-N.svg (gen 0-9)
// and gen-x.svg for gen 10+. Every new mint sets `media` to its
// generation's card, so each generation's NFT looks different.
// Token metadata on the shared contract is immutable: this only affects
// new mints, never tokens already minted.
const SITE = 'https://genesis-roan-eta.vercel.app';
function mediaForGen(gen) {
  const n = parseInt(gen, 10);
  if (Number.isInteger(n) && n >= 0 && n <= 9) return `${SITE}/nft/gen-${n}.svg`;
  return `${SITE}/nft/gen-x.svg`;
}
module.exports = { mediaForGen, NFT_CARDS_SITE: SITE };
