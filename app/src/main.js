import { Buffer } from 'buffer';
globalThis.Buffer = globalThis.Buffer || Buffer;
import './style.css';
import { PublicKey, Keypair } from '@solana/web3.js';
import { makeConnection } from './core/rpc.js';
import * as CFG from './config.js';
import { initNav } from './nav.js';
import { scanWallet, prepareTransactions, auditSigned, sendSigned, normalizeFee, totalFeeFor, lamportsToSol, SimulationError } from './core/burner.js';
import { captureRef, readStoredRef, clearStoredRef } from './core/referral.js';
import { enrich } from './core/tokeninfo.js';
import * as W from './wallet.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'checked' || k === 'disabled') el[k] = !!v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const short = (a, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : '');
const sol = (l) => `${lamportsToSol(l)} SOL`;
const usd = (v) => (v == null ? 'unknown' : v < 0.01 && v > 0 ? '<$0.01' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const explorer = (kind, id) => `https://solscan.io/${kind}/${id}${S.cluster === 'devnet' ? '?cluster=devnet' : ''}`;

const S = {
  cluster: localStorage.getItem('gb_cluster') || CFG.DEFAULT_CLUSTER,
  wallet: null, account: null, owner: null, items: [], selected: new Set(), tab: 'empty', scanning: false, busy: false,
};
if (!CFG.RPC[S.cluster]) S.cluster = CFG.DEFAULT_CLUSTER;
const rpcUrl = () => localStorage.getItem('gb_rpc_' + S.cluster) || CFG.RPC[S.cluster];
const customRpc = () => localStorage.getItem('gb_rpc_' + S.cluster);
const rpcList = () => [customRpc(), ...(CFG.RPC_ENDPOINTS[S.cluster] || [CFG.RPC[S.cluster]])].filter(Boolean);
let _conn = null, _connKey = '';
const conn = () => { const k = rpcList().join('|'); if (!_conn || _connKey !== k) { _conn = makeConnection(rpcList(), { commitment: 'confirmed', rateLimits: CFG.RPC_RATE_LIMITS }); _connKey = k; } return _conn; };
// ── Referral: ?ref=<wallet>, first valid ref wins, kept 30 days in localStorage ──
const FEE_ADDRS = CFG.EFFECTIVE_FEE_RECIPIENTS.map((r) => r.address);
// Never accept a fee wallet as a referrer, including the production ones in a test build.
const NO_REF = [...new Set([...FEE_ADDRS, ...CFG.FEE_RECIPIENTS.map((r) => r.address), CFG.REFERRAL.from])];
const store = (() => { try { localStorage.getItem('x'); return localStorage; } catch { return { getItem: () => null, setItem() {}, removeItem() {} }; } })();
const REF_CAPTURE = captureRef(location.search, store, { exclude: NO_REF });
initNav(store); // tab bar: keeps ?ref on Home / Refer / How it works links
const storedRef = () => readStoredRef(store)?.address || null;
// The referrer that will actually be paid for the connected wallet (null for a self-referral).
const activeRef = () => { const r = storedRef(); return r && !(S.owner && S.owner.toBase58() === r) ? r : null; };
const fee = () => normalizeFee({ recipients: CFG.EFFECTIVE_FEE_RECIPIENTS, maxFeeBps: CFG.MAX_FEE_BPS, owner: S.owner, referral: { referrer: activeRef(), ...CFG.EFFECTIVE_REFERRAL } });
const legsFee = (rec, f) => totalFeeFor(rec, f);
const prio = () => CFG.PRIORITY_FEE_MICROLAMPORTS[S.cluster] || 0;
const pct = (bps) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

// ── Static text ──────────────────────────────────────────────────────────────
const splitText = (f) => f.legs.map((l) => `${pct(l.bps)} to ${l.referral ? 'the referrer' : l.label} (${short(l.wallet.toBase58(), 4)})`).join(', ').replace(/, ([^,]*)$/, ' and $1');
function renderFeeText() {
  const f = normalizeFee({ recipients: CFG.EFFECTIVE_FEE_RECIPIENTS, maxFeeBps: CFG.MAX_FEE_BPS });
  // Example referrer (any valid wallet) just to render the "with a referral link" split.
  const fr = normalizeFee({ recipients: CFG.EFFECTIVE_FEE_RECIPIENTS, maxFeeBps: CFG.MAX_FEE_BPS, referral: { referrer: Keypair.generate().publicKey.toBase58(), ...CFG.EFFECTIVE_REFERRAL } });
  const refOk = !!fr.referrer;
  $('#feeLine').textContent = f.enabled ? `${pct(f.bps)} of the SOL rent you reclaim.` : `none in this build (fee wallet not configured).`;
  const ref = refOk ? fr.legs.find((l) => l.referral) : null, src = ref ? fr.legs.find((l) => l.wallet.equals(ref.from)) : null;
  $('#feeExplain').textContent = f.enabled
    ? `A flat ${pct(f.bps)} of the SOL rent actually reclaimed in each transaction, rounded down. Without a referral link it is split ${splitText(f)}.${refOk ? ` With a referral link it is split ${pct(src.bps)} to ${src.label}, ${pct(ref.bps)} to the wallet that referred you and ${fr.legs.filter((l) => !l.referral && l !== src).map((l) => `${pct(l.bps)} to ${l.label}`).join(', ')}. You pay the same ${pct(f.bps)} either way.` : ''} Each part is a normal SOL transfer inside the same transaction. It is never taken from your tokens. The review screen shows the exact amount, and your wallet shows it again before you sign. Example: closing 10 empty accounts frees about 0.0204 SOL, so the fee is about ${lamportsToSol(legsFee(20392800, f))} SOL.${refOk ? ` If the referrer's part is too small for their wallet to receive (a brand-new wallet needs about 0.00065 SOL to exist, Solana's rent-exempt rule), that part goes to ${src.label} instead, so the total stays ${pct(f.bps)}.` : ''} If a fee wallet can't receive a tiny amount yet, that part is waived, never added to what you pay.`
    : `This build has no fee wallet configured, so no fee is charged. When enabled, the fee is a fixed percentage of the rent reclaimed, shown before you sign.`;
  if (refOk) $('#feeLine').textContent = `${pct(f.bps)} of the SOL rent you reclaim: ${pct(src.poolBps)} ${src.label} + ${fr.legs.filter((l) => !l.referral && l !== src).map((l) => `${pct(l.bps)} ${l.label}`).join(' + ')}. Via a referral link: ${pct(src.bps)} treasury + ${pct(ref.bps)} referrer + ${fr.legs.filter((l) => !l.referral && l !== src).map((l) => `${pct(l.bps)} ${l.label}`).join(' + ')}.`;
}
function renderRefNote() {
  const r = storedRef(), box = $('#refNote');
  const self = r && S.owner && S.owner.toBase58() === r;
  box.hidden = !r;
  if (!r) return;
  box.className = 'refnote' + (self ? ' off' : '');
  box.replaceChildren(h('span', { class: 'refdot' }), self
    ? h('span', {}, 'Referral link not applied: it points to your own wallet. Fee: 1% treasury + 1% BOBO buy.')
    : h('span', {}, 'Referred by ', h('a', { href: explorer('account', r), target: '_blank', rel: 'noopener' }, h('code', {}, short(r, 4))), '. They earn 0.5% of the SOL you reclaim, paid out of the 2% fee. You pay the same 2%.'));
}

