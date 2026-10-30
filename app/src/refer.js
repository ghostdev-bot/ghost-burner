import { Buffer } from 'buffer';
globalThis.Buffer = globalThis.Buffer || Buffer;
import './style.css';
import { makeConnection } from './core/rpc.js';
import * as CFG from './config.js';
import { initNav } from './nav.js';
import { lamportsToSol } from './core/burner.js';
import { validateReferrer, referralLink, captureRef } from './core/referral.js';
import { scanReferralEarnings } from './core/referral-stats.js';
import * as W from './wallet.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'disabled' || k === 'readOnly') el[k] = !!v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const short = (a, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : '');
const FEE_ADDRS = CFG.EFFECTIVE_FEE_RECIPIENTS.map((r) => r.address);
// Never accept a fee wallet as a referrer, including the production ones in a test build.
const NO_REF = [...new Set([...FEE_ADDRS, ...CFG.FEE_RECIPIENTS.map((r) => r.address), CFG.REFERRAL.from])];
const store = (() => { try { localStorage.getItem('x'); return localStorage; } catch { return { getItem: () => null, setItem() {}, removeItem() {} }; } })();
captureRef(location.search, store, { exclude: NO_REF }); // a ?ref= on this page counts too
initNav(store);

const S = { cluster: store.getItem('gb_cluster') || CFG.DEFAULT_CLUSTER, wallet: null, address: null, scanId: 0 };
if (!CFG.RPC_ENDPOINTS[S.cluster]) S.cluster = CFG.DEFAULT_CLUSTER;
const explorer = (kind, id) => `https://solscan.io/${kind}/${id}${S.cluster === 'devnet' ? '?cluster=devnet' : ''}`;
const conn = () => makeConnection([store.getItem('gb_rpc_' + S.cluster), ...CFG.RPC_ENDPOINTS[S.cluster]].filter(Boolean), { commitment: 'confirmed', rateLimits: CFG.RPC_RATE_LIMITS });
const SITE_ROOT = () => location.origin + '/';
const SHARE_TEXT = 'My wallet was haunted by dead token accounts. Ghost Burner closed them and gave me the SOL back 👻🔥 Reclaim yours:';

function renderCluster() { $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.cluster === S.cluster)); }
$$('.seg button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.cluster === S.cluster) return;
  S.cluster = b.dataset.cluster; store.setItem('gb_cluster', S.cluster); renderCluster(); if (S.address) scanStats();
}));

// ── Wallet (address only; nothing is signed on this page) ──
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const INSTALL = [
  { name: 'Phantom', url: 'https://phantom.app/download', deep: (u, r) => `https://phantom.app/ul/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(r)}` },
  { name: 'Solflare', url: 'https://solflare.com/download', deep: (u, r) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(r)}` },
  { name: 'Backpack', url: 'https://backpack.app/download', deep: (u, r) => `https://backpack.app/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(r)}` },
];
const deepBtn = (i, cls = 'wbtn') => h('a', { class: cls, href: i.deep(location.origin + location.pathname, location.origin), rel: 'noopener' }, h('span', { class: 'logo' }, i.name[0]), `Open in ${i.name}`);
function renderNoWallet() {
  const none = IS_MOBILE && W.listWallets().length === 0 && !S.address;
  const nw = $('#noWallet'); if (!nw) return; // replaced by the link once a wallet is connected
  nw.hidden = !none;
  if (none) $('#deepLinks').replaceChildren(...INSTALL.map((i) => deepBtn(i, 'btn deep')));
}
function renderWalletList() {
  const box = $('#walletList'); box.replaceChildren();
  const ws = W.listWallets();
  for (const w of ws) box.append(h('button', { type: 'button', class: 'wbtn', onclick: () => doConnect(w) }, h('img', { src: w.icon, alt: '' }), w.name, h('small', {}, 'Detected')));
  if (IS_MOBILE && !ws.length) { box.append(h('p', { class: 'mut xs' }, 'On a phone, wallets only connect inside their own app browser:')); for (const i of INSTALL) box.append(deepBtn(i)); return; }
  const names = ws.map((w) => w.name.toLowerCase());
  for (const i of INSTALL) if (!names.some((n) => n.includes(i.name.toLowerCase()))) box.append(h('a', { class: 'wbtn', href: i.url, target: '_blank', rel: 'noopener' }, h('span', { class: 'logo' }, i.name[0]), i.name, h('small', {}, 'Install')));
}
W.onWalletsChanged(() => { renderNoWallet(); if ($('#walletDlg').open) renderWalletList(); });
setTimeout(renderNoWallet, 1200);
function openWallets() { if (S.wallet) return doDisconnect(); renderWalletList(); $('#walletDlg').showModal(); }
$('#connectBtn').addEventListener('click', openWallets);
$('#heroConnect').addEventListener('click', openWallets);
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
async function doConnect(w) {
  try { const acc = await W.connect(w); S.wallet = w; store.setItem('gb_wallet', w.name); $('#walletDlg').close(); setAddress(acc.address); }
  catch (e) { alert('Wallet connection failed: ' + (e?.message || e)); }
}
async function doDisconnect() {
  await W.disconnect(S.wallet); S.wallet = null; store.removeItem('gb_wallet');
  $('#connectBtn').textContent = 'Connect wallet'; S.address = null; S.scanId++; renderLink(); $('#statsCard').hidden = true;
}
$('#addrGo').addEventListener('click', () => {
  const v = validateReferrer($('#addrInput').value, { exclude: NO_REF });
  $('#addrErr').textContent = v.ok ? '' : `Not usable as a referrer: ${v.reason}.`;
  $('#addrErr').className = 'xs ' + (v.ok ? '' : 'red');
  if (v.ok) setAddress(v.address);
});

