// Ghost Burner core: scan, classify, batch, simulate, audit, send.
// Pure ESM, no DOM — used by the web UI and by the Node devnet test harness.
import {
  PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  createCloseAccountInstruction, createBurnCheckedInstruction,
} from '@solana/spl-token';
import {
  TOKEN_METADATA_PROGRAM_ID, TokenStandard, metadataPda, editionPda, parseMetadata, editionKind,
  createBurnNftV1Instruction,
} from './metaplex.js';
import { validateReferrer } from './referral.js';

export const TX_SIZE_LIMIT = 1232;
export const BASE_FEE_PER_SIGNATURE = 5000;
const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId;
const MAX_CU = 1_400_000;

// Token-2022 account extensions that do not interfere with burn + close by the owner.
const SAFE_ACCOUNT_EXTENSIONS = new Set([
  'immutableOwner', 'transferFeeAmount', 'memoTransfer', 'cpiGuard',
  'nonTransferableAccount', 'transferHookAccount', 'pausableAccount',
]);

export const lamportsToSol = (l, dp = 6) => (Number(l) / 1e9).toFixed(dp);

// ── Fee config ───────────────────────────────────────────────────────────────
export function isFeeWalletSet(addr) {
  if (!addr || typeof addr !== 'string' || /REPLACE|PLACEHOLDER|YOUR_/i.test(addr)) return false;
  try { new PublicKey(addr); return true; } catch { return false; }
}