// ── Cluster / settings ───────────────────────────────────────────────────────
function renderCluster() {
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.cluster === S.cluster));
  const t = $('#clusterTag'); t.textContent = S.cluster === 'devnet' ? 'DEVNET' : 'MAINNET'; t.classList.toggle('dev', S.cluster === 'devnet');
}
$$('.seg button').forEach((b) => b.addEventListener('click', () => {
  if (S.busy || b.dataset.cluster === S.cluster) return;
  S.cluster = b.dataset.cluster; localStorage.setItem('gb_cluster', S.cluster); renderCluster();
  if (S.owner) scan();
}));
$('#settingsBtn').addEventListener('click', () => {
  $('#setCluster').textContent = S.cluster;
  $('#rpcInput').value = localStorage.getItem('gb_rpc_' + S.cluster) || '';
  $('#rpcInput').placeholder = CFG.redactRpc(CFG.RPC[S.cluster]);
  $('#rpcNote').textContent = `Default: ${S.cluster === 'mainnet-beta' && CFG.HELIUS_RPC ? 'Helius' : CFG.redactRpc(CFG.RPC[S.cluster])}, with automatic fallback to free public endpoints. A custom RPC here is tried first. Stored only in this browser.`;
  $('#settingsDlg').showModal();
});
$('#rpcSave').addEventListener('click', () => {
  const v = $('#rpcInput').value.trim();
  if (v) { try { if (new URL(v).protocol !== 'https:') throw 0; } catch { $('#rpcNote').textContent = 'Enter a valid https:// URL.'; return; } localStorage.setItem('gb_rpc_' + S.cluster, v); }
  else localStorage.removeItem('gb_rpc_' + S.cluster);
  $('#settingsDlg').close(); if (S.owner) scan();
});
$('#rpcReset').addEventListener('click', () => { localStorage.removeItem('gb_rpc_' + S.cluster); $('#rpcInput').value = ''; });
$$('[data-close]').forEach((b) => b.addEventListener('click', () => { if (!S.busy) b.closest('dialog').close(); }));
$('#reviewDlg').addEventListener('cancel', (e) => { if (S.busy) e.preventDefault(); });

