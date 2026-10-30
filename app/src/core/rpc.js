// Multi-endpoint RPC: a fetch() for web3.js Connection that fails over to the next
// endpoint on network/CORS errors, HTTP 401/402/403/408/429/5xx, or JSON-RPC errors
// that mean "this endpoint refuses this method" (keyless public RPCs often block
// indexed methods such as getTokenAccountsByOwner). Sticky per method.
import { Connection } from '@solana/web3.js';

const RETRY_HTTP = new Set([401, 402, 403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const RETRY_RPC_CODES = new Set([403, 429, 35, -32029, -32601, -16401, -32005]);
const RETRY_RPC_MSG = /forbidden|blocked|rate.?limit|too many|api.?key|personal token|paid plan|upgrade|not available|unauthori[sz]ed|method not found/i;

const redact = (u) => String(u || '').replace(/([?&](api[-_]?key|key|token)=)[^&\s]+/gi, '$1***');

// Leaky-bucket limiter: requests to a limited host are spaced >= 1000/rps ms
// apart (per tab), so any 1-second window holds at most ~rps requests.
function makeLimiter(limits = {}) {
  const next = new Map();
  return async function wait(url) {
    let host = ''; try { host = new URL(url).host; } catch {}
    const key = Object.keys(limits).find((k) => host.endsWith(k));
    if (!key) return;
    const gap = Math.ceil(1000 / limits[key]);
    const now = Date.now();
    const slot = Math.max(now, next.get(key) || 0);
    next.set(key, slot + gap);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  };
}

export function isRetriableRpcError(err) {
  if (!err) return false;
  return RETRY_RPC_CODES.has(err.code) || RETRY_RPC_MSG.test(String(err.message || ''));
}

export function makeFailoverFetch(endpoints, { timeoutMs = 20000, rounds = 2, onSwitch = () => {}, log = () => {}, rateLimits = {} } = {}) {
  const urls = [...new Set(endpoints.filter(Boolean))];
  const throttle = makeLimiter(rateLimits);
  const stats = { requests: 0, byHost: {} };
  const sticky = new Map(); // method -> index of last endpoint that worked
  const f = async function failoverFetch(_input, init = {}) {
    let method = 'batch';
    try { const b = JSON.parse(init.body); method = Array.isArray(b) ? 'batch' : b.method; } catch {}
    const start = sticky.get(method) ?? 0;
    let last = null;
    for (let k = 0; k < urls.length * rounds; k++) {
      if (k && k % urls.length === 0) await new Promise((r) => setTimeout(r, 800)); // brief backoff, then one more pass
      const i = (start + k) % urls.length, url = urls[i];
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        await throttle(url);
        stats.requests++; { let h = ''; try { h = new URL(url).host; } catch {} stats.byHost[h] = (stats.byHost[h] || 0) + 1; }
        const r = await fetch(url, { ...init, signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        const text = await r.text();
        let j = null; try { j = JSON.parse(text); } catch {}
        const rpcErr = j && !Array.isArray(j) ? j.error : null;
        if (RETRY_HTTP.has(r.status) || (rpcErr && isRetriableRpcError(rpcErr)) || (!j && !r.ok)) {
          last = { url, status: r.status, text };
          log(`rpc ${method} @ ${redact(url)}: ${r.status} ${rpcErr ? rpcErr.code + ' ' + rpcErr.message : ''}`.trim());
          continue;
        }
        if (sticky.get(method) !== i) { sticky.set(method, i); if (k > 0) onSwitch(method, redact(url)); }
        f.lastGood = url;
        return new Response(text, { status: r.status === 200 || j ? 200 : r.status, headers: { 'content-type': 'application/json' } });
      } catch (e) {
        last = { url, error: e };
        log(`rpc ${method} @ ${redact(url)}: ${e?.name || e}`);
      } finally { clearTimeout(t); }
    }
    // Every endpoint refused: surface the last response (or a network error).
    if (last?.text !== undefined) return new Response(last.text, { status: last.status, headers: { 'content-type': 'application/json' } });
    throw new TypeError(`All RPC endpoints failed (${urls.map(redact).join(', ')}): ${last?.error?.message || last?.error}`);
  };
  f.endpoints = urls;
  f.stats = stats;
  return f;
}

export function makeConnection(endpoints, { commitment = 'confirmed', ...opts } = {}) {
  const list = Array.isArray(endpoints) ? endpoints : [endpoints];
  const fetchFn = makeFailoverFetch(list, opts);
  // web3.js's own 429 retry would hammer one endpoint; failover handles it instead.
  const c = new Connection(list[0], { commitment, fetch: fetchFn, disableRetryOnRateLimit: true });
  c.endpoints = fetchFn.endpoints;
  c.rpcStats = fetchFn.stats;
  return c;
}