// Fee = one or more legs, each { label, address, bps }. Legs with a placeholder /
// empty address or 0 bps are dropped; a malformed address, duplicate address or a
// total above maxFeeBps is a config error. Legacy {feeWallet, feeBps} still works.
//
// Referral: `referral = { referrer, bps, from, minLamports }`. With a valid referrer
// (see validateReferrer), `bps` is carved out of the leg whose address is `from`
// (the treasury): that leg keeps the rest, the total fee is unchanged, and a
// "Referrer" leg is appended. An invalid / self / fee-recipient referrer is ignored.
export function normalizeFee({ recipients, feeWallet, feeBps, maxFeeBps = 2000, owner, referral = null } = {}) {
  if (!recipients) recipients = [{ label: 'Fee', address: feeWallet, bps: feeBps }];
  const legs = [], disabledLegs = [], seen = new Set();
  let declared = 0;
  for (const r of recipients) {
    const bps = Number(r.bps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error(`fee leg "${r.label}": bps must be an integer 0..10000`);
    declared += bps;
    if (!isFeeWalletSet(r.address)) {
      if (r.address && !/REPLACE|PLACEHOLDER|YOUR_/i.test(r.address)) throw new Error(`fee leg "${r.label}": invalid address`);
      disabledLegs.push({ label: r.label, bps, reason: 'address not set' }); continue;
    }
    if (bps === 0) { disabledLegs.push({ label: r.label, bps, reason: '0 bps' }); continue; }
    const wallet = new PublicKey(r.address);
    if (seen.has(wallet.toBase58())) throw new Error(`fee leg "${r.label}": duplicate recipient`);
    seen.add(wallet.toBase58());
    if (owner && wallet.equals(new PublicKey(owner))) { disabledLegs.push({ label: r.label, bps, reason: 'connected wallet is this recipient' }); continue; }
    legs.push({ label: String(r.label || 'Fee'), wallet, bps });
  }
  if (declared > maxFeeBps) throw new Error(`total fee ${declared} bps exceeds the cap of ${maxFeeBps} bps`);
  let referrer = null, referralRejected = null;
  if (referral?.referrer) {
    const v = validateReferrer(referral.referrer, { owner, exclude: recipients.map((r) => r.address).filter(isFeeWalletSet) });
    const src = v.ok ? legs.find((l) => l.wallet.toBase58() === referral.from) : null;
    const rbps = Number(referral.bps);
    if (!v.ok) referralRejected = v.reason;
    else if (!src) referralRejected = 'referral source leg is not active';
    else if (!Number.isInteger(rbps) || rbps <= 0 || rbps > src.bps) throw new Error(`referral bps must be an integer 1..${src.bps}`);
    else {
      src.poolBps = src.bps; src.bps -= rbps;
      referrer = new PublicKey(v.address);
      legs.push({ label: 'Referrer', wallet: referrer, bps: rbps, referral: true, from: src.wallet, minLamports: Math.max(0, Number(referral.minLamports) || 0) });
    }
  }
  const bps = legs.reduce((a, l) => a + l.bps, 0);
  return { enabled: legs.length > 0, legs, bps, declaredBps: declared, disabledLegs, wallet: legs[0]?.wallet || null, referrer, referralRejected };
}

export const feeFor = (reclaimLamports, bps) => Math.floor((Number(reclaimLamports) * bps) / 10000);

// Wanted lamports per leg (same order as fee.legs). The referrer gets
// floor(reclaim*refBps/1e4) and its source leg gets floor(reclaim*poolBps/1e4)
// minus that, so source + referrer always equals the no-referral amount exactly
// and the total fee never changes because of a referral.
export function legAmounts(reclaimLamports, fee) {
  const legs = fee?.enabled ? fee.legs : [];
  const out = legs.map((l) => feeFor(reclaimLamports, l.bps));
  legs.forEach((l, i) => {
    if (!l.referral) return;
    const si = legs.findIndex((x) => x.wallet.equals(l.from));
    out[i] = feeFor(reclaimLamports, l.bps);
    out[si] = feeFor(reclaimLamports, legs[si].poolBps ?? legs[si].bps) - out[i];
  });
  return out;
}
export const totalFeeFor = (reclaimLamports, fee) => legAmounts(reclaimLamports, fee).reduce((a, b) => a + b, 0);

// Decide what each leg actually transfers, given on-chain recipient state.
// legState[i] = { lamports, minRent, unusable }. Pure, unit-tested.
//  1. Referrer leg: redirected to its source leg (treasury) when below the dust
//     threshold, when the recipient would end up below its rent-exempt minimum
//     (e.g. a brand-new wallet receiving < ~890,880 lamports), when the account is
//     not a plain system wallet, or when forced (simulation fallback).
//  2. Any other leg that would leave its recipient below rent-exempt is waived.
export function planLegs(reclaimLamports, fee, legState, { forceRedirect = false } = {}) {
  const src = fee?.enabled ? fee.legs : [];
  const wants = legAmounts(reclaimLamports, fee);
  const legs = src.map((l, i) => ({ label: l.label, wallet: l.wallet.toBase58(), bps: l.bps, capBps: l.poolBps ?? l.bps, referral: !!l.referral, wantLamports: wants[i], lamports: wants[i], waived: false, redirected: false, redirectedLamports: 0, note: null }));
  src.forEach((l, i) => {
    const leg = legs[i];
    if (!l.referral || leg.lamports <= 0) return;
    const st = legState[i] || { lamports: 0, minRent: 0 };
    let why = null;
    if (forceRedirect) why = 'referrer transfer failed in simulation';
    else if (st.unusable) why = st.unusable;
    else if (leg.lamports < (l.minLamports || 0)) why = `below the ${l.minLamports}-lamport minimum referral payout`;
    else if (st.lamports + leg.lamports < st.minRent) why = `a new wallet needs at least ${st.minRent - st.lamports} lamports to exist (rent-exempt minimum)`;
    if (!why) return;
    const si = src.findIndex((x) => x.wallet.equals(l.from));
    legs[si].lamports += leg.lamports; legs[si].wantLamports += leg.lamports;
    leg.redirected = true; leg.redirectedLamports = leg.lamports; leg.lamports = 0;
    leg.note = `sent to ${legs[si].label} instead: ${why}`;
  });
  legs.forEach((leg, i) => {
    if (leg.referral) return;
    const st = legState[i] || { lamports: 0, minRent: 0 };
    if (leg.lamports > 0 && st.lamports + leg.lamports < st.minRent) { leg.lamports = 0; leg.waived = true; leg.note = `recipient needs ${st.minRent - st.lamports} more lamports to be rent-exempt`; }
  });
  return legs;
}

// ── Scan ─────────────────────────────────────────────────────────────────────
async function getMultiple(connection, keys, commitment) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), commitment)));
  return out;
}

