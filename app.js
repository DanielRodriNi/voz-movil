// Texto a voz 100% en el navegador con Piper (ONNX Runtime Web + espeak-ng en WASM).
// No hay servidor: el modelo se descarga una vez y se guarda en el dispositivo.

// Copia local parcheada: la oficial de jsDelivr fuerza siempre el hablante 0
// en voces multi-hablante (ver vendor/piper-tts-web.js).
const PIPER_URL = './vendor/piper-tts-web.js';

const $ = (id) => document.getElementById(id);
const els = {
  text: $('text'), voice: $('voice'), speed: $('speed'), speedVal: $('speedVal'),
  go: $('go'), bar: $('bar'), status: $('status'), result: $('result'),
  player: $('player'), dl: $('dl'),
};

let piper = null;         // modulo cargado en diferido
let session = null;       // TtsSession reutilizada entre frases
let loadedVoice = null;   // voz que hay realmente cargada en la sesion
let loadedSpeaker = null; // hablante que hay realmente cargado en la sesion
let busy = false;
let lastUrl = null;

/**
 * El <option> puede llevar el hablante pegado como "voiceId:speakerId"
 * (p.ej. voces con varios locutores en el mismo modelo, tipo sharvard).
 * Sin ":" se asume el hablante 0.
 */
function parseVoiceValue(v) {
  const i = v.indexOf(':');
  return i === -1 ? { voiceId: v, speakerId: 0 } : { voiceId: v.slice(0, i), speakerId: Number(v.slice(i + 1)) };
}

function say(msg, kind = '') {
  els.status.textContent = msg;
  els.status.className = kind;
}

function showBar(on, value = 0) {
  if (on) els.bar.setAttribute('data-on', '');
  else els.bar.removeAttribute('data-on');
  els.bar.value = value;
}

// --- Velocidad: se aplica a la reproduccion, sin regenerar ni alterar el tono ---
els.speed.addEventListener('input', () => {
  const v = Number(els.speed.value);
  els.speedVal.textContent = v.toFixed(1) + '×';
  els.player.playbackRate = v;
  els.player.preservesPitch = true;
  els.player.mozPreservesPitch = true;
  els.player.webkitPreservesPitch = true;
});

// Guarda el texto para no perderlo al cerrar la pestaña
try {
  els.text.value = localStorage.getItem('voz.text') || '';
  els.text.addEventListener('input', () => localStorage.setItem('voz.text', els.text.value));
  const v = localStorage.getItem('voz.voice');
  if (v && [...els.voice.options].some((o) => o.value === v)) els.voice.value = v;
  els.voice.addEventListener('change', () => localStorage.setItem('voz.voice', els.voice.value));
} catch { /* modo privado: seguimos sin persistencia */ }

/**
 * Parte el texto en trozos que espeak digiere bien: primero por frases,
 * y si una frase es larguisima, por comas. Evita bloquear el hilo y da progreso.
 */
function splitText(text, maxLen = 300) {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…:;])\s+/)
    .filter(Boolean);

  const chunks = [];
  for (const s of sentences) {
    if (s.length <= maxLen) { chunks.push(s); continue; }
    let buf = '';
    for (const part of s.split(/(?<=,)\s+/)) {
      if ((buf + ' ' + part).trim().length > maxLen && buf) { chunks.push(buf.trim()); buf = part; }
      else buf = (buf + ' ' + part).trim();
    }
    // Si aun asi es enorme (texto sin puntuacion), corta duro por longitud
    while (buf.length > maxLen) { chunks.push(buf.slice(0, maxLen)); buf = buf.slice(maxLen); }
    if (buf) chunks.push(buf);
  }
  return chunks.length ? chunks : [text.trim()];
}

/** Codifica muestras Float32 mono en un WAV PCM 16 bits. */
function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);      // tamaño del bloque fmt
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);       // block align
  view.setUint16(34, 16, true);      // bits por muestra
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Une los WAV de cada frase en uno solo y normaliza el volumen.
 * La normalizacion importa: entre voces el pico varia mucho (medido: 0.94 en
 * davefx frente a 0.36 en sharvard), asi que sin esto unas suenan mucho mas
 * flojas que otras.
 */
