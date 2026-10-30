import './style.css';
import { captureRef } from './core/referral.js';
import * as CFG from './config.js';
import { initNav } from './nav.js';

const store = (() => { try { localStorage.getItem('x'); return localStorage; } catch { return { getItem: () => null, setItem() {}, removeItem() {} }; } })();
// A ?ref= on this page counts too (same rules as the other pages).
const NO_REF = [...new Set([...CFG.EFFECTIVE_FEE_RECIPIENTS, ...CFG.FEE_RECIPIENTS].map((r) => r.address).concat(CFG.REFERRAL.from))];
captureRef(location.search, store, { exclude: NO_REF });
initNav(store);