// Token accounts via getTokenAccountsByOwner; if every RPC refuses it (keyless public
// RPCs block indexed methods), get the account LIST from an index (Jupiter holdings)
// and re-read every listed account on-chain, keeping only real token accounts owned
// by this wallet. Balances and state always come from the chain, never the index.
async function listTokenAccounts(connection, owner, commitment, holdingsApi, fetchFn) {
  try {
    const res = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(
      (programId) => connection.getParsedTokenAccountsByOwner(owner, { programId }, commitment)));
    return { source: 'rpc', lists: res.map((r) => r.value) };
  } catch (e) {
    if (!holdingsApi) throw e;
    const r = await fetchFn(holdingsApi + owner.toBase58(), { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error(`token account lookup failed (RPC: ${e?.message || e}; index HTTP ${r.status})`);
    const h = await r.json();
    const addrs = [...new Set(Object.values(h.tokens || {}).flat().map((a) => a.account).filter(Boolean))];
    const lists = [[], []];
    for (let i = 0; i < addrs.length; i += 100) {
      const chunk = addrs.slice(i, i + 100).map((a) => new PublicKey(a));
      const got = await connection.getMultipleParsedAccounts(chunk, { commitment });
      got.value.forEach((account, j) => {
        if (!account) return;
        const li = account.owner.equals(TOKEN_PROGRAM_ID) ? 0 : account.owner.equals(TOKEN_2022_PROGRAM_ID) ? 1 : -1;
        const info = account.data?.parsed?.info;
        if (li < 0 || account.data?.parsed?.type !== 'account' || info?.owner !== owner.toBase58()) return;
        lists[li].push({ pubkey: chunk[j], account });
      });
    }
    return { source: 'index', lists, rpcError: String(e?.message || e) };
  }
}

export async function scanWallet(connection, ownerIn, { commitment = 'confirmed', holdingsApi = null, fetchFn = (...a) => fetch(...a) } = {}) {
  const owner = new PublicKey(ownerIn);
  const { source, lists: [legacyList, t22List], rpcError } = await listTokenAccounts(connection, owner, commitment, holdingsApi, fetchFn);
  const legacy = { value: legacyList }, t22 = { value: t22List };

  const items = [];
  for (const [res, programId] of [[legacy, TOKEN_PROGRAM_ID], [t22, TOKEN_2022_PROGRAM_ID]]) {
    for (const { pubkey, account } of res.value) {
      const info = account.data?.parsed?.info;
      if (!info || account.data?.parsed?.type !== 'account') continue;
      const exts = info.extensions || [];
      const withheld = BigInt(exts.find((e) => e.extension === 'transferFeeAmount')?.state?.withheldAmount ?? 0);
      items.push({
        id: pubkey.toBase58(), address: pubkey, programId,
        program: programId.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'token',
        mint: info.mint, owner: info.owner,
        amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals,
        uiAmount: info.tokenAmount.uiAmountString,
        lamports: account.lamports, frozen: info.state === 'frozen',
        isNative: !!info.isNative || info.mint === NATIVE_MINT.toBase58(),
        closeAuthority: info.closeAuthority || null, delegate: info.delegate || null,
        extensions: exts.map((e) => e.extension), withheld,
        meta: { name: null, symbol: null, uri: null, image: null, source: null },
        metaplex: null,
      });
    }
  }

  // On-chain metadata: Metaplex Metadata PDA for every mint.
  const mints = [...new Set(items.map((i) => i.mint))];
  const mdKeys = mints.map((m) => metadataPda(m));
  const mdInfos = await getMultiple(connection, mdKeys, commitment);
  const mdByMint = new Map();
  mints.forEach((m, i) => {
    const acc = mdInfos[i];
    if (acc && acc.owner.equals(TOKEN_METADATA_PROGRAM_ID)) {
      const md = parseMetadata(acc.data);
      if (md) mdByMint.set(m, { ...md, address: mdKeys[i], lamports: acc.lamports, dataLen: acc.data.length });
    }
  });

  // Token-2022 metadata extension on the mint.
  const t22Mints = [...new Set(items.filter((i) => i.program === 'token-2022').map((i) => i.mint))];
  const t22MintMeta = new Map();
  for (let i = 0; i < t22Mints.length; i += 100) {
    const chunk = t22Mints.slice(i, i + 100);
    const r = await connection.getMultipleParsedAccounts(chunk.map((m) => new PublicKey(m)), { commitment });
    r.value.forEach((acc, j) => {
      const ext = acc?.data?.parsed?.info?.extensions?.find((e) => e.extension === 'tokenMetadata');
      if (ext?.state) t22MintMeta.set(chunk[j], ext.state);
    });
  }

  // Editions for NFT candidates (legacy Token program, decimals 0, amount 1, has Metaplex metadata).
  const nftCands = items.filter((i) => i.program === 'token' && i.decimals === 0 && i.amount === 1n && mdByMint.has(i.mint));
  const edKeys = nftCands.map((i) => editionPda(i.mint));
  const edInfos = await getMultiple(connection, edKeys, commitment);
  const edByMint = new Map();
  nftCands.forEach((it, i) => {
    const acc = edInfos[i];
    if (acc && acc.owner.equals(TOKEN_METADATA_PROGRAM_ID)) edByMint.set(it.mint, { address: edKeys[i], kind: editionKind(acc.data), lamports: acc.lamports });
  });

  // Metadata accounts can hold Metaplex protocol fees that are NOT refunded on burn,
  // so estimate the refundable part as the rent-exempt minimum (simulation gives the exact figure).
  const lens = [...new Set([...mdByMint.values()].map((m) => m.dataLen))];
  const rentByLen = new Map(await Promise.all(lens.map(async (l) => [l, await connection.getMinimumBalanceForRentExemption(l, commitment)])));
  for (const md of mdByMint.values()) md.refundable = Math.min(md.lamports, rentByLen.get(md.dataLen) ?? md.lamports);

  for (const it of items) {
    const md = mdByMint.get(it.mint);
    const tm = t22MintMeta.get(it.mint);
    if (md) it.meta = { name: md.name || null, symbol: md.symbol || null, uri: md.uri || null, image: null, source: 'metaplex' };
    else if (tm) it.meta = { name: tm.name || null, symbol: tm.symbol || null, uri: tm.uri || null, image: null, source: 'token-2022' };
    if (md) it.metaplex = { tokenStandard: md.tokenStandard, collection: md.collection ? { verified: md.collection.verified, key: md.collection.key.toBase58() } : null, metadataLamports: md.refundable, edition: edByMint.get(it.mint) || null };
    classify(it, owner);
  }
  items.sort((a, b) => rank(a) - rank(b));
  items.source = source; items.rpcError = rpcError || null;
  return items;
}

const rank = (i) => (i.blocked ? 3 : i.kind === 'empty' ? 0 : i.kind === 'nft' ? 2 : 1);

export function classify(it, owner) {
  it.blocked = null; it.kind = null; it.action = null;
  const ts = it.metaplex?.tokenStandard;
  const unsafeExt = it.extensions.filter((e) => !SAFE_ACCOUNT_EXTENSIONS.has(e));
  if (it.isNative) it.blocked = 'Wrapped SOL (wSOL): unwrap it in your wallet instead';
  else if (ts === TokenStandard.ProgrammableNonFungible || ts === TokenStandard.ProgrammableNonFungibleEdition) it.blocked = 'Programmable NFT (pNFT): not supported in v1';
  else if (it.frozen) it.blocked = 'Frozen by the token issuer';
  else if (it.owner && it.owner !== owner.toBase58()) it.blocked = 'Account owner is not the connected wallet';
  else if (it.closeAuthority && it.closeAuthority !== owner.toBase58()) it.blocked = 'Close authority belongs to another address';
  else if (it.withheld > 0n) it.blocked = 'Has withheld Token-2022 transfer fees';
  else if (unsafeExt.length) it.blocked = `Unsupported Token-2022 extension: ${unsafeExt.join(', ')}`;
  if (it.blocked) { it.kind = it.amount === 0n ? 'empty' : 'token'; it.estReclaimLamports = 0; return it; }

  if (it.amount === 0n) { it.kind = 'empty'; it.action = 'close'; it.estReclaimLamports = it.lamports; return it; }

  if (it.metaplex && it.program === 'token' && it.decimals === 0 && it.amount === 1n &&
      (ts === null || ts === TokenStandard.NonFungible || ts === TokenStandard.NonFungibleEdition)) {
    const ed = it.metaplex.edition;
    if (ed?.kind === 'master' && ts !== TokenStandard.NonFungibleEdition) {
      it.kind = 'nft'; it.action = 'burn-nft';
      it.estReclaimLamports = it.lamports + it.metaplex.metadataLamports + ed.lamports;
      return it;
    }
    if (ed?.kind === 'print' || ts === TokenStandard.NonFungibleEdition) { it.kind = 'nft'; it.blocked = 'Print-edition NFT: not supported in v1'; it.estReclaimLamports = 0; return it; }
  }
  it.kind = 'token'; it.action = 'burn-close'; it.estReclaimLamports = it.lamports;
  return it;
}

// ── Instructions & batching ──────────────────────────────────────────────────
export function instructionsFor(it, ownerIn) {
  const owner = new PublicKey(ownerIn);
  if (it.blocked || !it.action) throw new Error(`Account ${it.id} is not actionable: ${it.blocked || 'no action'}`);
  const acct = new PublicKey(it.id);
  const pid = new PublicKey(it.programId);
  switch (it.action) {
    case 'close':
      if (it.amount !== 0n) throw new Error('close requires a zero balance');
      return [createCloseAccountInstruction(acct, owner, owner, [], pid)];
    case 'burn-close':
      return [
        createBurnCheckedInstruction(acct, new PublicKey(it.mint), owner, it.amount, it.decimals, [], pid),
        createCloseAccountInstruction(acct, owner, owner, [], pid),
      ];
    case 'burn-nft': {
      const col = it.metaplex?.collection;
      return [createBurnNftV1Instruction({ owner, mint: it.mint, tokenAccount: acct, collectionMint: col?.verified ? col.key : null })];
    }
    default: throw new Error('unknown action');
  }
}

const computeIxs = (units, microLamports) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ...(microLamports > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })] : []),
];