async function buildWav(blobs) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buffers = [];
    for (const b of blobs) buffers.push(await ctx.decodeAudioData(await b.arrayBuffer()));

    const gap = Math.round(ctx.sampleRate * 0.14); // respiro entre frases
    const total = buffers.reduce((n, b) => n + b.length, 0) + gap * (buffers.length - 1);
    const out = new Float32Array(total);

    let pos = 0;
    buffers.forEach((b, i) => {
      out.set(b.getChannelData(0), pos);
      pos += b.length + (i < buffers.length - 1 ? gap : 0);
    });

    let peak = 0;
    for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
    if (peak > 1e-4) {
      const g = 0.89 / peak;
      for (let i = 0; i < out.length; i++) out[i] *= g;
    }

    return encodeWav(out, ctx.sampleRate);
  } finally {
    ctx.close();
  }
}

/**
 * Devuelve una sesion lista para `voiceId` + `speakerId`.
 * TtsSession es un singleton que NO recarga el modelo al cambiar de voz
 * (ni de hablante), asi que al cambiar cualquiera de los dos hay que
 * descartar la instancia y crear una nueva. Si el .onnx ya esta en OPFS
 * (caso tipico al cambiar solo de hablante) no se vuelve a descargar.
 */
async function getSession(voiceId, speakerId, onProgress) {
  if (session && loadedVoice === voiceId && loadedSpeaker === speakerId) return session;

  piper.TtsSession._instance = null;
  session = await piper.TtsSession.create({ voiceId, speakerId, progress: onProgress });
  loadedVoice = voiceId;
  loadedSpeaker = speakerId;
  return session;
}

async function generate() {
  if (busy) return;
  const text = els.text.value.trim();
  if (!text) { say('Escribe algo primero.', 'err'); return; }

  busy = true;
  els.go.disabled = true;
  els.result.removeAttribute('data-on');

  try {
    if (!piper) {
      say('Cargando el motor de voz…');
      showBar(true, 0);
      piper = await import(/* @vite-ignore */ PIPER_URL);
    }

    const { voiceId, speakerId } = parseVoiceValue(els.voice.value);
    const isNew = loadedVoice !== voiceId || loadedSpeaker !== speakerId;
    if (isNew) say('Preparando la voz… (la primera vez descarga el modelo)');

    const onProgress = (p) => {
      if (!p || !p.total) return;
      const pct = Math.round((p.loaded * 100) / p.total);
      showBar(true, pct);
      say(`Descargando la voz… ${pct}%`);
    };

    const s = await getSession(voiceId, speakerId, onProgress);

    const chunks = splitText(text);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      say(chunks.length > 1 ? `Generando… frase ${i + 1} de ${chunks.length}` : 'Generando…');
      showBar(true, Math.round((i * 100) / chunks.length));
      parts.push(await s.predict(chunks[i]));
      // Cede el hilo para que la interfaz se refresque en el movil
      await new Promise((r) => setTimeout(r, 0));
    }

    const wav = await buildWav(parts);

    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(wav);
    els.player.src = lastUrl;
    els.player.playbackRate = Number(els.speed.value);
    els.player.preservesPitch = true;
    els.dl.href = lastUrl;
    els.dl.download = `voz-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.wav`;
    els.result.setAttribute('data-on', '');

    showBar(false);
    say(`Listo · ${(wav.size / 1e6).toFixed(1)} MB`, 'ok');
  } catch (err) {
    console.error(err);
    showBar(false);
    // Una voz a medio descargar deja la sesion inservible: la descartamos
    session = null;
    loadedVoice = null;
    loadedSpeaker = null;
    say('Error: ' + (err && err.message ? err.message : err), 'err');
  } finally {
    busy = false;
    els.go.disabled = false;
  }
}

els.go.addEventListener('click', generate);

// Comprobacion de compatibilidad: la libreria guarda los modelos en OPFS
if (!navigator.storage || !navigator.storage.getDirectory) {
  say('Este navegador no soporta almacenamiento OPFS. Usa Chrome/Edge, o Safari 16.4 o superior.', 'err');
  els.go.disabled = true;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin offline, pero funciona */ });
  });
}
