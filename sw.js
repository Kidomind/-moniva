/* Moniva · service worker
   1) Çevrimdışı çalışma: önce ağ, olmazsa önbellek (güncellemeler otomatik gelir)
   2) Bildirimler: uygulama yaklaşan ödemeleri ve günlük hatırlatma ayarını "tbd-data"
      önbelleğine yazar; tarayıcı arka planda uyandırınca (periodicsync) ya da uygulama
      mesaj gönderince buradan telefon bildirimi üretilir.
   3) push: ileride sunucudan push gelirse de aynı bildirim görünümü kullanılır. */
const V = 'moniva-shell-v3', DATA = 'tbd-data';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-96.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'badge-96.png'];
const ICON = 'icon-192.png', BADGE = 'badge-96.png';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V && k !== DATA).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return; // kur API'leri vb. dışarıda kalsın
  e.respondWith(
    fetch(r)
      .then(res => {
        if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); }
        return res;
      })
      .catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || caches.match('index.html') || caches.match('./')))
  );
});

/* ---- Ortak bildirim görünümü ---- */
function show(title, o) {
  o = o || {};
  return self.registration.showNotification(title, Object.assign({
    icon: ICON,
    badge: BADGE,
    lang: 'tr',
    dir: 'ltr',
    timestamp: Date.now(),
    vibrate: [180, 90, 180],
    renotify: true,
    requireInteraction: false,
    silent: false,
    data: { url: './' }
  }, o));
}

/* ---- Bildirim metni ---- */
const tl = n => Math.round(n).toLocaleString('tr-TR') + ' ₺';
const when = k => k < 0 ? (-k) + ' gün gecikti' : k === 0 ? 'bugün' : k === 1 ? 'yarın' : k + ' gün sonra';

function dueText(items, lead, amt, today) {
  const t0 = Date.parse(today + 'T00:00:00');
  const L = items
    .map(x => ({ n: x.n, m: x.m, k: Math.round((Date.parse(x.dt + 'T00:00:00') - t0) / 864e5) }))
    .filter(x => x.k <= lead && x.k >= -31)
    .sort((a, b) => a.k - b.k);
  if (!L.length) return null;
  const late = L.some(x => x.k < 0), todayDue = L.some(x => x.k === 0);
  const emoji = late ? '⚠️' : todayDue ? '⏰' : '💳';
  if (L.length === 1) {
    const x = L[0];
    return {
      title: emoji + ' ' + x.n + ' · ' + when(x.k),
      body: amt ? tl(x.m) + ' ödemen var. Ödedikten sonra uygulamadan işaretlemeyi unutma.' : 'Ödeme günü yaklaşıyor. Ödedikten sonra uygulamadan işaretle.',
      tag: 'moniva-due'
    };
  }
  const tot = L.reduce((s, x) => s + x.m, 0);
  return {
    title: emoji + ' ' + L.length + ' ödemen ' + (late ? 'var (gecikenler dahil)' : 'yaklaşıyor'),
    body: L.slice(0, 4).map(x => '• ' + x.n + ' · ' + when(x.k) + (amt ? ' · ' + tl(x.m) : '')).join('\n') + (L.length > 4 ? '\n…ve ' + (L.length - 4) + ' ödeme daha' : '') + (amt ? '\nToplam: ' + tl(tot) : ''),
    tag: 'moniva-due'
  };
}

const p2 = n => ('0' + n).slice(-2);
const isoToday = () => { const t = new Date(); return t.getFullYear() + '-' + p2(t.getMonth() + 1) + '-' + p2(t.getDate()); };
const minNow = () => { const t = new Date(); return t.getHours() * 60 + t.getMinutes(); };

async function load() {
  const c = await caches.open(DATA);
  const key = new URL('dues.json', self.registration.scope).href;
  const r = await c.match(key);
  return { c, key, p: r ? await r.json() : null };
}
const save = (c, key, p) => c.put(key, new Response(JSON.stringify(p), { headers: { 'content-type': 'application/json' } }));

async function check() {
  const { c, key, p } = await load();
  if (!p || !p.on) return;
  const today = isoToday();
  let dirty = false;

  /* ödeme hatırlatması: seçilen saatten sonra, günde bir kez */
  if (p.nd !== today && minNow() >= (p.h == null ? 9 : p.h) * 60) {
    const t = dueText(p.items || [], p.lead, p.amt, today);
    if (t) {
      await show(t.title, {
        body: t.body,
        tag: t.tag,
        requireInteraction: true,
        actions: [{ action: 'open', title: 'Ödemelere bak' }, { action: 'dismiss', title: 'Tamam' }],
        data: { url: './?go=cal' }
      });
      p.nd = today; dirty = true;
    }
  }

  /* günlük "harcama girdin mi?" */
  const d = p.daily;
  if (d && d.nd !== today && !d.has && minNow() >= d.h * 60 + d.m) {
    await show('💰 Bugün harcama girdin mi?', {
      body: 'Küçük harcamalar bile büyür. Şimdi 10 saniyede ekle.',
      tag: 'moniva-daily',
      actions: [{ action: 'add', title: '+ Harcama ekle' }, { action: 'dismiss', title: 'Sonra' }],
      data: { url: './?add=1' }
    });
    d.nd = today; dirty = true;
  }
  if (dirty) await save(c, key, p);
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'tbd-dues') e.waitUntil(check());
});

/* Uygulamadan gelen mesajlar: {type:'check'} ya da {type:'test', delay, title, body, url} */
self.addEventListener('message', e => {
  const m = e.data || {};
  if (m.type === 'check') e.waitUntil(check());
  if (m.type === 'test') {
    e.waitUntil(new Promise(res => setTimeout(res, Math.min(+m.delay || 0, 30000))).then(() =>
      show(m.title || '💳 Moniva', {
        body: m.body || 'Test bildirimi: hatırlatmalar bu şekilde görünecek.',
        tag: 'moniva-test',
        actions: [{ action: 'open', title: 'Uygulamayı aç' }],
        data: { url: m.url || './' }
      })
    ));
  }
});

/* Sunucudan push gelirse: {title, body, url} */
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (x) { m = { body: e.data && e.data.text() }; }
  e.waitUntil(show(m.title || 'Moniva', { body: m.body || '', tag: m.tag || 'moniva-push', data: { url: m.url || './' } }));
});

self.addEventListener('notificationclick', e => {
  const n = e.notification;
  n.close();
  if (e.action === 'dismiss') return;
  const url = new URL((n.data && n.data.url) || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      for (const c of cs) {
        if ('focus' in c) {
          // açık pencere varsa öne getir ve derin bağlantıya götür, yoksa yeni pencerede aç
          return c.focus().then(w => (w && 'navigate' in w) ? w.navigate(url).catch(() => {}) : null);
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
