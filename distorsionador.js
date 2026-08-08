// Distorsionador de voz en tiempo real: solo Web Audio API + un AudioWorklet
// propio para el cambio de tono. Sin modelos, sin descargas, sin servidor.

import { encodeWav } from './wav.js';

const $ = (id) => document.getElementById(id);
const els = {
  mic: $('mic'), effects: $('effects'), monitor: $('monitor'), rec: $('rec'),
  status: $('status'), result: $('result'), player: $('player'), dl: $('dl'),
  dogRec: $('dogRec'), dogStatus: $('dogStatus'), dogResult: $('dogResult'),
  dogPlayer: $('dogPlayer'), dogDl: $('dogDl'), dogApply: $('dogApply'),
  subtabLive: $('subtabLive'), subtabDog: $('subtabDog'),
  tabLive: $('tab-live'), tabDog: $('tab-dog'),
  dogPitch: $('dogPitch'), dogPitchVal: $('dogPitchVal'),
  dogSoft: $('dogSoft'), dogSoftVal: $('dogSoftVal'),
  dogBright: $('dogBright'), dogBrightVal: $('dogBrightVal'),
  dogWarmth: $('dogWarmth'), dogWarmthVal: $('dogWarmthVal'),
};

let audioCtx = null;
let micStream = null;
let micSource = null;
let tapNode = null;
let dryTapNode = null; // tap sin efecto, siempre disponible: lo usa "voz de perrito"
let currentChain = null; // { input, output, extra } del efecto activo, o null si es "normal"
let recording = false;
let recChunks = [];
let lastUrl = null;
let dogRecording = false;
let dogChunks = [];
let dogLastUrl = null;
let dogRaw = null; // { samples, sampleRate } de la ultima grabacion, para poder regenerar sin volver a grabar

// --- Pestañas: En directo / Voz de perrito ---
els.subtabLive.addEventListener('click', () => showTab('live'));
els.subtabDog.addEventListener('click', () => showTab('dog'));

function showTab(tab) {
  els.subtabLive.classList.toggle('on', tab === 'live');
  els.subtabDog.classList.toggle('on', tab === 'dog');
  els.tabLive.style.display = tab === 'live' ? '' : 'none';
  els.tabDog.style.display = tab === 'dog' ? '' : 'none';
}

// --- Sliders de "voz de perrito": persisten en localStorage y regeneran solos al soltar ---
const dogSliders = [
  { el: els.dogPitch, val: els.dogPitchVal, key: 'pitch', fmt: (v) => (v > 0 ? '+' : '') + v + ' st' },
  { el: els.dogSoft, val: els.dogSoftVal, key: 'soft', fmt: (v) => Math.round(v) + ' Hz' },
  { el: els.dogBright, val: els.dogBrightVal, key: 'bright', fmt: (v) => v.toFixed(1) + ' dB' },
  { el: els.dogWarmth, val: els.dogWarmthVal, key: 'warmth', fmt: (v) => Math.round(v) + '%' },
];

// Prefijo "v2": al cambiar los valores por defecto de fabrica, esto deja huerfanos
// los que ya hubiera guardados en el movil (bajo el prefijo viejo) en vez de que
// sigan pisando los nuevos por defecto para siempre.
const DOG_STORAGE_PREFIX = 'distorsionador.dog.v2.';

for (const s of dogSliders) {
  try {
    const saved = localStorage.getItem(DOG_STORAGE_PREFIX + s.key);
    if (saved !== null) s.el.value = saved;
  } catch { /* modo privado: seguimos con los valores por defecto */ }
  s.val.textContent = s.fmt(Number(s.el.value));

  s.el.addEventListener('input', () => { s.val.textContent = s.fmt(Number(s.el.value)); });
  s.el.addEventListener('change', () => {
    try { localStorage.setItem(DOG_STORAGE_PREFIX + s.key, s.el.value); } catch { /* ignorar */ }
    if (dogRaw) regenerateDogVoice();
  });
}

function dogParams() {
  return {
    semitones: Number(els.dogPitch.value),
    soft: Number(els.dogSoft.value),
    bright: Number(els.dogBright.value),
    warmth: Number(els.dogWarmth.value) / 100,
  };
}

function say(msg, kind = '') {
  els.status.textContent = msg;
  els.status.className = kind;
}

function setEnabled(on) {
  els.effects.querySelectorAll('button').forEach((b) => { b.disabled = !on; });
  els.monitor.disabled = !on;
  els.rec.disabled = !on;
  els.dogRec.disabled = !on;
}

/**
 * Construye el efecto pedido. Devuelve null para "normal" (el micro se
 * conecta directo al tap) o { input, output, extra } donde `extra` son
 * nodos auxiliares (osciladores, etc.) que hay que parar al desmontar.
 */