// ── Wallet ───────────────────────────────────────────────────────────────────
// Mobile wallets only inject inside their own in-app browser, so a plain mobile browser or a
// home-screen (standalone) app has no wallet. Offer documented "browse" universal links that
// open this site inside the wallet app. Rendered as plain <a> tags (no target, no JS redirect)
// because iOS only follows universal links on a direct user tap.
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const IS_STANDALONE = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
// Keeps an active referral when the site is reopened inside a wallet app (separate storage there).
const SITE_URL = () => location.origin + location.pathname + (storedRef() ? `?ref=${storedRef()}` : '');
if (IS_STANDALONE) document.body.classList.add('standalone');
const INSTALL = [
  { name: 'Phantom', url: 'https://phantom.app/download', deep: (u, r) => `https://phantom.app/ul/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(r)}` },
  { name: 'Solflare', url: 'https://solflare.com/download', deep: (u, r) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(r)}` },
  { name: 'Backpack', url: 'https://backpack.app/download', deep: (u, r) => `https://backpack.app/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(r)}` },
];
export const deepLink = (i) => i.deep(SITE_URL(), location.origin);
const deepBtn = (i, cls = 'wbtn') => h('a', { class: cls, href: deepLink(i), rel: 'noopener', 'data-wallet': i.name.toLowerCase() }, h('span', { class: 'logo' }, i.name[0]), `Open in ${i.name}`);
function copyLinkBtn() {
  const b = h('button', { type: 'button', class: 'wbtn ghost', onclick: async () => {
    try { await navigator.clipboard.writeText(SITE_URL()); b.lastChild.textContent = 'Link copied. Paste it in your wallet\'s browser'; } catch { prompt('Copy this link into your wallet app\'s browser:', SITE_URL()); }
  } }, h('span', { class: 'logo' }, '⧉'), h('span', {}, 'Copy link'));
  return b;
}
function renderNoWallet() {
  const none = IS_MOBILE && W.listWallets().length === 0 && !S.owner;
  $('#noWallet').hidden = !none;
  if (!none) return;
  $('#noWalletWhy').textContent = IS_STANDALONE
    ? 'Home-screen apps can\'t see wallets: Phantom, Solflare and Backpack only connect inside their own app browser.'
    : 'On iPhone and Android, wallets only connect inside their own app browser.';
  $('#deepLinks').replaceChildren(...INSTALL.map((i) => deepBtn(i, 'btn deep')), copyLinkBtn());
}
function renderWalletList() {
  const box = $('#walletList'); box.replaceChildren();
  const ws = W.listWallets();
  for (const w of ws) box.append(h('button', { type: 'button', class: 'wbtn', onclick: () => doConnect(w) }, h('img', { src: w.icon, alt: '' }), w.name, h('small', {}, 'Detected')));
  const names = [...new Set(ws.map((w) => w.name.toLowerCase()))];
  if (IS_MOBILE && !ws.length) {
    box.append(h('p', { class: 'mut xs' }, IS_STANDALONE ? 'Home-screen apps have no wallet. Open Ghost Burner inside your wallet app:' : 'On a phone, wallets only connect inside their own app browser. Open Ghost Burner there:'));
    for (const i of INSTALL) box.append(deepBtn(i));
    box.append(copyLinkBtn());
    return;
  }
  for (const i of INSTALL) if (!names.some((n) => n.includes(i.name.toLowerCase())))
    box.append(h('a', { class: 'wbtn', href: i.url, target: '_blank', rel: 'noopener' }, h('span', { class: 'logo' }, i.name[0]), i.name, h('small', {}, 'Install')));
}
W.onWalletsChanged(() => { renderNoWallet(); if ($('#walletDlg').open) renderWalletList(); });
setTimeout(renderNoWallet, 1200);

