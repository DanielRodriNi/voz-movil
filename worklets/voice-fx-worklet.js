// Procesadores de audio en tiempo real para el distorsionador de voz.
// Corren en el hilo de audio dedicado (AudioWorklet), no en el hilo principal.

/**
 * Cambia el tono sin cambiar la velocidad, mediante sintesis granular:
 * dos "granos" que leen el buffer circular a una velocidad distinta de 1
 * (ratio > 1 sube el tono, ratio < 1 lo baja), cada uno con una envolvente
 * senoidal 0 -> 1 -> 0 a lo largo de su vida, desfasados medio grano entre
 * si para que la suma de envolventes nunca caiga a silencio total.
 *
 * Es una tecnica sencilla (la misma familia que usan muchos pedales de
 * guitarra baratos): tiene un ligero "temblor" audible en la salida,
 * mas notable cuanto mayor es el desplazamiento. Para semitonos moderados
 * (hasta +-7, que es lo que expone la interfaz) se mantiene claro.
 */
class PitchShifterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.grain = 2400; // ~50ms a 48kHz
    this.bufSize = this.grain * 3;
    this.buf = new Float32Array(this.bufSize);
    this.writePos = 0;
    this.ratio = 1;
    this.voices = [
      { age: 0, readPos: 0 },
      { age: Math.floor(this.grain / 2), readPos: 0 },
    ];
    this.port.onmessage = (e) => {
      if (typeof e.data.ratio === 'number') this.ratio = e.data.ratio;
    };
  }

  readInterp(pos) {
    const N = this.bufSize;
    pos = ((pos % N) + N) % N;
    const i0 = Math.floor(pos);
    const i1 = (i0 + 1) % N;
    const frac = pos - i0;
    return this.buf[i0] * (1 - frac) + this.buf[i1] * frac;
  }

  process(inputs, outputs) {
    const inp = inputs[0][0];
    const out = outputs[0][0];
    if (!inp || !out) return true;

    if (this.ratio === 1) {
      // sin desplazamiento: pasa directo, pero sigue llenando el buffer
      // para que si se activa un desplazamiento no arranque con silencio
      for (let i = 0; i < inp.length; i++) {
        this.buf[this.writePos] = inp[i];
        this.writePos = (this.writePos + 1) % this.bufSize;
        out[i] = inp[i];
      }
      return true;
    }

    const g = this.grain;
    for (let i = 0; i < inp.length; i++) {
      this.buf[this.writePos] = inp[i];
      this.writePos = (this.writePos + 1) % this.bufSize;

      let sample = 0;
      for (const v of this.voices) {
        if (v.age === 0) {
          // nuevo grano: arranca un poco por detras de lo que se acaba de escribir
          v.readPos = this.writePos - g / 2;
        }
        const env = Math.sin((Math.PI * v.age) / g);
        sample += env * this.readInterp(v.readPos);
        v.readPos += this.ratio;
        v.age = (v.age + 1) % g;
      }
      out[i] = sample * 0.7; // margen: dos envolventes solapadas pueden superar 1
    }
    return true;
  }
}

/**
 * Pasa el audio sin tocarlo, pero cuando esta "grabando" envia copias de
 * cada bloque al hilo principal para poder montarlas en un WAV al terminar.
 * Se coloca siempre al final de la cadena, tras el efecto que este activo,
 * asi que graba lo mismo que se esta escuchando.
 */
class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'start') this.recording = true;
      if (e.data.cmd === 'stop') this.recording = false;
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0][0];
    const out = outputs[0][0];
    if (inp && out) out.set(inp);
    if (this.recording && inp) this.port.postMessage(inp.slice());
    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
registerProcessor('tap', TapProcessor);