export const networkFee = (units, microLamports) => BASE_FEE_PER_SIGNATURE + Math.ceil((units * microLamports) / 1e6);

function compile(owner, blockhash, instructions) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message());
}

export function batchItems(items, ownerIn, { fee, priorityMicroLamports = 0, maxActionsPerTx = 10 }) {
  const owner = new PublicKey(ownerIn);
  const dummyHash = PublicKey.default.toBase58();
  const feeIx = (fee?.legs || []).map((l) => SystemProgram.transfer({ fromPubkey: owner, toPubkey: l.wallet, lamports: 1_000_000 }));
  const batches = [];
  let cur = { items: [], ixs: [] };
  const fits = (ixs) => {
    try { return compile(owner, dummyHash, [...computeIxs(MAX_CU, priorityMicroLamports), ...ixs, ...feeIx]).serialize().length <= TX_SIZE_LIMIT; }
    catch { return false; } // web3.js throws when the message overruns the packet buffer
  };
  for (const it of items) {
    const ixs = instructionsFor(it, owner);
    const next = [...cur.ixs, ...ixs];
    if (cur.items.length < maxActionsPerTx && fits(next)) { cur.items.push(it); cur.ixs = next; continue; }
    if (!cur.items.length) throw new Error(`Account ${it.id} does not fit in a single transaction`);
    batches.push(cur);
    if (!fits(ixs)) throw new Error(`Account ${it.id} does not fit in a single transaction`);
    cur = { items: [it], ixs: [...ixs] };
  }
  if (cur.items.length) batches.push(cur);
  return batches;
}