function openWallets() { if (S.owner) return doDisconnect(); renderWalletList(); $('#walletDlg').showModal(); }
$('#connectBtn').addEventListener('click', openWallets);
$('#heroConnect').addEventListener('click', openWallets);

let unsubChange = null;
async function doConnect(w) {
  try {
    if (!W.supportsV0(w)) throw new Error(`${w.name} does not support versioned transactions`);
    const acc = await W.connect(w);
    S.wallet = w; S.account = acc; S.owner = new PublicKey(acc.address);
    localStorage.setItem('gb_wallet', w.name);
    $('#walletDlg').close();
    unsubChange?.(); unsubChange = W.onAccountChange(w, ({ accounts }) => {
      if (!accounts) return;
      const a = accounts[0];
      if (!a) return doDisconnect();
      if (a.address !== S.account?.address) { S.account = a; S.owner = new PublicKey(a.address); renderRefNote(); scan(); }
    });
    afterConnect();
  } catch (e) { alert('Wallet connection failed: ' + (e?.message || e)); }
}
async function doDisconnect() {
  if (S.busy) return;
  await W.disconnect(S.wallet); unsubChange?.();
  Object.assign(S, { wallet: null, account: null, owner: null, items: [], selected: new Set() });
  localStorage.removeItem('gb_wallet');
  $('#app').hidden = true; $('#hero').hidden = false; $('#actionbar').hidden = true; $('#connectBtn').textContent = 'Connect wallet';
  renderRefNote();
}
function afterConnect() {
  $("#noWallet").hidden = true;
  $('#connectBtn').textContent = short(S.owner.toBase58()) + ' ✕';
  $('#connectBtn').title = 'Disconnect';
  $('#addr').textContent = S.owner.toBase58();
  $('#hero').hidden = true; $('#app').hidden = false; $('#actionbar').hidden = false;
  renderRefNote();
  scan();
}

// ── Scan ─────────────────────────────────────────────────────────────────────
async function scan() {
  if (!S.owner) return;
  const owner = S.owner, cluster = S.cluster;
  S.scanning = true; S.items = []; S.selected = new Set(); renderList();
  const msg = $('#scanMsg'); msg.hidden = false; msg.className = 'notice'; msg.replaceChildren(h('span', { class: 'spin' }), `Scanning token accounts on ${cluster}…`);
  try {
    const items = await scanWallet(conn(), owner, { holdingsApi: cluster === 'mainnet-beta' ? CFG.HOLDINGS_API : null });
    if (S.owner !== owner || S.cluster !== cluster) return;
    S.items = items;
    for (const it of items) if (it.kind === 'empty' && it.action === 'close') S.selected.add(it.id); // only empties are preselected
    const defaultRpc = !localStorage.getItem('gb_rpc_' + S.cluster);
    msg.hidden = !(items.source === 'index' || (defaultRpc && cluster === 'mainnet-beta' && !CFG.HELIUS_RPC));
    msg.textContent = items.source === 'index'
      ? 'Account list from Jupiter\'s public index (the RPC does not allow full account listing); every account shown was re-read on-chain. A brand-new account may be missing — add a dedicated RPC in ⚙ for a complete scan.'
      : 'Using free public RPCs (with automatic fallback), which may be slow or rate-limited. Add a dedicated RPC in ⚙ settings for best results.';
    S.scanning = false; renderList();
    enrich(items, { cluster, onUpdate: () => { if (S.items === items) renderList(); } }).catch(() => {});
  } catch (e) {
    S.scanning = false; renderList();
    msg.className = 'notice err'; msg.textContent = `Scan failed: ${e?.message || e}. The RPC may be rate-limited — try again or set a custom RPC in ⚙.`;
  }
}
$('#rescanBtn').addEventListener('click', () => !S.busy && scan());

// ── List rendering ───────────────────────────────────────────────────────────
const TABS = {
  empty: { f: (i) => !i.blocked && i.kind === 'empty', note: 'Empty accounts hold no tokens. Closing them refunds the rent. They are pre-selected; untick any you want to keep.' },
  token: { f: (i) => !i.blocked && i.kind === 'token', note: '⚠ Burning destroys these tokens forever. Nothing here is selected unless you tick it. Values come from public price data and may be missing or wrong.', warn: true },
  nft: { f: (i) => !i.blocked && i.kind === 'nft', note: '⚠ Burning an NFT destroys it forever and refunds its token, metadata and edition rent. Only standard Metaplex NFTs are supported. Compressed NFTs don\'t appear here, and pNFTs are excluded.', warn: true },
  blocked: { f: (i) => !!i.blocked, note: 'These accounts are listed for transparency but can\'t be selected in v1, for your safety.' },
};
const isValuable = (i) => i.usdValue != null && i.usdValue > CFG.VALUE_WARN_USD;
$$('.tabs button').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; renderList(); }));
$('#selAll').addEventListener('change', (e) => {
  const rows = S.items.filter(TABS[S.tab].f).filter((i) => i.action && !isValuable(i));
  rows.forEach((i) => (e.target.checked ? S.selected.add(i.id) : S.selected.delete(i.id)));
  renderList();
});

