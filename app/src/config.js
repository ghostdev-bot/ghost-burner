// ─────────────────────────────────────────────────────────────────────────────
//  Ghost Burner configuration — the ONLY file you need to edit before launch.
// ─────────────────────────────────────────────────────────────────────────────

// Service fee recipients ("legs"). Each leg gets floor(reclaimed * bps / 10000)
// lamports, as its own SystemProgram transfer inside the same transaction.
// Fee is charged ONLY on SOL rent actually reclaimed, never on token value.
// A leg whose address is empty/placeholder is dropped (no transfer).
// A leg that would leave its recipient below the rent-exempt minimum is waived.
export const FEE_RECIPIENTS = [
  { label: '$GHOSTDEV treasury', address: 'E3MnPuZXY52cisZj5p47x2seZn2kR1JzVs125mvSMkAY', bps: 100 },
  { label: 'BOBO buy', address: 'AgKx7ZTkRB13j2Ai5g1pLeUVoxdGbKbRVn4HGJrzr4C2', bps: 100 },
];
// Referral program. With a valid ?ref=<wallet> link, `bps` of the fee is carved out
// of the leg whose address is `from` (the treasury) and paid to the referrer as a
// plain SystemProgram transfer in the same transaction. The TOTAL fee is unchanged:
//   no / invalid referrer: 1% treasury + 1% BOBO buy
//   valid referrer:        0.5% treasury + 0.5% referrer + 1% BOBO buy
// A referrer cut below `minLamports`, or too small for a brand-new (unfunded)
// wallet to receive (rent-exempt minimum, read live from the chain: 650,240 lamports on mainnet as of Oct 2026), goes to the treasury instead.
export const REFERRAL = { bps: 50, from: 'E3MnPuZXY52cisZj5p47x2seZn2kR1JzVs125mvSMkAY', minLamports: 5000 };
// Test builds only: VITE_REFERRAL_FROM overrides `from` (devnet stand-in treasury).
export const EFFECTIVE_REFERRAL = (import.meta.env && import.meta.env.VITE_REFERRAL_FROM) ? { ...REFERRAL, from: import.meta.env.VITE_REFERRAL_FROM } : REFERRAL;

// Hard cap on the SUM of all legs (2000 = 20%). Config above this refuses to load.
export const MAX_FEE_BPS = 2000;
// Test builds only: VITE_FEE_RECIPIENTS='[{"label":..,"address":..,"bps":..}]' overrides the list above.
export const EFFECTIVE_FEE_RECIPIENTS = (import.meta.env && import.meta.env.VITE_FEE_RECIPIENTS) ? JSON.parse(import.meta.env.VITE_FEE_RECIPIENTS) : FEE_RECIPIENTS;

// RPC endpoints, tried in order. The app fails over automatically on 403/429,
// network/CORS errors or "method blocked" replies (per method, sticky).
// Primary mainnet RPC: Helius (keyed). The URL is injected at build time from
// VITE_HELIUS_RPC so the key never lives in source control; it IS visible in the
// shipped JS (any browser RPC key is), so restrict it to this domain in the Helius
// dashboard. With Helius the scan uses getTokenAccountsByOwner directly (full
// on-chain scan); the keyless fallbacks below block that method from browsers, so
// if Helius is unavailable the scan falls back to Jupiter's holdings index.
const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const NODE_ENV = (typeof process !== 'undefined' && process.env) || {};
export const HELIUS_RPC = ENV.VITE_HELIUS_RPC || NODE_ENV.VITE_HELIUS_RPC || '';
export const RPC_ENDPOINTS = {
  'mainnet-beta': [
    HELIUS_RPC,
    'https://solana-rpc.publicnode.com',
    'https://rpc.solanatracker.io/public',
    'https://api.mainnet-beta.solana.com',
  ].filter(Boolean),
  devnet: ['https://api.devnet.solana.com'],
};
// Client-side request ceilings (requests per second, per browser tab) by host.
// Helius free plan = 10 RPS shared with other sites, so stay well under it.
export const RPC_RATE_LIMITS = { 'helius-rpc.com': 6 };
// Redact API keys before showing any RPC URL in the UI or logs.
export const redactRpc = (u) => String(u || '').replace(/([?&](api[-_]?key|key|token)=)[^&\s]+/gi, '$1***');
export const RPC = Object.fromEntries(Object.entries(RPC_ENDPOINTS).map(([k, v]) => [k, v[0]]));
// Token-account discovery fallback (mainnet). Returns account addresses incl. empty ones.
export const HOLDINGS_API = 'https://lite-api.jup.ag/ultra/v1/holdings/';
export const DEFAULT_CLUSTER = 'mainnet-beta';

// Optional priority fee (micro-lamports per compute unit). Included in the
// network fee shown on the review screen.
export const PRIORITY_FEE_MICROLAMPORTS = { 'mainnet-beta': 5000, devnet: 0 };

// Tokens worth more than this (USD) get a loud warning when selected for burn.
export const VALUE_WARN_USD = 1;

// Max account actions per transaction (also bounded by the 1232-byte limit).
export const MAX_ACTIONS_PER_TX = 10;

// Public token metadata / price source (mainnet only). Unknown = "unknown".
export const TOKEN_INFO_API = 'https://lite-api.jup.ag/tokens/v2/search?query=';

export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