// ── Simulation ───────────────────────────────────────────────────────────────
export class SimulationError extends Error {
  constructor(msg, logs) { super(msg); this.name = 'SimulationError'; this.logs = logs || []; }
}

async function simulate(connection, owner, tx, commitment) {
  const r = await connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true, commitment,
    accounts: { encoding: 'base64', addresses: [owner.toBase58()] },
  });
  const v = r.value;
  if (v.err) throw new SimulationError(`Simulation failed: ${JSON.stringify(v.err)}`, v.logs);
  return { postLamports: v.accounts?.[0]?.lamports ?? null, units: v.unitsConsumed ?? MAX_CU, logs: v.logs || [] };
}

// Build, simulate (twice: draft to measure, final to verify) and return
// ready-to-sign transactions plus exact per-transaction accounting.
export async function prepareTransactions({ connection, owner: ownerIn, items, fee, priorityMicroLamports = 0, maxActionsPerTx = 10, commitment = 'confirmed' }) {
  const owner = new PublicKey(ownerIn);
  if (!items.length) throw new Error('Nothing selected');
  const ids = new Set();
  for (const it of items) { if (ids.has(it.id)) throw new Error('duplicate account'); ids.add(it.id); }
  const batches = batchItems(items, owner, { fee, priorityMicroLamports, maxActionsPerTx });
  // Solana charges the network fee up front, before any rent is refunded, so the wallet needs a tiny SOL balance.
  const needed = networkFee(MAX_CU, priorityMicroLamports);
  const have = await connection.getBalance(owner, commitment);
  if (have < needed) { const e = new Error(`Your wallet has ${lamportsToSol(have, 9)} SOL. Solana takes the network fee (up to ${lamportsToSol(needed, 9)} SOL) before the rent is refunded, so add a little SOL (0.0001 SOL is plenty) and try again. Nothing was sent.`); e.code = 'NO_SOL_FOR_FEE'; throw e; }

  // Rent-exempt guard: a transfer that would leave a recipient below its
  // rent-exempt minimum fails the whole tx, so such a leg is waived instead.
  // A referrer must be a plain wallet (system-owned, not executable, or not created yet).
  const legState = [];
  if (fee.enabled) {
    const infos = await connection.getMultipleAccountsInfo(fee.legs.map((l) => l.wallet), commitment);
    for (let i = 0; i < fee.legs.length; i++) {
      const a = infos[i];
      const minRent = await connection.getMinimumBalanceForRentExemption(a?.data?.length || 0, commitment);
      const unusable = fee.legs[i].referral && a && (a.executable || !a.owner.equals(SystemProgram.programId)) ? 'referrer is not a plain wallet account' : null;
      legState.push({ lamports: a?.lamports || 0, minRent, unusable });
    }
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
  const pre = await connection.getBalance(owner, commitment);

  const buildLegs = (reclaim, opts) => planLegs(reclaim, fee, legState, opts);

  const transactions = [];
  for (const b of batches) {
    const draft = await simulate(connection, owner, compile(owner, blockhash, [...computeIxs(MAX_CU, priorityMicroLamports), ...b.ixs]), commitment);
    const expected = b.items.reduce((s, i) => s + i.estReclaimLamports, 0);
    const measured = draft.postLamports == null ? expected : draft.postLamports - pre + networkFee(MAX_CU, priorityMicroLamports);
    const reclaim = Math.max(0, Math.min(expected, measured)); // never charge on more than truly reclaimed
    const units = Math.min(MAX_CU, Math.ceil(draft.units * 1.2) + 3000 + 300 * fee.legs.length);
    const build = (legs) => compile(owner, blockhash, [...computeIxs(units, priorityMicroLamports), ...b.ixs,
      ...legs.filter((l) => l.lamports > 0).map((l) => SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(l.wallet), lamports: l.lamports }))]);
    let feeLegs = buildLegs(reclaim);
    let tx = build(feeLegs), fin;
    try { fin = await simulate(connection, owner, tx, commitment); }
    catch (e0) {
      let e = e0;
      // Safety net 1: if a referrer transfer is present, send that cut to the treasury instead.
      if (feeLegs.some((l) => l.referral && l.lamports > 0)) {
        feeLegs = buildLegs(reclaim, { forceRedirect: true });
        tx = build(feeLegs);
        try { fin = await simulate(connection, owner, tx, commitment); } catch (e1) { e = e1; }
      }
      if (!fin) {
        // Last-resort safety net: if only the fee transfers break the tx, waive them.
        if (!feeLegs.some((l) => l.lamports > 0)) throw e;
        feeLegs = feeLegs.map((l) => (l.lamports > 0 ? { ...l, lamports: 0, waived: true, note: "fee transfer failed in simulation" } : l));
        tx = build(feeLegs);
        fin = await simulate(connection, owner, tx, commitment);
      }
    }
    let size; try { size = tx.serialize().length; } catch { size = Infinity; }
    if (size > TX_SIZE_LIMIT) throw new Error(`transaction too large (${size} bytes)`);
    const feeLamports = feeLegs.reduce((a, l) => a + l.lamports, 0);
    const netFee = networkFee(units, priorityMicroLamports);
    const netLamports = reclaim - feeLamports - netFee;
    const simulatedNet = fin.postLamports == null ? null : fin.postLamports - pre;
    if (simulatedNet !== null && simulatedNet < netLamports) throw new SimulationError(`Simulation shows a lower payout than displayed (${simulatedNet} < ${netLamports} lamports). Aborting.`, fin.logs);
    const feeNote = feeLegs.some((l) => l.waived || l.redirected) ? feeLegs.filter((l) => l.waived || l.redirected).map((l) => `${l.label}: ${l.note}`).join('; ') : null;
    transactions.push({ tx, size, items: b.items, expectedReclaimLamports: expected, reclaimLamports: reclaim, feeLamports, feeLegs, feeNote, networkFeeLamports: netFee, netLamports, simulatedNetLamports: simulatedNet, units: fin.units, logs: fin.logs });
  }
  const sum = (k) => transactions.reduce((s, t) => s + t[k], 0);
  const totals = { reclaimLamports: sum('reclaimLamports'), feeLamports: sum('feeLamports'), networkFeeLamports: sum('networkFeeLamports'), netLamports: sum('netLamports'), txCount: transactions.length, accountCount: items.length };
  totals.feeLegs = (fee.legs || []).map((l) => {
    const w = l.wallet.toBase58(), mine = transactions.map((t) => t.feeLegs.find((x) => x.wallet === w));
    return { label: l.label, wallet: w, bps: l.bps, referral: !!l.referral, lamports: mine.reduce((a, x) => a + x.lamports, 0), waivedLamports: mine.reduce((a, x) => a + (x.waived ? x.wantLamports : 0), 0), waived: mine.some((x) => x.waived), redirectedLamports: mine.reduce((a, x) => a + (x.redirectedLamports || 0), 0), redirected: mine.some((x) => x.redirected), note: mine.find((x) => x.note)?.note || null };
  });
  const prepared = { owner: owner.toBase58(), blockhash, lastValidBlockHeight, fee: { enabled: fee.enabled, bps: fee.bps, referrer: fee.referrer ? fee.referrer.toBase58() : null, legs: fee.legs.map((l) => ({ label: l.label, wallet: l.wallet.toBase58(), bps: l.bps, capBps: l.poolBps ?? l.bps, referral: !!l.referral, from: l.from ? l.from.toBase58() : null })) }, transactions, totals };
  auditPrepared(prepared);
  return prepared;
}

