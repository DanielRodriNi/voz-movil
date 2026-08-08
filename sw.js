// Cachea el "shell" de la app y los modulos del CDN para que funcione sin conexion.
// Los modelos de voz NO pasan por aqui: la libreria ya los guarda en OPFS.

const CACHE = 'voz-v7';

const SHELL = [
  '.',
  'index.html',
  'app.js',
  'wav.js',
  'vendor/piper-tts-web.js',
  'distorsionador.html',
  'distorsionador.js',
  'worklets/voice-fx-worklet.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
];

// Origenes de los que merece la pena cachear en tiempo de ejecucion
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Si un fichero falla no queremos abortar toda la instalacion
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isCdn = CDN_HOSTS.includes(url.hostname);
  if (!sameOrigin && !isCdn) return; // p.ej. huggingface: lo gestiona la libreria

  // Cache primero: el shell y los modulos del CDN estan versionados y no cambian
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => {
        // Sin red y sin cache: si pedian una pagina, servimos el shell
        if (req.mode === 'navigate') return caches.match('index.html');
        throw new Error('offline');
      });
    })
  );
});