function itemRow(it) {
  const sel = S.selected.has(it.id), burn = it.action && it.action !== 'close';
  const nm = it.meta.name || it.meta.symbol || 'Unknown token';
  const logo = h('div', { class: 'logo' }, it.meta.image ? h('img', { src: it.meta.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : (it.meta.symbol || '?').slice(0, 3).toUpperCase());
  const badges = [];
  if (it.program === 'token-2022') badges.push(h('span', { class: 'badge t22' }, '2022'));
  if (it.kind === 'token' && !it.blocked) badges.push(isValuable(it) ? h('span', { class: 'badge warn' }, 'HAS VALUE') : it.usdValue == null ? h('span', { class: 'badge' }, 'value unknown') : null);
  if (it.verified) badges.push(h('span', { class: 'badge ok' }, 'listed'));
  const cb = h('input', { type: 'checkbox', checked: sel, disabled: !it.action || S.busy, 'aria-label': `Select ${nm}`, onchange: (e) => { e.target.checked ? S.selected.add(it.id) : S.selected.delete(it.id); renderList(); } });
  return h('div', { class: `row-i${sel ? ' sel' : ''}${sel && burn ? ' burn' : ''}${it.action ? '' : ' off'}` },
    cb, logo,
    h('div', { class: 'nm' }, h('b', {}, nm, it.meta.symbol && it.meta.name ? h('span', { class: 'mut' }, ` ${it.meta.symbol}`) : null, ...badges), h('a', { href: explorer('token', it.mint), target: '_blank', rel: 'noopener' }, short(it.mint, 6))),
    h('div', { class: 'cell c-bal' }, it.kind === 'empty' ? '0' : it.uiAmount, h('small', {}, it.kind === 'nft' ? 'NFT' : 'balance')),
    h('div', { class: 'cell c-val' }, it.kind === 'empty' ? '–' : usd(it.usdValue), h('small', {}, 'value')),
    h('div', { class: 'cell c-rent g' }, it.action ? `+${lamportsToSol(it.estReclaimLamports, 5)}` : '–', h('small', {}, 'SOL back')),
    it.blocked ? h('div', { class: 'reason' }, it.blocked) : null);
}

function renderList() {
  const list = $('#list');
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  for (const [k, id] of [['empty', '#cEmpty'], ['token', '#cToken'], ['nft', '#cNft'], ['blocked', '#cBlocked']]) $(id).textContent = S.items.filter(TABS[k].f).length;
  const empties = S.items.filter(TABS.empty.f);
  $('#emptyTotal').textContent = S.scanning ? '…' : sol(empties.reduce((s, i) => s + i.estReclaimLamports, 0));
  $('#acctCount').textContent = S.scanning ? '…' : S.items.length;
  const t = TABS[S.tab]; $('#tabNote').textContent = t.note; $('#tabNote').className = 'tabnote' + (t.warn ? ' warn' : '');
  const rows = S.items.filter(t.f);
  const selectable = rows.filter((i) => i.action && !isValuable(i));
  $('#selAll').disabled = !selectable.length || S.busy;
  $('#selAll').checked = selectable.length > 0 && selectable.every((i) => S.selected.has(i.id));
  $('.listhead').hidden = S.tab === 'blocked';
  $('#listHint').textContent = S.tab === 'token' && rows.some(isValuable) ? `Tokens worth over $${CFG.VALUE_WARN_USD} must be ticked one by one.` : '';
  list.replaceChildren(...(S.scanning ? [h('div', { class: 'empty-state' }, h('span', { class: 'spin' }), 'Scanning…')] : rows.length ? rows.map(itemRow) : [h('div', { class: 'empty-state' }, S.tab === 'empty' ? 'No empty token accounts. Your wallet is already ghost-free 👻' : 'Nothing here.')]));
  renderActionBar();
}

function selectedItems() {
  const order = { close: 0, 'burn-close': 1, 'burn-nft': 2 };
  return S.items.filter((i) => S.selected.has(i.id) && i.action).sort((a, b) => order[a.action] - order[b.action]);
}
function renderActionBar() {
  const sel = selectedItems(); const f = fee();
  const rec = sel.reduce((s, i) => s + i.estReclaimLamports, 0);
  const fl = f.enabled ? legsFee(rec, f) : 0;
  $('#abCount').textContent = sel.length;
  $('#abReclaim').textContent = lamportsToSol(rec, 5);
  $('#abFee').textContent = f.enabled ? `${lamportsToSol(fl, 5)} (${pct(f.bps)})` : '0 (off)';
  $('#abNet').textContent = lamportsToSol(rec - fl, 5);
  $('#reviewBtn').disabled = !sel.length || S.busy || S.scanning;
}

// ── Review & execute ─────────────────────────────────────────────────────────
let shown = null; // the plan whose numbers the user is looking at
$('#reviewBtn').addEventListener('click', openReview);

async function openReview() {
  const items = selectedItems(); if (!items.length) return;
  const body = $('#reviewBody'); shown = null;
  body.replaceChildren(h('p', {}, h('span', { class: 'spin' }), `Building and simulating ${items.length} action(s)…`));
  $('#reviewDlg').showModal();
  try {
    const p = await prepareTransactions({ connection: conn(), owner: S.owner, items, fee: fee(), priorityMicroLamports: prio(), maxActionsPerTx: CFG.MAX_ACTIONS_PER_TX });
    shown = p; renderReview(p);
  } catch (e) { renderError(body, e); }
}

function renderError(body, e) {
  body.replaceChildren(h('div', { class: 'warnbox' }, h('b', {}, e instanceof SimulationError ? 'Simulation failed. Nothing was sent. ' : 'Could not build transactions. Nothing was sent. '), e?.message || String(e)),
    e?.logs?.length ? h('details', {}, h('summary', { class: 'mut xs' }, 'Program logs'), h('pre', { class: 'mut xs', style: 'white-space:pre-wrap;max-height:200px;overflow:auto' }, e.logs.slice(-12).join('\n'))) : null,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => $('#reviewDlg').close() }, 'Close')));
}

