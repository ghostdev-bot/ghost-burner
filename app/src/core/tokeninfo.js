// Public token metadata + USD prices (mainnet only). Anything not found stays "unknown".
import { TOKEN_INFO_API, IPFS_GATEWAY } from '../config.js';

export function safeUrl(u) {
  if (!u || typeof u !== 'string') return null;
  u = u.trim();
  if (u.startsWith('ipfs://')) return IPFS_GATEWAY + u.slice(7).replace(/^ipfs\//, '');
  if (u.startsWith('ar://')) return 'https://arweave.net/' + u.slice(5);
  try { const p = new URL(u); return p.protocol === 'https:' ? p.href : null; } catch { return null; }
}

async function fetchJson(url, ms = 5000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' }); if (!r.ok) return null; return await r.json(); }
  catch { return null; } finally { clearTimeout(t); }
}

export async function enrich(items, { cluster, onUpdate = () => {} } = {}) {
  for (const it of items) { it.price = null; it.usdValue = null; it.verified = false; }
  if (cluster === 'mainnet-beta') {
    const mints = [...new Set(items.filter((i) => !i.isNative).map((i) => i.mint))];
    for (let i = 0; i < mints.length; i += 50) {
      const res = await fetchJson(TOKEN_INFO_API + mints.slice(i, i + 50).join(','), 8000);
      if (!Array.isArray(res)) continue;
      const byId = new Map(res.map((t) => [t.id, t]));
      for (const it of items) {
        const t = byId.get(it.mint); if (!t) continue;
        it.meta.name = t.name || it.meta.name; it.meta.symbol = t.symbol || it.meta.symbol;
        it.meta.image = safeUrl(t.icon) || it.meta.image;
        it.verified = !!t.isVerified;
        if (typeof t.usdPrice === 'number' && isFinite(t.usdPrice)) { it.price = t.usdPrice; it.usdValue = Number(it.uiAmount) * t.usdPrice; }
      }
      onUpdate();
    }
  }
  // Off-chain JSON (image) for anything still without a logo, NFTs first. Bounded.
  const todo = items.filter((i) => !i.meta.image && safeUrl(i.meta.uri)).sort((a, b) => (b.kind === 'nft') - (a.kind === 'nft')).slice(0, 40);
  let k = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (k < todo.length) {
      const it = todo[k++];
      const j = await fetchJson(safeUrl(it.meta.uri));
      if (j && typeof j === 'object') { it.meta.image = safeUrl(j.image) || null; if (!it.meta.name && typeof j.name === 'string') it.meta.name = j.name.slice(0, 64); onUpdate(); }
    }
  }));
}
