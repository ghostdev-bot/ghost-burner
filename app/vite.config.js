import { defineConfig } from 'vite';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

// Emits sw.js with a versioned cache name and the exact list of built static files.
function serviceWorker() {
  return {
    name: 'gb-sw', apply: 'build',
    generateBundle(_, bundle) {
      const pub = (d, base = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? pub(path.join(d, e.name), base + e.name + '/') : [base + e.name]);
      const files = [...Object.keys(bundle).filter((f) => f !== 'sw.js' && !f.endsWith('.map')), ...pub('public')].filter((f) => f !== 'sw.js' && f !== 'CNAME');
      const shell = ['/', '/refer.html', '/how.html', ...new Set(files.map((f) => '/' + f.replace(/^\.?\//, '')))].sort();
      const h = crypto.createHash('sha256');
      for (const f of Object.keys(bundle).sort()) { const o = bundle[f]; h.update(f); h.update(o.type === 'chunk' ? o.code : o.source); }
      const version = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + h.digest('hex').slice(0, 8);
      const src = fs.readFileSync('sw.template.js', 'utf8').replace('__VERSION__', version).replace('__SHELL__', JSON.stringify(shell));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}
export default defineConfig({ base: './', plugins: [serviceWorker()], build: { outDir: '../site', emptyOutDir: true, sourcemap: false, target: 'es2020', rollupOptions: { input: { main: path.resolve('index.html'), refer: path.resolve('refer.html'), how: path.resolve('how.html') } } } });