function renderReview(p) {
  const body = $('#reviewBody');
  const items = p.transactions.flatMap((t) => t.items);
  const closes = items.filter((i) => i.action === 'close'), burns = items.filter((i) => i.action === 'burn-close'), nfts = items.filter((i) => i.action === 'burn-nft');
  const valuable = burns.filter(isValuable), unknown = burns.filter((i) => i.usdValue == null);
  const valSum = valuable.reduce((s, i) => s + i.usdValue, 0);
  const needsBurnConfirm = burns.length + nfts.length > 0;
  const nm = (i) => `${i.meta.name || i.meta.symbol || 'Unknown token'}${i.meta.symbol && i.meta.name ? ' (' + i.meta.symbol + ')' : ''}`;
  const list = (arr, fn) => h('div', { class: 'rv-list' }, arr.map((i) => h('div', { class: 'rv-item' }, h('span', {}, fn(i)), h('code', {}, short(i.id, 5)))));
  const sec = [];
  if (closes.length) sec.push(h('div', { class: 'rv-sec' }, h('h4', {}, `Close ${closes.length} empty account(s): rent refunded to you`), list(closes, (i) => `${nm(i)} · empty`)));
  if (burns.length) sec.push(h('div', { class: 'rv-sec' }, h('h4', { class: 'burnh' }, `🔥 Burn permanently, then close: ${burns.length} token account(s)`), list(burns, (i) => `${i.uiAmount} ${nm(i)} · ${i.usdValue == null ? 'value unknown' : usd(i.usdValue)}`)));
  if (nfts.length) sec.push(h('div', { class: 'rv-sec' }, h('h4', { class: 'burnh' }, `🔥 Burn permanently: ${nfts.length} NFT(s)`), list(nfts, (i) => `${nm(i)} · NFT`)));
  const f = p.fee;
  const legLabel = (l) => (l.referral ? `↳ ${pct(l.bps)} Referrer ${short(l.wallet, 4)}` : `↳ ${pct(l.bps)} ${l.label} ${short(l.wallet, 4)}`);
  const legVal = (l) => (l.referral && l.redirected && l.lamports === 0 ? `→ ${l.redirectedLamports ? sol(l.redirectedLamports) : ''} to treasury` : l.lamports === 0 && l.waived ? 'waived' : sol(l.lamports) + (l.waived ? ' (part waived)' : '') + (l.referral && l.redirected ? ' (part to treasury)' : ''));
  const totals = h('div', { class: 'totals' },
    h('div', {}, h('span', {}, 'SOL reclaimed (simulated)'), h('span', {}, sol(p.totals.reclaimLamports))),
    h('div', {}, h('span', {}, f.enabled ? `Ghost Burner fee (${pct(f.bps)})` : 'Ghost Burner fee'), h('span', {}, f.enabled ? '−' + sol(p.totals.feeLamports) : 'none')),
    ...(p.totals.feeLegs || []).map((l) => h('div', { class: 'leg' }, h('span', {}, legLabel(l)), h('span', {}, legVal(l)))),
    h('div', {}, h('span', {}, `Network fee (${p.totals.txCount} tx)`), h('span', {}, '−' + sol(p.totals.networkFeeLamports))),
    h('div', { class: 'net' }, h('span', {}, 'You receive'), h('span', {}, sol(p.totals.netLamports))));
  const warns = [];
  if (valuable.length) warns.push(h('div', { class: 'warnbox' }, h('b', {}, `Warning: ${valuable.length} token(s) appear to be worth about ${usd(valSum)} in total. `), 'Burning destroys them; you will NOT receive their value. Consider selling or sending them instead: ', valuable.map((i) => `${nm(i)} (${usd(i.usdValue)})`).join(', '), '.'));
  if (unknown.length) warns.push(h('div', { class: 'warnbox' }, h('b', {}, `${unknown.length} token(s) have unknown value. `), 'We could not find a price. They may still be worth something.'));
  const redir = p.totals.feeLegs?.find((l) => l.referral && l.redirected);
  if (redir) warns.push(h('p', { class: 'mut xs' }, `Referrer's share partly or fully sent to the treasury instead: ${redir.note}. Your total fee is unchanged.`));
  if (p.totals.feeLegs?.some((l) => l.waived)) warns.push(h('p', { class: 'mut xs' }, `Part of the fee is waived (${p.totals.feeLegs.filter((l) => l.waived).map((l) => l.label).join(', ')}): that recipient wallet is not funded enough to receive a tiny transfer yet. You pay less, never more.`));

  const c1 = h('input', { type: 'checkbox', id: 'cf1' });
  const c2 = needsBurnConfirm ? h('input', { type: 'checkbox', id: 'cf2' }) : null;
  const c3 = valuable.length ? h('input', { type: 'checkbox', id: 'cf3' }) : null;
  const typed = needsBurnConfirm ? h('input', { class: 'typed', id: 'cfTyped', placeholder: 'Type BURN to confirm', autocomplete: 'off', spellcheck: 'false' }) : null;
  const go = h('button', { type: 'button', class: needsBurnConfirm ? 'btn big danger' : 'btn big', id: 'signBtn', disabled: true }, `Sign ${p.totals.txCount} transaction${p.totals.txCount > 1 ? 's' : ''}`);
  const update = () => { go.disabled = !(c1.checked && (!c2 || c2.checked) && (!c3 || c3.checked) && (!typed || typed.value.trim() === 'BURN')); };
  [c1, c2, c3, typed].forEach((x) => x?.addEventListener('input', update));
  const confirm = h('div', { class: 'confirm' },
    h('label', {}, c1, 'I reviewed the list above. Only these accounts will be touched.'),
    c2 ? h('label', {}, c2, h('span', {}, h('b', { class: 'red' }, 'I understand burns are permanent and irreversible. '), 'Burned tokens and NFTs are gone forever.')) : null,
    c3 ? h('label', {}, c3, `I know ${valuable.length} token(s) have an estimated value of ${usd(valSum)} and I still want to destroy them.`) : null,
    typed);
  const progress = h('div', { class: 'progress', id: 'progress' });
  go.addEventListener('click', () => execute(p, progress, go));
  body.replaceChildren(...sec, ...warns, totals,
    h('p', { class: 'simok' }, `✓ All ${p.totals.txCount} transaction(s) simulated successfully on ${S.cluster}. Your wallet will show the same transactions to sign.`),
    confirm, h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => $('#reviewDlg').close() }, 'Cancel'), go), progress);
}

