// GET /api/nft-card?gen=<0-9|x> — serve a Genesis generation card image.
//
// Why an API route instead of a static file: GitHub's push flow carries
// UTF-8 text only, so the binary card JPEGs cannot be pushed to the repo.
// The cards ship as base64 in nft/cards.json (written by
// scripts/gen-nft-cards-3d.py) and this route decodes and serves them as
// real image/jpeg bytes — a plain picture of 3D art, not a 3D model file,
// so every wallet displays it. The cards never change, so the response
// is cached immutably.
const cards = require('../nft/cards.json');

module.exports = (req, res) => {
  const gen = String((req.query && req.query.gen) || '').toLowerCase();
  const b64 = cards[gen];
  if (typeof b64 !== 'string') {
    return res.status(400).json({ ok: false, error: 'gen must be 0-9 or x' });
  }
  const buf = Buffer.from(b64, 'base64');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.status(200).send(buf);
};
