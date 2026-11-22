// Worker für Erzeugen und Backen. Wird als Modul-Worker gestartet:
//   new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
// Nachrichten: { type: 'init', module, config, sun, maxCache } → { type: 'ready' }
//              { type: 'build', id, req } → { type: 'done', id, r, stats } oder { type: 'error', id, message }
import { Builder, transferList } from './builder.js';

let builder = null, ready = null;
self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'init') {
    ready = import(m.module).then(mod => {
      builder = new Builder(mod.createGenerator(m.config), m.config.seed, { sun: m.sun, maxCache: m.maxCache });
      self.postMessage({ type: 'ready' });
    }).catch(err => self.postMessage({ type: 'error', id: -1, message: String(err && err.stack || err) }));
    return;
  }
  if (m.type === 'build') {
    await ready;
    try {
      const r = builder.build(m.req, true);
      self.postMessage({ type: 'done', id: m.id, r, stats: builder.stats }, transferList(r));
    } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) }); }
  }
};
