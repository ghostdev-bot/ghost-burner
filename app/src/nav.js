// Shared top tab bar: Home · Refer · How it works · More.
// - The active tab is marked in each page's HTML (class "on" + aria-current), so it works without JS.
// - Keeps ?ref=<wallet> on every internal tab link: the valid ref in this URL, else the stored one.
// - "More" is a <details> menu: closes on outside click, Escape, or picking a link.
import * as CFG from './config.js';
import { REF_PARAM, readStoredRef, validateReferrer } from './core/referral.js';

const NO_REF = [...new Set([...CFG.EFFECTIVE_FEE_RECIPIENTS, ...CFG.FEE_RECIPIENTS].map((r) => r.address).concat(CFG.REFERRAL.from))];

export function navRef(store, search = location.search) {
  const fromUrl = new URLSearchParams(search).get(REF_PARAM);
  if (fromUrl && validateReferrer(fromUrl, { exclude: NO_REF }).ok) return fromUrl.trim();
  try { return readStoredRef(store)?.address || null; } catch { return null; }
}

export function withRef(href, ref, base = location.href) {
  if (!ref) return href;
  const u = new URL(href, base);
  if (u.origin !== new URL(base).origin) return href;
  u.searchParams.set(REF_PARAM, ref);
  return u.pathname + u.search + u.hash;
}

export function initNav(store) {
  const ref = navRef(store);
  if (ref) for (const a of document.querySelectorAll('a[data-keepref]')) a.setAttribute('href', withRef(a.getAttribute('href'), ref));
  const more = document.querySelector('nav.top details.more');
  if (more) {
    document.addEventListener('click', (e) => { if (more.open && !more.contains(e.target)) more.open = false; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && more.open) { more.open = false; more.querySelector('summary')?.focus(); } });
    more.querySelectorAll('.menu a').forEach((a) => a.addEventListener('click', () => { more.open = false; }));
  }
  return ref;
}