function buildEffect(effect, ctx) {
  switch (effect) {
    case 'grave':
    case 'aguda': {
      const semitones = effect === 'grave' ? -6 : 7;
      const node = new AudioWorkletNode(ctx, 'pitch-shifter', { channelCount: 1 });
      node.port.postMessage({ ratio: 2 ** (semitones / 12) });
      return { input: node, output: node, extra: [] };
    }

    case 'robot': {
      // Modulacion en anillo: el oscilador conectado al AudioParam "gain"
      // sustituye su valor por la propia onda, multiplicando la señal por ella.
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = 45;
      const ring = ctx.createGain();
      ring.gain.value = 0;
      carrier.connect(ring.gain);
      carrier.start();
      return { input: ring, output: ring, extra: [carrier] };
    }

    case 'eco': {
      const input = ctx.createGain();
      const delay = ctx.createDelay(1.0);
      const feedback = ctx.createGain();
      const wet = ctx.createGain();
      const mix = ctx.createGain();
      delay.delayTime.value = 0.32;
      feedback.gain.value = 0.35;
      wet.gain.value = 0.5;
      input.connect(mix);
      input.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(mix);
      return { input, output: mix, extra: [delay, feedback, wet] };
    }

    case 'telefono': {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1600;
      band.Q.value = 0.7;
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * 2 - 1;
        curve[i] = Math.tanh(x * 3) / Math.tanh(3);
      }
      shaper.curve = curve;
      const boost = ctx.createGain();
      boost.gain.value = 1.6;
      band.connect(shaper);
      shaper.connect(boost);
      return { input: band, output: boost, extra: [] };
    }

    default: // "normal"
      return null;
  }
}

let liveInput = null; // lo que micSource alimenta para la cadena en directo (tapNode o el efecto activo)

function teardownChain() {
  // Desconexion selectiva: micSource tambien alimenta dryTapNode en paralelo,
  // y eso debe seguir vivo pase lo que pase con el efecto en directo.
  if (liveInput) micSource.disconnect(liveInput);
  liveInput = null;
  if (!currentChain) return;
  currentChain.output.disconnect();
  if (currentChain.input !== currentChain.output) currentChain.input.disconnect();
  for (const n of currentChain.extra) {
    try { n.disconnect(); } catch { /* ya desconectado */ }
    try { n.stop && n.stop(); } catch { /* no es una fuente */ }
  }
  currentChain = null;
}

function setEffect(effect) {
  teardownChain();
  const built = buildEffect(effect, audioCtx);
  if (!built) {
    micSource.connect(tapNode);
    liveInput = tapNode;
  } else {
    micSource.connect(built.input);
    built.output.connect(tapNode);
    currentChain = built;
    liveInput = built.input;
  }
  els.effects.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.fx === effect));
}

async function startMic() {
  els.mic.disabled = true;
  say('Pidiendo permiso de micrófono…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    say('No se pudo acceder al micrófono: ' + (err && err.message ? err.message : err), 'err');
    els.mic.disabled = false;
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  await audioCtx.audioWorklet.addModule('worklets/voice-fx-worklet.js');
  await audioCtx.resume();

  micSource = audioCtx.createMediaStreamSource(micStream);
  tapNode = new AudioWorkletNode(audioCtx, 'tap', { channelCount: 1 });
  tapNode.port.onmessage = (e) => { if (recording) recChunks.push(e.data); };

  // Tap seco (sin efecto en directo aplicado), siempre conectado en paralelo:
  // lo usa "voz de perrito", que necesita audio limpio para transformarlo despues.
  dryTapNode = new AudioWorkletNode(audioCtx, 'tap', { channelCount: 1 });
  dryTapNode.port.onmessage = (e) => { if (dogRecording) dogChunks.push(e.data); };
  micSource.connect(dryTapNode);

  setEffect('normal');
  setEnabled(true);
  els.mic.textContent = 'Micrófono activo';
  say('Listo. Elige un efecto y prueba a hablar.', 'ok');
}

els.mic.addEventListener('click', startMic);

els.effects.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-fx]');
  if (!btn || btn.disabled) return;
  setEffect(btn.dataset.fx);
});

els.monitor.addEventListener('change', () => {
  if (els.monitor.checked) {
    tapNode.connect(audioCtx.destination);
  } else {
    try { tapNode.disconnect(audioCtx.destination); } catch { /* no estaba conectado */ }
  }
});

els.rec.addEventListener('click', () => {
  if (!recording) {
    recChunks = [];
    tapNode.port.postMessage({ cmd: 'start' });
    recording = true;
    els.rec.innerHTML = '<span class="rec-dot"></span>Detener y guardar';
    els.result.removeAttribute('data-on');
    say('Grabando…');
  } else {
    tapNode.port.postMessage({ cmd: 'stop' });
    recording = false;
    els.rec.textContent = '● Grabar';
    finishRecording();
  }
});

function finishRecording() {
  const total = recChunks.reduce((n, c) => n + c.length, 0);
  if (!total) { say('No se grabó nada.', 'err'); return; }

  const merged = new Float32Array(total);
  let off = 0;
  for (const c of recChunks) { merged.set(c, off); off += c.length; }
  recChunks = [];

  const wav = encodeWav(merged, audioCtx.sampleRate);
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(wav);
  els.player.src = lastUrl;
  els.dl.href = lastUrl;
  els.dl.download = `distorsion-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.wav`;
  els.result.setAttribute('data-on', '');
  say(`Listo · ${(wav.size / 1e6).toFixed(1)} MB`, 'ok');
}

