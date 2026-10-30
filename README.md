# 👻 Ghost Burner

Close empty Solana token accounts (SPL and Token-2022) and burn junk tokens or standard Metaplex NFTs to reclaim the SOL rent locked in them.

**Live:** https://ghostburner.surge.sh

A static, client-side app. There is no backend and no custody: your wallet (Phantom, Solflare, Backpack, or any Wallet Standard wallet) signs every transaction, and each one is simulated before you sign.

## Fee model
- 2% of the SOL rent actually reclaimed. Token value is never charged.
- Without a referral: 1% to the $GHOSTDEV treasury and 1% to the BOBO buy wallet.
- With a valid `?ref=<wallet>` link: 0.5% treasury, 0.5% referrer, 1% BOBO buy. The total stays the same.
- Every fee leg is a plain `SystemProgram` transfer inside the same transaction, so you can see it on the review screen and in the explorer.
- A leg is waived if it would leave the recipient below the rent-exempt minimum. A referrer cut that is too small goes to the treasury instead.
- The recipients and basis points are in `app/src/config.js` (`FEE_RECIPIENTS`, `REFERRAL`). There is a hard cap of 20% (`MAX_FEE_BPS`).

## Run / build
```bash
cd app
npm install
cp .env.example .env        # optional: set VITE_HELIUS_RPC to your own RPC URL
npm run dev                 # local dev server
npm run build               # static build into ../site (git-ignored)
```

## Configuration (env vars)
| Var | Purpose |
| --- | --- |
| `VITE_HELIUS_RPC` | Optional primary mainnet RPC URL. Without it the app uses public RPCs (publicnode, solanatracker, mainnet-beta) and Jupiter's holdings index for discovery. |
| `VITE_FEE_RECIPIENTS` | Test builds only: JSON override of the fee legs. |
| `VITE_REFERRAL_FROM` | Test builds only: overrides the leg the referral cut comes from. |

Note: any RPC key passed in a `VITE_` variable ends up in the shipped JavaScript, as every browser key does. Use a key that is restricted to your domain, and never commit `.env` or a built `site/` folder.

## Layout
- `src/core/burner.js`: scan, classify, batch, simulate, and send
- `src/core/metaplex.js`: metadata parsing and Token Metadata `BurnV1`
- `src/core/referral.js`, `referral-stats.js`: referral validation and earnings estimate
- `src/core/rpc.js`: multi-endpoint RPC with failover and rate limiting
- `src/wallet.js`: Wallet Standard connection
- `sw.template.js` + `vite.config.js`: installable PWA with a versioned service worker

## Disclaimer
Burning is irreversible. The app warns about tokens with value, but you are responsible for what you select. Not financial advice.

## License
MIT