// ── Audit: every instruction must be one we expect, nothing else. ────────────
function u32le(d, o = 0) { return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24); }
function u64le(d, o) { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; }

export function auditPrepared(prepared) {
  const owner = new PublicKey(prepared.owner);
  // Per-leg cap: a leg may receive up to its pool share (treasury may absorb a redirected referral cut).
  const legBps = new Map((prepared.fee.legs || []).map((l) => [l.wallet, l.capBps ?? l.bps]));
  const refLegs = (prepared.fee.legs || []).filter((l) => l.referral);
  let feeTotal = 0;
  for (const t of prepared.transactions) {
    const msg = t.tx.message;
    if (msg.addressTableLookups?.length) throw new Error('audit: lookup tables not expected');
    if (msg.header.numRequiredSignatures !== 1 || !msg.staticAccountKeys[0].equals(owner)) throw new Error('audit: owner must be the only signer and fee payer');
    const ixs = TransactionMessage.decompile(msg).instructions;
    const allowed = new Map(t.items.map((i) => [i.id, i]));
    let txFee = 0;
    const expectLegs = new Map((t.feeLegs || []).filter((l) => l.lamports > 0).map((l) => [l.wallet, l.lamports]));
    const paid = new Set();
    for (const ix of ixs) {
      const d = ix.data, p = ix.programId;
      if (p.equals(COMPUTE_BUDGET_ID)) { if (d[0] !== 2 && d[0] !== 3) throw new Error('audit: unexpected compute budget ix'); continue; }
      if (p.equals(TOKEN_PROGRAM_ID) || p.equals(TOKEN_2022_PROGRAM_ID)) {
        const acct = ix.keys[0].pubkey.toBase58();
        const it = allowed.get(acct);
        if (!it || !p.equals(new PublicKey(it.programId))) throw new Error(`audit: token ix touches unselected account ${acct}`);
        if (d[0] === 9) { // CloseAccount: [account, destination, authority]
          if (!ix.keys[1].pubkey.equals(owner) || !ix.keys[2].pubkey.equals(owner)) throw new Error('audit: close must refund to owner');
        } else if (d[0] === 15) { // BurnChecked: [account, mint, authority]
          if (it.action !== 'burn-close') throw new Error('audit: burn on non-burn item');
          if (!ix.keys[2].pubkey.equals(owner) || ix.keys[1].pubkey.toBase58() !== it.mint || u64le(d, 1) !== it.amount) throw new Error('audit: burn mismatch');
        } else throw new Error(`audit: unexpected token instruction ${d[0]}`);
        continue;
      }
      if (p.equals(TOKEN_METADATA_PROGRAM_ID)) {
        const acct = ix.keys[5].pubkey.toBase58();
        const it = allowed.get(acct);
        if (d[0] !== 41 || d[1] !== 0 || !it || it.action !== 'burn-nft' || !ix.keys[0].pubkey.equals(owner) || ix.keys[4].pubkey.toBase58() !== it.mint) throw new Error('audit: unexpected metadata instruction');
        continue;
      }
      if (p.equals(SystemProgram.programId)) {
        const to = ix.keys[1]?.pubkey.toBase58();
        if (u32le(d) !== 2 || !ix.keys[0].pubkey.equals(owner) || !expectLegs.has(to) || paid.has(to)) throw new Error('audit: unexpected system instruction');
        const amt = Number(u64le(d, 4));
        if (amt !== expectLegs.get(to)) throw new Error('audit: fee leg amount does not match displayed fee');
        if (amt > feeFor(t.reclaimLamports, legBps.get(to) ?? 0)) throw new Error('audit: fee leg exceeds its configured percentage');
        paid.add(to); txFee += amt;
        continue;
      }
      throw new Error(`audit: unexpected program ${p.toBase58()}`);
    }
    if (paid.size !== expectLegs.size || txFee !== t.feeLamports) throw new Error('audit: fee transfer does not match displayed fee');
    for (const r of refLegs) {
      const pool = (expectLegs.get(r.wallet) || 0) + (expectLegs.get(r.from) || 0);
      if (pool > feeFor(t.reclaimLamports, legBps.get(r.from) ?? 0)) throw new Error('audit: referrer + treasury exceed the treasury share');
      if ((expectLegs.get(r.wallet) || 0) > feeFor(t.reclaimLamports, r.bps)) throw new Error('audit: referrer leg exceeds its percentage');
    }
    if (txFee > feeFor(t.reclaimLamports, prepared.fee.bps)) throw new Error('audit: fee exceeds configured percentage');
    feeTotal += txFee;
  }
  if (feeTotal !== prepared.totals.feeLamports) throw new Error('audit: total fee mismatch');
  return true;
}