els.dogRec.addEventListener('click', async () => {
  if (!dogRecording) {
    dogChunks = [];
    dryTapNode.port.postMessage({ cmd: 'start' });
    dogRecording = true;
    els.dogRec.innerHTML = '<span class="rec-dot"></span>Detener y transformar';
    els.dogResult.removeAttribute('data-on');
    dogSay('Grabando tu voz…');
  } else {
    dryTapNode.port.postMessage({ cmd: 'stop' });
    dogRecording = false;
    els.dogRec.textContent = '● Grabar mi voz';

    const total = dogChunks.reduce((n, c) => n + c.length, 0);
    if (!total) { dogSay('No se grabó nada.', 'err'); return; }
    const merged = new Float32Array(total);
    let pos = 0;
    for (const c of dogChunks) { merged.set(c, pos); pos += c.length; }
    dogChunks = [];

    dogRaw = { samples: merged, sampleRate: audioCtx.sampleRate };
    els.dogApply.disabled = false;
    await regenerateDogVoice();
  }
});

els.dogApply.addEventListener('click', () => { if (dogRaw) regenerateDogVoice(); });

function dogSay(msg, kind = '') {
  els.dogStatus.textContent = msg;
  els.dogStatus.className = kind;
}

/**
 * Sube o baja el tono remuestreando el audio (el mismo truco de toda la vida del
 * "efecto ardilla" de los dibujos): sube o baja la velocidad junto con el tono y
 * los formantes, con el remuestreo nativo del navegador, sin ningun algoritmo
 * casero de por medio.
 *
 * Se probo a desacoplar el tono de la velocidad con un estirado previo por
 * solapa-y-suma (OLA), pero sin alinear las ventanas a la periodicidad del tono
 * (lo que se conoce como WSOLA) suena robotico/roto en voz -- es una limitacion
 * conocida de OLA a secas, no un bug puntual, y arreglarla bien requiere mas
 * de lo que se puede afinar sin poder escuchar el resultado. Se descarto.
 */
async function makePerritoVoice(samples, sampleRate, params) {
  const { semitones, soft, bright, warmth } = params;
  const ratio = 2 ** (semitones / 12);

  const dryBuffer = audioCtx.createBuffer(1, samples.length, sampleRate);
  dryBuffer.copyToChannel(samples, 0);

  const outLength = Math.ceil(samples.length / ratio) + sampleRate; // margen para la cola de la reverb
  const off = new OfflineAudioContext(1, outLength, sampleRate);

  const src = off.createBufferSource();
  src.buffer = dryBuffer;
  src.playbackRate.value = ratio;

  // Quita aspereza en agudos (las "eses" se vuelven muy afiladas al subir el tono)
  const lowpass = off.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = soft;
  lowpass.Q.value = 0.7;

  // Un poco de brillo/caracter, sin pasarse
  const presence = off.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 2800;
  presence.gain.value = bright;
  presence.Q.value = 1;

  // Suaviza picos de volumen para que quede parejo
  const comp = off.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 20;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.2;

  // Reverb corta y calida (impulso generado a mano, sin descargar nada)
  const convolver = off.createConvolver();
  convolver.buffer = softReverbIR(off, sampleRate);
  const dry = off.createGain(); dry.gain.value = 1 - warmth;
  const wet = off.createGain(); wet.gain.value = warmth;

  src.connect(lowpass);
  lowpass.connect(presence);
  presence.connect(comp);
  comp.connect(dry);
  comp.connect(convolver);
  convolver.connect(wet);
  dry.connect(off.destination);
  wet.connect(off.destination);

  src.start();
  const rendered = await off.startRendering();
  const out = rendered.getChannelData(0).slice();

  let peak = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  if (peak > 1e-4) { const g = 0.89 / peak; for (let i = 0; i < out.length; i++) out[i] *= g; }

  return out;
}

function softReverbIR(ctx, sampleRate) {
  const len = Math.floor(sampleRate * 0.5);
  const ir = ctx.createBuffer(1, len, sampleRate);
  const data = ir.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / len;
    data[i] = (Math.random() * 2 - 1) * (1 - t) ** 2.5;
  }
  return ir;
}

async function regenerateDogVoice() {
  dogSay('Transformando…');
  els.dogApply.disabled = true;
  try {
    const { samples, sampleRate } = dogRaw;
    const transformed = await makePerritoVoice(samples, sampleRate, dogParams());
    const wav = encodeWav(transformed, sampleRate);

    if (dogLastUrl) URL.revokeObjectURL(dogLastUrl);
    dogLastUrl = URL.createObjectURL(wav);
    els.dogPlayer.src = dogLastUrl;
    els.dogDl.href = dogLastUrl;
    els.dogDl.download = `perrito-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.wav`;
    els.dogResult.setAttribute('data-on', '');
    dogSay(`Listo · ${(wav.size / 1e6).toFixed(1)} MB`, 'ok');
  } finally {
    els.dogApply.disabled = false;
  }
}

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  say('Este navegador no da acceso al micrófono desde una página web.', 'err');
  els.mic.disabled = true;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin offline, pero funciona */ });
  });
}