function setAddress(a) {
  S.address = a;
  if (S.wallet) { $('#connectBtn').textContent = short(a) + ' ✕'; $('#connectBtn').title = 'Disconnect'; }
  renderLink(); scanStats();
}

function renderLink() {
  const body = $('#linkBody');
  if (!S.address) { body.replaceChildren(h('p', { class: 'mut' }, 'Connect the wallet you want to be paid in. Your link is just this site with ', h('code', {}, '?ref='), ' and your address.'), h('button', { type: 'button', class: 'btn big', onclick: openWallets }, 'Connect wallet'), $('#noWallet')); renderNoWallet(); return; }
  const v = validateReferrer(S.address, { exclude: NO_REF });
  if (!v.ok) { body.replaceChildren(h('div', { class: 'warnbox' }, h('b', {}, 'This address can\'t be a referrer: '), v.reason + '.')); return; }
  const link = referralLink(SITE_ROOT(), v.address);
  const inp = h('input', { value: link, readOnly: true, 'aria-label': 'Your referral link', onfocus: (e) => e.target.select() });
  const copy = h('button', { type: 'button', class: 'btn', onclick: async () => {
    try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied ✓'; } catch { inp.select(); document.execCommand?.('copy'); copy.textContent = 'Copied ✓'; }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  } }, 'Copy');
  const xUrl = `https://x.com/intent/post?text=${encodeURIComponent(SHARE_TEXT + ' ' + link)}`;
  body.replaceChildren(
    h('p', { class: 'mut xs' }, 'Paid to ', h('a', { href: explorer('account', v.address), target: '_blank', rel: 'noopener' }, h('code', {}, short(v.address, 6)))),
    h('div', { class: 'linkbox' }, inp, copy),
    h('div', { class: 'sharerow' },
      h('a', { class: 'btn x', href: xUrl, target: '_blank', rel: 'noopener', id: 'shareX' }, h('b', {}, '𝕏'), 'Share on X')),
    h('p', { class: 'mut xs' }, 'Tip: keep at least ~0.001 SOL in this wallet so even the smallest payouts can land.'));
}

async function scanStats() {
  if (!S.address) return;
  const id = ++S.scanId, addr = S.address, cluster = S.cluster;
  $('#statsCard').hidden = false; $('#statsAddr').textContent = `${short(addr, 4)} · ${cluster}`;
  ['#stTotal', '#stCount', '#stBurners'].forEach((s) => { $(s).textContent = '…'; });
  $('#statsList').replaceChildren(); $('#statsBtn').disabled = true;
  const note = $('#statsNote'); note.className = 'mut xs'; note.replaceChildren(h('span', { class: 'spin' }), 'Reading your recent transactions from the chain…');
  try {
    const r = await scanReferralEarnings(conn(), addr, { feeWallets: FEE_ADDRS, limit: 100, onProgress: (d, n) => { if (id === S.scanId) note.replaceChildren(h('span', { class: 'spin' }), `Reading your recent transactions from the chain… ${d}/${n}`); } });
    if (id !== S.scanId) return;
    $('#stTotal').textContent = `${lamportsToSol(r.totalLamports, 6)} SOL`;
    $('#stCount').textContent = r.count; $('#stBurners').textContent = r.burners;
    const since = r.oldestScanned ? new Date(r.oldestScanned * 1000).toLocaleDateString() : null;
    note.textContent = `Estimate. Counted from your last ${r.scanned} transaction(s)${since ? ` (back to ${since})` : ''}: transfers to you inside Ghost Burner burns (a close or NFT burn plus a Ghost Burner fee transfer from the same wallet).${r.limitReached ? ' Older payouts are not included.' : ''}${r.failed ? ` ${r.failed} transaction(s) could not be read (RPC limits); try Rescan.` : ''}`;
    $('#statsList').replaceChildren(...(r.txs.length ? r.txs.slice(0, 50).map((t) => h('div', {},
      h('a', { href: explorer('tx', t.signature), target: '_blank', rel: 'noopener' }, t.blockTime ? new Date(t.blockTime * 1000).toLocaleString() : short(t.signature, 8)),
      h('span', { class: 'mut' }, `from ${short(t.burner, 4)}`), h('b', { class: 'g' }, `+${lamportsToSol(t.lamports, 6)}`))) : [h('div', { class: 'mut' }, 'No referral payouts found yet. Share your link to get started.')]));
  } catch (e) {
    if (id !== S.scanId) return;
    ['#stTotal', '#stCount', '#stBurners'].forEach((s) => { $(s).textContent = '–'; });
    note.className = 'xs red'; note.textContent = `Couldn't read your transactions: ${e?.message || e}. Public RPCs may be rate-limited. Try again shortly, or set a custom RPC in ⚙ on the burner page.`;
  } finally { if (id === S.scanId) $('#statsBtn').disabled = false; }
}
$('#statsBtn').addEventListener('click', scanStats);

renderCluster();
setTimeout(() => {
  const last = store.getItem('gb_wallet');
  const w = last && W.listWallets().find((x) => x.name === last);
  if (w && w.accounts?.length && !S.address) { S.wallet = w; setAddress(w.accounts[0].address); }
}, 400);
if ('serviceWorker' in navigator && location.protocol === 'https:') window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}); });
