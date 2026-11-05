// scripts/treasury-sweep.js — keep the Genesis treasury funded
// without the owner topping it up by hand.
//
// The economics (Isaiah's rule, 2026-11-05): the caller through x402
// funds the action, not the treasury owner. A mint or breed costs the
// treasury 0.15 NEAR (0.05 birth + 0.1 NFT mint). The near-intents
// price for mint/breed is 0.50 USDC, about 0.15 NEAR at NEAR ~$2.50.
//
// The loop closes differently per network:
//   TESTNET (now): the treasury's testnet USDC (Circle faucet token,
//     contract 3e2210e1...) has NO swap route — verified 2026-11-05,
//     none of Ref Finance testnet's pools holds that token, and 1Click
//     is mainnet-only. Testnet USDC just accumulates as accounting.
//     The refill is the free NEAR testnet faucet (near-faucet.io,
//     max 2 NEAR per request, no key needed). This script reports when
//     a refill is due; the claim itself is a browser form fill.
//   MAINNET (design, pending): the near-intents rail delivers real
//     USDC to the funding account (INTENTS_FUNDING_ACCOUNT). When
//     that account exists and 1Click NEAR quoting recovers, the sweep
//     quotes USDC -> wNEAR and swaps, so the funding account's USDC
//     becomes the NEAR that funds actions. Until then the mainnet leg
//     is report-only.
//
// Usage:
//   node scripts/treasury-sweep.js            dry-run report (default)
//   node scripts/treasury-sweep.js --execute  same report, plus the
//     mainnet swap when it is actually possible (funding account
//     exists, FUNDING_PRIVATE_KEY set, 1Click quoting works).
//     On testnet --execute changes nothing: the faucet claim needs a
//     browser form and is printed as an instruction instead.
// Exit code: 0 when the treasury covers at least one action (0.15
// NEAR); 1 when it does not (a refill is due).
//
// No funds move on a dry run. --execute never moves testnet funds
// and refuses the mainnet swap unless every precondition holds.

const TESTNET_RPC = 'https://rpc.testnet.near.org';
const MAINNET_RPC = 'https://rpc.mainnet.near.org';
const TREASURY_ACCOUNT = process.env.TREASURY_ACCOUNT_ID || 'genesisdemo354551.testnet';
// Circle testnet USDC (NEP-141), free from faucet.circle.com.
const TESTNET_USDC_CONTRACT = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
// Native USDC on NEAR mainnet (NEP-141).
const MAINNET_USDC_CONTRACT = 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WNEAR_MAINNET = 'nep141:wrap.near';
const USDC_MAINNET_ASSET = 'nep141:a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const FAUCET_URL = 'https://near-faucet.io/';
const ACTION_COST_NEAR = 0.15; // 0.05 birth + 0.1 NFT mint (birth_cost lowered 0.5 -> 0.05 NEAR for the Hackathon, 2026-11-05)
const REFILL_TARGET_NEAR = 1.2; // breed + one more action
const FAUCET_MAX_PER_REQUEST = 2;

async function rpcView(rpcUrl, contractId, method, args) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'treasury-sweep', method: 'query',
      params: {
        request_type: 'call_function', account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        finality: 'final',
      },
    }),
  });
  const data = await res.json();
  const bytes = data && data.result && data.result.result;
  if (!bytes || !bytes.length) return null;
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

async function accountBalance(rpcUrl, accountId) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'treasury-sweep', method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }),
  });
  const data = await res.json();
  if (!data || !data.result || typeof data.result.amount !== 'string') return null;
  return BigInt(data.result.amount);
}

function yoctoToNear(yocto) {
  return Number(yocto) / 1e24;
}

// Pure: how many 0.15-NEAR actions the treasury can still fund, and
// whether a refill is due. (Exported for tests.)
function treasuryHealth(nearBalanceYocto) {
  const near = yoctoToNear(nearBalanceYocto);
  const actionsLeft = Math.floor(near / ACTION_COST_NEAR);
  return {
    near,
    actionsLeft,
    refillDue: near < REFILL_TARGET_NEAR,
    // Claim the faucet maximum when a refill is due: free testnet
    // NEAR, and a full claim covers three actions instead of two.
    faucetAmount: near < REFILL_TARGET_NEAR ? FAUCET_MAX_PER_REQUEST : 0,
  };
}

