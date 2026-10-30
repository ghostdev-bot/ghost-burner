// Ghost Burner referrals: link parsing, validation and storage. Pure ESM, no DOM;
// storage is injected (localStorage in the browser, a Map-backed shim in tests).
import { PublicKey } from '@solana/web3.js';

export const REF_PARAM = 'ref';
export const REF_STORAGE_KEY = 'gb_ref';
export const REF_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// A referrer must be a base58 string that decodes to exactly 32 bytes, lie on the
// ed25519 curve (a normal wallet, not a PDA nobody can sign for), and must not be
// the connected wallet or any configured fee recipient.
export function validateReferrer(ref, { owner = null, exclude = [] } = {}) {
  if (typeof ref !== 'string' || !ref.trim()) return { ok: false, reason: 'empty' };
  const s = ref.trim();
  if (!B58.test(s)) return { ok: false, reason: 'not a base58 address' };
  let pk;
  try { pk = new PublicKey(s); } catch { return { ok: false, reason: 'not a base58 address' }; }
  if (pk.toBytes().length !== 32 || pk.toBase58() !== s) return { ok: false, reason: 'not a 32-byte public key' };
  if (!PublicKey.isOnCurve(pk.toBytes())) return { ok: false, reason: 'not a wallet address (off-curve)' };
  if (pk.equals(PublicKey.default)) return { ok: false, reason: 'system default address' };
  if (owner && pk.equals(new PublicKey(owner))) return { ok: false, reason: 'self-referral' };
  for (const x of exclude) { if (x && pk.equals(new PublicKey(x))) return { ok: false, reason: 'fee recipient cannot be a referrer' }; }
  return { ok: true, address: pk.toBase58() };
}

// Stored as {"a": address, "t": firstSeenMs}. Expired or malformed entries are removed.
export function readStoredRef(storage, now = Date.now()) {
  let raw = null; try { raw = storage.getItem(REF_STORAGE_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v?.a !== 'string' || !Number.isFinite(v?.t) || v.t > now + 60_000 || now - v.t >= REF_TTL_MS || !validateReferrer(v.a).ok) throw 0;
    return { address: v.a, since: v.t, expires: v.t + REF_TTL_MS };
  } catch { try { storage.removeItem(REF_STORAGE_KEY); } catch {} return null; }
}

// First valid ref wins: a new ?ref= never replaces an unexpired stored one.
// Returns { stored, active, reason }.
export function captureRef(search, storage, { exclude = [], now = Date.now() } = {}) {
  const current = readStoredRef(storage, now);
  let param = null; try { param = new URLSearchParams(search || '').get(REF_PARAM); } catch {}
  if (!param) return { stored: false, active: current, reason: current ? 'existing' : 'none' };
  const v = validateReferrer(param, { exclude });
  if (!v.ok) return { stored: false, active: current, reason: 'invalid: ' + v.reason };
  if (current) return { stored: false, active: current, reason: current.address === v.address ? 'same' : 'first-ref-wins' };
  try { storage.setItem(REF_STORAGE_KEY, JSON.stringify({ a: v.address, t: now })); } catch { return { stored: false, active: null, reason: 'storage unavailable' }; }
  return { stored: true, active: readStoredRef(storage, now), reason: 'stored' };
}

export function clearStoredRef(storage) { try { storage.removeItem(REF_STORAGE_KEY); } catch {} }

export const referralLink = (siteUrl, address) => `${siteUrl.replace(/[?#].*$/, '')}?${REF_PARAM}=${address}`;
