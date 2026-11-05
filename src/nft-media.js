// Per-generation NFT card image URL for Genesis mints.
// Cards are 3D-rendered JPEGs (a picture of 3D art, not a 3D model file,
// so every wallet displays them), served by /api/nft-card?gen=N (gen 0-9)
// and ?gen=x for gen 10+. The route decodes them from nft/cards.json:
// GitHub's push flow carries UTF-8 text only, so the binary JPEGs cannot
// be pushed to the repo. Every new mint sets `media` to its
// generation's card, so each generation's NFT looks different.
// Token metadata on the shared contract is immutable: this only affects
// new mints, never tokens already minted.
const SITE = 'https://genesis-roan-eta.vercel.app';
function mediaForGen(gen) {
  const n = parseInt(gen, 10);
  if (Number.isInteger(n) && n >= 0 && n <= 9) return `${SITE}/api/nft-card?gen=${n}`;
  return `${SITE}/api/nft-card?gen=x`;
}
module.exports = { mediaForGen, NFT_CARDS_SITE: SITE };