async function execute(p, progress, go) {
  if (S.busy) return;
  S.busy = true; go.disabled = true; renderList();
  const line = (...k) => { const el = h('div', {}, ...k); progress.append(el); return el; };
  let reclaimed = 0;
  try {
    const l1 = line(h('span', { class: 'spin' }), 'Re-simulating with a fresh blockhash…');
    const items = p.transactions.flatMap((t) => t.items);
    const fresh = await prepareTransactions({ connection: conn(), owner: S.owner, items, fee: fee(), priorityMicroLamports: prio(), maxActionsPerTx: CFG.MAX_ACTIONS_PER_TX });
    if (fresh.totals.feeLamports > p.totals.feeLamports || fresh.totals.netLamports < p.totals.netLamports) throw new Error('Amounts changed since you reviewed them. Nothing was sent. Please review again.');
    l1.replaceChildren('✓ Re-simulated: amounts match what you reviewed.');
    const l2 = line(h('span', { class: 'spin' }), `Waiting for ${S.wallet.name} to sign ${fresh.transactions.length} transaction(s)…`);
    const signed = await W.signAll(S.wallet, S.account, fresh.transactions.map((t) => t.tx.serialize()), S.cluster);
    if (signed.length !== fresh.transactions.length) throw new Error('Wallet returned an unexpected number of transactions.');
    signed.forEach((b, i) => auditSigned(fresh.transactions[i].tx, b, S.owner));
    l2.replaceChildren('✓ Signed. Wallet output verified.');
    for (let i = 0; i < signed.length; i++) {
      const li = line(h('span', { class: 'spin' }), `Sending ${i + 1}/${signed.length}…`);
      try {
        const sig = await sendSigned(conn(), signed[i], { lastValidBlockHeight: fresh.lastValidBlockHeight });
        reclaimed += fresh.transactions[i].netLamports;
        li.replaceChildren(`✓ ${i + 1}/${signed.length} confirmed `, h('a', { href: explorer('tx', sig), target: '_blank', rel: 'noopener' }, short(sig, 8)));
      } catch (e) { li.replaceChildren(h('span', { class: 'red' }, `✗ ${i + 1}/${signed.length} failed: ${e?.message || e}`)); }
    }
    line(h('b', { class: 'g' }, `Done. About ${sol(reclaimed)} net returned to your wallet.`));
  } catch (e) {
    line(h('span', { class: 'red' }, `✗ ${e?.message || e}`));
  } finally {
    S.busy = false;
    progress.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => { $('#reviewDlg').close(); scan(); } }, 'Close & rescan')));
    renderList();
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
renderFeeText(); renderCluster(); renderRefNote();
// Silent reconnect to the last wallet if it exposes an already-authorized account.
setTimeout(() => {
  const last = localStorage.getItem('gb_wallet');
  const w = last && W.listWallets().find((x) => x.name === last);
  if (w && w.accounts?.length) { S.wallet = w; S.account = w.accounts[0]; S.owner = new PublicKey(w.accounts[0].address); afterConnect(); }
}, 400);

