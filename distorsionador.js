// Distorsionador de voz en tiempo real: solo Web Audio API + un AudioWorklet
// propio para el cambio de tono. Sin modelos, sin descargas, sin servidor.

import { encodeWav } from './wav.js';

const $ = (id) => document.getElementById(id);
const els = {
  mic: $('mic'), effects: $('effects'), monitor: $('monitor'), rec: $('rec'),
  status: $('status'), result: $('result'), player: $('player'), dl: $('dl'),
};

let audioCtx = null;
let micStream = null;
let micSource = null;
let tapNode = null;
let currentChain = null; // { input, output, extra } del efecto activo, o null si es "normal"
let recording = false;
let recChunks = [];
let lastUrl = null;

function say(msg, kind = '') {
  els.status.textContent = msg;
  els.status.className = kind;
}

function setEnabled(on) {
  els.effects.querySelectorAll('button').forEach((b) => { b.disabled = !on; });
  els.monitor.disabled = !on;
  els.rec.disabled = !on;
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

function teardownChain() {
  micSource.disconnect();
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
  } else {
    micSource.connect(built.input);
    built.output.connect(tapNode);
    currentChain = built;
  }
  els.effects.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.fx === effect));
}

async function startMic() {
  els.mic.disabled = true;
  say('Pidiendo permiso de micrófono…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  say('Este navegador no da acceso al micrófono desde una página web.', 'err');
  els.mic.disabled = true;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin offline, pero funciona */ });
  });
}
