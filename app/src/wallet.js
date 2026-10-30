// Wallet Standard connector (Phantom, Solflare, Backpack and any compliant wallet).
// We only ever ask the wallet to SIGN transactions we built and simulated; we
// never see keys or seed phrases.
import { getWallets } from '@wallet-standard/app';

const api = getWallets();
export const CHAIN = { 'mainnet-beta': 'solana:mainnet', devnet: 'solana:devnet' };

export function listWallets() {
  return api.get().filter((w) => w.features['standard:connect'] && w.features['solana:signTransaction'] && w.chains.some((c) => c.startsWith('solana:')));
}
export function onWalletsChanged(cb) { const a = api.on('register', cb), b = api.on('unregister', cb); return () => { a(); b(); }; }

export async function connect(wallet) {
  const res = await wallet.features['standard:connect'].connect();
  const account = (res?.accounts || wallet.accounts).find((a) => a.chains?.some((c) => c.startsWith('solana:'))) || (res?.accounts || wallet.accounts)[0];
  if (!account) throw new Error('Wallet returned no account');
  return account;
}
export async function disconnect(wallet) { try { await wallet?.features['standard:disconnect']?.disconnect(); } catch {} }
export function onAccountChange(wallet, cb) { return wallet.features['standard:events']?.on('change', cb) || (() => {}); }

export function supportsV0(wallet) {
  const v = wallet.features['solana:signTransaction']?.supportedTransactionVersions;
  return !v || [...v].some((x) => x === 0 || x === '0');
}

export async function signAll(wallet, account, txBytesList, cluster) {
  const chain = CHAIN[cluster];
  const out = await wallet.features['solana:signTransaction'].signTransaction(...txBytesList.map((transaction) => ({ account, transaction, chain })));
  return out.map((o) => o.signedTransaction);
}