// ── Installable app: service worker (own static files only) + install hint ──
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}); });
}
(function installHint() {
  const KEY = 'gb_install_dismissed';
  let dismissed = false; try { dismissed = localStorage.getItem(KEY) === '1'; } catch {}
  if (IS_STANDALONE || dismissed) return;
  const box = $('#install'), txt = $('#installTxt'), btn = $('#installBtn');
  let deferred = null;
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const inWalletBrowser = () => W.listWallets().length > 0; // installing from inside Phantom etc. isn't possible
  const hide = (remember) => { box.hidden = true; if (remember) { try { localStorage.setItem(KEY, '1'); } catch {} } };
  $('#installX').addEventListener('click', () => hide(true));
  if (isIOS) {
    setTimeout(() => {
      if (inWalletBrowser() || !/Safari/i.test(ua)) return;
      txt.innerHTML = '<b>Install Ghost Burner:</b> tap <svg class="shr" viewBox="0 0 24 24" fill="none" stroke="#3ee08f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v8h14v-8"/></svg> <b>Share</b>, then <b>Add to Home Screen</b>.';
      box.hidden = false;
    }, 1500);
    return;
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferred = e;
    txt.innerHTML = '<b>Install Ghost Burner</b> for one-tap access from your home screen.';
    btn.hidden = false; box.hidden = false;
  });
  btn.addEventListener('click', () => { if (!deferred) return; deferred.prompt(); deferred.userChoice.then(() => { deferred = null; hide(false); }); });
  window.addEventListener('appinstalled', () => hide(true));
})();
