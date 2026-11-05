// GET /api/intents-status — poll a NEAR Intents 1Click swap's status.
//
// Query: ?depositAddress=<address from a live quote>&token_id=<agent>
// Polls GET /v0/status?depositAddress= on 1Click and returns the
// terminal state when reached: SUCCESS, REFUNDED or FAILED, with the
// origin/destination explorer links 1Click provides.
//
// On SUCCESS the funding is recorded in the server-side funding log
// (demo/intents-funding.json, best-effort — Vercel's filesystem is
// read-only at runtime, so the durable record is the 1Click status +
// the mainnet explorer link returned here; the committed log file is
// updated by the project owner after a real funding). The response
// always carries enough for the site to show the budget and the proof
// link without relying on the log file.
//
// No funds move here — this route only reads status. No JWT is needed
// for status, so no secret is used.
const fs = require('fs');
const path = require('path');

const ONECLICK_BASE = 'https://1click.chaindefuser.com';
const FUNDING_LOG = path.join(__dirname, '..', 'demo', 'intents-funding.json');
// 1Click can hang when solvers are slow (seen live 2026-11-05).
const FETCH_TIMEOUT_MS = 20000;

function fetchWithTimeout(fetchImpl, url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const promise = fetchImpl(url, { ...opts, signal: controller.signal });
  return promise.finally(() => clearTimeout(timer));
}

function readFundingLog() {
  try {
    const raw = fs.readFileSync(FUNDING_LOG, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.fundings) ? parsed : { fundings: [] };
  } catch (_) {
    return { fundings: [] };
  }
}

function appendFundingLog(entry) {
  // Best-effort only: on Vercel this write fails silently (read-only
  // filesystem) and the caller still gets the record in the response.
  try {
    const log = readFundingLog();
    if (log.fundings.some((f) => f.depositAddress === entry.depositAddress)) return false;
    log.fundings.push(entry);
    fs.writeFileSync(FUNDING_LOG, JSON.stringify(log, null, 2) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

async function fetchStatus(depositAddress, fetchImpl) {
  const url = ONECLICK_BASE + '/v0/status?depositAddress=' + encodeURIComponent(depositAddress);
  const res = await fetchWithTimeout(fetchImpl, url, { method: 'GET' });
  if (!res.ok) throw new Error('1Click status unavailable (HTTP ' + res.status + ')');
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const depositAddress = String((req.query && req.query.depositAddress) || '').trim();
  const tokenId = String((req.query && req.query.token_id) || '').trim();
  if (!depositAddress) {
    return res.status(400).json({ ok: false, error: 'depositAddress is required (from a live quote)' });
  }
  if (tokenId && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(tokenId)) {
    return res.status(400).json({ ok: false, error: 'token_id is not a valid agent token id' });
  }
  const fetchImpl = (global.fetch || require('node-fetch'));
  let data;
  try {
    data = await fetchStatus(depositAddress, fetchImpl);
  } catch (e) {
    const msg = String(e && e.name) === 'AbortError'
      ? 'the status request timed out (1Click is slow right now)'
      : String((e && e.message) || e);
    return res.status(502).json({ ok: false, error: 'NEAR Intents is unavailable right now — ' + msg });
  }
  // 1Click's status shape: { status, ... } with origin/destination
  // explorer links under various keys depending on the swap. Pass the
  // whole payload through so the site can show whatever is present.
  const status = String((data && data.status) || (data && data.swap && data.swap.status) || 'UNKNOWN').toUpperCase();
  const out = {
    ok: true,
    status,
    depositAddress,
    token_id: tokenId || null,
    raw: data,
  };
  if (status === 'SUCCESS') {
    const entry = {
      token_id: tokenId || null,
      depositAddress,
      status: 'SUCCESS',
      amountOut: (data && data.amountOut) || null,
      amountOutFormatted: (data && data.amountOutFormatted) || null,
      destinationTxHash: (data && data.destinationTxHash) || (data && data.txHash) || null,
      recordedAt: new Date().toISOString(),
    };
    out.funding = entry;
    out.logAppended = appendFundingLog(entry);
    out.note = 'Swap succeeded. The wNEAR was delivered to the Genesis mainnet funding account — see the explorer link in the status payload. This funds the agent\'s mainnet inference budget.';
  } else if (status === 'REFUNDED' || status === 'FAILED') {
    out.note = 'Swap did not complete. 1Click refunds to the refundTo address automatically by the deadline; Genesis never holds the funds, so there is nothing for Genesis to refund.';
  } else {
    out.note = 'Swap is still in progress. Keep polling every ~15 seconds.';
  }
  return res.status(200).json(out);
};

module.exports._test = { readFundingLog, appendFundingLog };