// Check what the wallet hands back before broadcasting: our instructions must
// be intact, owner signature present, and no extra transfers/token moves added.
export function auditSigned(original, signedBytes, ownerIn) {
  const owner = new PublicKey(ownerIn);
  const signed = VersionedTransaction.deserialize(signedBytes);
  if (!signed.message.staticAccountKeys[0].equals(owner)) throw new Error('signed tx: fee payer changed');
  if (!signed.signatures[0] || signed.signatures[0].every((b) => b === 0)) throw new Error('signed tx: missing owner signature');
  const a = original.message.serialize(), b = signed.message.serialize();
  if (a.length === b.length && a.every((x, i) => x === b[i])) return { modified: false, tx: signed };
  if (signed.message.addressTableLookups?.length) throw new Error('signed tx: wallet added lookup tables; refusing to send');
  const hex = (d) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
  const key = (ix) => ix.programId.toBase58() + '|' + ix.keys.map((k) => k.pubkey.toBase58()).join(',') + '|' + hex(ix.data);
  const orig = TransactionMessage.decompile(original.message).instructions.filter((ix) => !ix.programId.equals(COMPUTE_BUDGET_ID));
  const got = TransactionMessage.decompile(signed.message).instructions;
  const gotKeys = new Set(got.map(key));
  for (const ix of orig) if (!gotKeys.has(key(ix))) throw new Error('signed tx: wallet altered our instructions; refusing to send');
  const origKeys = new Set(orig.map(key));
  for (const ix of got) {
    if (origKeys.has(key(ix)) || ix.programId.equals(COMPUTE_BUDGET_ID)) continue;
    if ([SystemProgram.programId, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_METADATA_PROGRAM_ID].some((p) => p.equals(ix.programId)))
      throw new Error('signed tx: wallet added a transfer/token instruction; refusing to send');
  }
  return { modified: true, tx: signed };
}

export async function sendSigned(connection, signedBytes, { lastValidBlockHeight, commitment = 'confirmed', pollMs = 1500 }) {
  const signed = VersionedTransaction.deserialize(signedBytes);
  const signature = await connection.sendRawTransaction(signedBytes, { skipPreflight: false, preflightCommitment: commitment, maxRetries: 5 });
  // HTTP polling instead of websockets, so it works with any endpoint that has failed over.
  for (let n = 0; ; n++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const st = (await connection.getSignatureStatuses([signature])).value[0];
    if (st?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
    if (n % 4 === 3) {
      if ((await connection.getBlockHeight(commitment)) > lastValidBlockHeight) throw new Error(`Transaction ${signature} expired before confirming (blockhash too old). Nothing was charged if it never landed; rescan and retry.`);
      connection.sendRawTransaction(signedBytes, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
  }
}