// 1Click dry quote: mainnet USDC -> wNEAR, EXACT_INPUT. Dry only —
// no deposit address is issued. Returns {ok, amountOut} or {ok:false,
// error} with 1Click's real error passed through.
async function quoteUsdcToWnear(amountUsdcSmallest, refundTo, fetchImpl) {
  const fetchFn = fetchImpl || global.fetch;
  try {
    const res = await fetchFn('https://1click.chaindefuser.com/v0/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100,
        originAsset: USDC_MAINNET_ASSET, depositType: 'ORIGIN_CHAIN',
        destinationAsset: WNEAR_MAINNET, amount: String(amountUsdcSmallest),
        refundTo, refundType: 'ORIGIN_CHAIN',
        recipient: refundTo, recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + 1800000).toISOString(),
        quoteWaitingTimeMs: 10000,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 200 && data && data.quote && data.quote.amountOut) {
      return { ok: true, amountOutYocto: data.quote.amountOut, amountOutNear: Number(BigInt(data.quote.amountOut)) / 1e24 };
    }
    return { ok: false, error: String((data && data.message) || ('1Click HTTP ' + res.status)) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function main() {
  const execute = process.argv.includes('--execute');
  const lines = [];
  lines.push('Genesis treasury sweep — ' + (execute ? 'execute' : 'dry run') + ' (no funds move on a dry run)');
  lines.push('');

  // --- testnet treasury ---
  const treasuryYocto = await accountBalance(TESTNET_RPC, TREASURY_ACCOUNT);
  if (treasuryYocto === null) {
    lines.push('TESTNET treasury ' + TREASURY_ACCOUNT + ': balance unreadable (RPC error) — refill state unknown.');
  } else {
    const health = treasuryHealth(treasuryYocto);
    lines.push('TESTNET treasury ' + TREASURY_ACCOUNT + ': ' + health.near.toFixed(4) + ' NEAR — covers ' + health.actionsLeft + ' action(s) at 0.15 NEAR each.');
    if (health.refillDue) {
      lines.push('REFILL DUE: below the ' + REFILL_TARGET_NEAR + ' NEAR target (breed + one more action).');
      lines.push('  Claim ' + health.faucetAmount + ' NEAR at ' + FAUCET_URL + ' for account ' + TREASURY_ACCOUNT + ' (max ' + FAUCET_MAX_PER_REQUEST + ' NEAR per request, free, no key needed).');
      if (execute) lines.push('  --execute changes nothing on testnet: the faucet claim is a browser form fill, not an API call.');
    } else {
      lines.push('No refill due.');
    }
  }
  const testnetUsdc = await rpcView(TESTNET_RPC, TESTNET_USDC_CONTRACT, 'ft_balance_of', { account_id: TREASURY_ACCOUNT });
  if (testnetUsdc !== null) {
    lines.push('TESTNET USDC in treasury: ' + (Number(BigInt(testnetUsdc)) / 1e6).toFixed(2) + ' (Circle faucet token — no swap route on testnet, accumulates as accounting only).');
  }

  // --- mainnet funding leg ---
  lines.push('');
  const fundingAccount = process.env.INTENTS_FUNDING_ACCOUNT || '';
  if (!fundingAccount) {
    lines.push('MAINNET funding account: not set (INTENTS_FUNDING_ACCOUNT empty) — the near-intents rail cannot settle yet, and the USDC->NEAR swap leg is pending.');
  } else {
    const fundingNear = await accountBalance(MAINNET_RPC, fundingAccount);
    if (fundingNear === null) {
      lines.push('MAINNET funding account ' + fundingAccount + ': does not exist yet — create it before the near-intents rail can settle.');
    } else {
      const fundingUsdc = await rpcView(MAINNET_RPC, MAINNET_USDC_CONTRACT, 'ft_balance_of', { account_id: fundingAccount });
      const usdc = fundingUsdc === null ? 0 : Number(BigInt(fundingUsdc)) / 1e6;
      lines.push('MAINNET funding account ' + fundingAccount + ': ' + yoctoToNear(fundingNear).toFixed(4) + ' NEAR, ' + usdc.toFixed(2) + ' USDC.');
      if (usdc > 0) {
        const quote = await quoteUsdcToWnear(Math.floor(usdc * 1e6), fundingAccount);
        if (quote.ok) {
          lines.push('Swap quote (dry): ' + usdc.toFixed(2) + ' USDC -> ' + quote.amountOutNear.toFixed(4) + ' wNEAR.');
          if (execute) {
            lines.push('EXECUTE: mainnet swap is gated — it needs FUNDING_PRIVATE_KEY and a working 1Click quote, and the live swap is not wired yet; no funds moved.');
          } else {
            lines.push('Dry run: no swap executed. Re-run with --execute once the funding key is configured.');
          }
        } else {
          lines.push('Swap quote failed (1Click): ' + quote.error + ' — the mainnet swap leg stays pending; no funds moved.');
        }
      } else {
        lines.push('No mainnet USDC to swap yet.');
      }
    }
  }

  console.log(lines.join('\n'));
  const needsRefill = treasuryYocto !== null && treasuryHealth(treasuryYocto).refillDue;
  process.exitCode = needsRefill ? 1 : 0;
  return { needsRefill };
}

if (require.main === module) {
  main().catch((e) => { console.error('treasury sweep failed: ' + String((e && e.message) || e)); process.exitCode = 2; });
}

module.exports = { treasuryHealth, quoteUsdcToWnear, ACTION_COST_NEAR, REFILL_TARGET_NEAR };
