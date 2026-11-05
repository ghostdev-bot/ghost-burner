#!/usr/bin/env python3
"""Headless UI check: pages load without console errors, Security link in More menu + footer,
burn page connects a signing-DISABLED mock wallet (public address only) and scans it.
Usage: ui_check.py <base_url> <shot_dir> <tag>"""
import json, os, sys
from playwright.sync_api import sync_playwright
BASE, SHOTS, TAG = sys.argv[1].rstrip('/'), sys.argv[2], sys.argv[3]
W = os.environ.get('GB_SCAN_ADDR', '3Lyh3sHYNmMybUTPqK8MfND1DmbijkY2n1wvztivp8JN')
ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58dec(s):
    n = 0
    for c in s: n = n * 58 + ALPH.index(c)
    return list(n.to_bytes(32, 'big'))
MOCK = open('/workspace/ghostburner/devnet-test/mockwallet.js').read().replace('__ADDRESS__', W).replace('__PUBKEY__', json.dumps(b58dec(W)))
res = {"base": BASE, "pages": {}, "scan": None, "shots": []}
os.makedirs(SHOTS, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    def ctxpage(mobile=False, wallet=False):
        ctx = b.new_context(viewport={'width': 390, 'height': 844} if mobile else {'width': 1366, 'height': 900}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile, service_workers='block')
        if wallet: ctx.add_init_script(MOCK)
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)[:200]))
        pg.on('console', lambda m: errs.append(f'console.{m.type}: ' + m.text[:200]) if m.type == 'error' else None)
        return ctx, pg, errs
    def shot(pg, name, **kw):
        path = f'{SHOTS}/{TAG}_{name}.png'; pg.screenshot(path=path, **kw); res['shots'].append(path)
    for page in ['/', '/how.html', '/refer.html', '/security.html']:
        for mobile in (False, True):
            ctx, pg, errs = ctxpage(mobile)
            r = pg.goto(BASE + page); pg.wait_for_load_state('networkidle'); pg.wait_for_timeout(600)
            info = {"status": r.status, "title": pg.title(), "errors": errs,
                    "footer_security_link": pg.locator('footer a[href*="security.html"]').count() > 0 or page == '/security.html'}
            pg.click('nav.top details.more summary'); pg.wait_for_timeout(200)
            info["menu_security_link_visible"] = pg.locator('nav.top .menu a[href*="security.html"]').is_visible()
            if page == '/security.html':
                if not mobile: shot(pg, 'security_menu_open')
                pg.keyboard.press('Escape')
                info["has_not_audited"] = 'not' in pg.inner_text('.howto') and 'audit' in pg.inner_text('.howto')
                info["scan_stamp"] = pg.inner_text('.scanstamp')
                info["solscan_links"] = pg.locator('a[href^="https://solscan.io/account/"]').count()
                shot(pg, f'security_{"mobile" if mobile else "desktop"}', full_page=True)
            res["pages"][f'{page} {"mobile" if mobile else "desktop"}'] = info
            ctx.close()
    # Burn flow: connect mock wallet (cannot sign) and scan
    ctx, pg, errs = ctxpage(mobile=False, wallet=True)
    pg.goto(BASE + '/'); pg.wait_for_load_state('networkidle')
    pg.click('#heroConnect'); pg.click('text=Ghost Test Wallet')
    pg.wait_for_function("() => document.querySelector('.row-i') || /fail|error/i.test(document.querySelector('#scanMsg')?.innerText||'')", timeout=120000)
    pg.wait_for_timeout(3000)
    res["scan"] = {"address": W, "rows": pg.locator('.row-i').count(),
                   "tabs": pg.evaluate("[...document.querySelectorAll('[data-tab]')].map(e=>e.innerText.replace(/\\s+/g,' ')).join(' | ')"),
                   "scanMsg": pg.inner_text('#scanMsg') if pg.is_visible('#scanMsg') else '', "errors": errs,
                   "sign_requests": pg.evaluate("window.__signRequests||0")}
    shot(pg, 'burn_scan_desktop')
    ctx.close(); b.close()
print(json.dumps(res, indent=1))
