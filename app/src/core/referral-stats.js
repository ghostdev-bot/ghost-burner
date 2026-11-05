// Best-effort referral earnings, read from chain. Pure ESM (browser + Node).
// A transaction counts as a Ghost Burner referral payout when ALL of these hold:
//  - it succeeded, and its fee payer (the burner) is not the referrer;
//  - it has a System transfer fee payer -> referrer;
//  - it also has a System transfer fee payer -> one of the Ghost Burner fee wallets;
//  - it closes at least one token account back to the fee payer, or burns a
//    Metaplex NFT (the burn itself).
// Anyone could copy that shape, so the result is an estimate, limited to the most
// recent `limit` transactions touching the referrer's address.
import { PublicKey } from '@solana/web3.js';

const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const SYSTEM = '11111111111111111111111111111111';

export function classifyReferralTx(tx, referrer, feeWallets) {
  if (!tx || tx.meta?.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (k.pubkey ? k.pubkey.toBase58() : String(k)));
  const payer = keys[0];
  if (payer === referrer) return null;
  let toRef = 0, toFee = 0, closes = 0, nftBurns = 0;
  for (const ix of tx.transaction.message.instructions) {
    const pid = ix.programId?.toBase58 ? ix.programId.toBase58() : String(ix.programId);
    const p = ix.parsed;
    if (pid === SYSTEM && p?.type === 'transfer' && p.info?.source === payer) {
      if (p.info.destination === referrer) toRef += Number(p.info.lamports);
      else if (feeWallets.includes(p.info.destination)) toFee += Number(p.info.lamports);
    } else if (TOKEN_PROGRAMS.has(pid) && p?.type === 'closeAccount' && p.info?.destination === payer) closes++;
    else if (pid === METADATA_PROGRAM) nftBurns++;
  }
  if (!toRef || !toFee || !(closes || nftBurns)) return null;
  return { signature: tx.transaction.signatures[0], blockTime: tx.blockTime ?? null, slot: tx.slot, burner: payer, lamports: toRef, closes, nftBurns };
}

export async function scanReferralEarnings(connection, referrerIn, { feeWallets, limit = 100, concurrency = 3, onProgress = () => {}, commitment = 'confirmed' } = {}) {
  const referrer = new PublicKey(referrerIn).toBase58();
  const sigs = (await connection.getSignaturesForAddress(new PublicKey(referrer), { limit }, commitment)).filter((s) => !s.err);
  const hits = []; let done = 0, failed = 0;
  const queue = [...sigs];
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      try {
        const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment });
        const r = classifyReferralTx(tx, referrer, feeWallets);
        if (r) hits.push(r);
      } catch { failed++; }
      onProgress(++done, sigs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sigs.length) }, worker));
  hits.sort((a, b) => (b.slot || 0) - (a.slot || 0));
  return {
    referrer, scanned: sigs.length, failed, limitReached: sigs.length >= limit,
    oldestScanned: sigs.length ? sigs[sigs.length - 1].blockTime ?? null : null,
    totalLamports: hits.reduce((a, h) => a + h.lamports, 0), count: hits.length,
    burners: new Set(hits.map((h) => h.burner)).size, txs: hits,
  };
}
