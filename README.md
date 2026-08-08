# Voz — texto a voz y distorsionador en el móvil, sin servidor

App web estática con dos páginas independientes, ambas 100% en el navegador:

- **`index.html`** — texto a voz con [Piper](https://github.com/rhasspy/piper)
  (ONNX Runtime Web + espeak-ng compilados a WebAssembly).
- **`distorsionador.html`** — efectos de voz en tiempo real desde el micrófono
  (Web Audio API pura, sin modelos ni descargas).

No hay backend, no hay API, no hay coste. El audio nunca sale del dispositivo.
Se puede publicar en GitHub Pages, Netlify o cualquier hosting estático.

## Cómo funciona

La primera vez que usas una voz se descarga su modelo (28–77 MB) y queda guardado
en el navegador (OPFS). A partir de ahí la app funciona **sin conexión**, incluso
en modo avión.

## Voces incluidas

| Voz | Idioma | Tamaño |
|---|---|---|
| `es_ES-davefx-medium` | Castellano, masculina | 63 MB |
| `es_ES-sharvard-medium` | Castellano, femenina | 77 MB |
| `es_ES-carlfm-x_low` | Castellano, masculina, la más rápida | 28 MB |
| `es_MX-claude-high` | Español de México, alta calidad | 63 MB |
| `es_MX-ald-medium` | Español de México | 63 MB |
| `en_US-hfc_female-medium` | Inglés EE. UU., femenina | 63 MB |
| `en_GB-alba-medium` | Inglés Reino Unido, femenina | 63 MB |

Las voces `es_ES-mls_9972-low` y `es_ES-mls_10246-low` existen en el catálogo de Piper
pero **se han excluido a propósito**: tardan 6,5 s en decir una frase que las demás
resuelven en 2,5 s, y suenan mucho más flojas.

Para añadir otra voz del [catálogo](https://huggingface.co/diffusionstudio/piper-voices),
basta con añadir un `<option>` en `index.html` con el identificador exacto
(`idioma_REGIÓN-nombre-calidad`).

## Probar en local

Hace falta servirlo por HTTP: abriendo el `index.html` como fichero suelto no funciona,
porque OPFS y los service workers exigen un contexto seguro.

```bash
python -m http.server 8765
# http://127.0.0.1:8765
```

## Publicar en GitHub Pages

```bash
git init
git add .
git commit -m "Voz: texto a voz en el navegador"
gh repo create voz-movil --public --source=. --push
```

Después, en GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `root`**.

Queda publicada en `https://<tu-usuario>.github.io/voz-movil/`. Ábrela en el móvil y usa
*Añadir a pantalla de inicio* para instalarla como una app más.

Todas las rutas son relativas, así que funciona igual en un subdirectorio de GitHub Pages
que en la raíz de un dominio propio.

## Detalles de implementación

- **Velocidad**: se aplica con `playbackRate` sobre el reproductor, con `preservesPitch`,
  así que no cambia el tono ni obliga a regenerar. El WAV descargado va a velocidad normal.
- **Textos largos**: se parten por frases (y por comas si una frase pasa de 300 caracteres),
  se generan uno a uno con progreso y se unen en un solo WAV con 0,14 s de pausa entre frases.
- **Normalización**: el volumen se iguala a un pico de 0,89. Sin esto, unas voces suenan
  mucho más flojas que otras (medido: pico 0,94 en davefx frente a 0,36 en sharvard).
- **Cambio de voz**: `TtsSession` de la librería es un *singleton* que no recarga el modelo
  al cambiar `voiceId`; hay que descartar la instancia (`TtsSession._instance = null`) o
  seguiría sonando la voz anterior.
- **Hablante dentro de una misma voz** (p. ej. `es_ES-sharvard-medium`, que tiene M=0 y F=1
  en su `speaker_id_map`): la librería oficial de jsDelivr ignora el hablante y siempre
  usa el 0. Por eso `vendor/piper-tts-web.js` es una copia local parcheada que acepta
  `speakerId` en `TtsSession.create()`; el `<select>` codifica el hablante como
  `voiceId:speakerId` (p. ej. `es_ES-sharvard-medium:1`) y `app.js` lo separa antes de
  usarlo. Si se actualiza la librería del CDN, este parche hay que rehacerlo a mano.

## Compatibilidad

Necesita OPFS: Chrome/Edge/Firefox actuales y **Safari 16.4 o superior**. Si no está
disponible, la app lo detecta y lo dice en vez de fallar en silencio.

En iPhone la generación es más lenta que en Android (Safari no permite hilos en WASM) y
el sistema puede purgar la caché si queda poco espacio; entonces la voz se vuelve a descargar.

## Distorsionador (`distorsionador.html`)

Efectos de voz en directo desde el micrófono: voz grave, voz aguda, robot, eco y teléfono.
Nada de esto usa modelos ni IA — es Web Audio API nativa, salvo el cambio de tono.

- **Voz grave / aguda**: `worklets/voice-fx-worklet.js` implementa un cambiador de tono
  granular casero (dos "granos" leyendo un buffer circular a velocidad distinta de 1,
  desfasados medio grano y con envolvente senoidal para que la mezcla no caiga a
  silencio). Es la misma familia de técnica que usan los pedales de guitarra baratos:
  tiene un temblor audible que se nota más cuanto mayor es el semitono. Se limita a
  ±7 semitonos porque a partir de ahí el margen del buffer circular deja de ser seguro
  con este diseño (ver comentarios en el fichero).
- **Robot**: modulación en anillo — un oscilador de ~45 Hz conectado directamente al
  `AudioParam` de ganancia multiplica la señal por la onda.
- **Eco**: `DelayNode` con realimentación (0,32 s, ganancia 0,35) mezclado con la señal seca.
- **Teléfono**: filtro paso banda (~1600 Hz, Q 0,7) + un `WaveShaperNode` con `tanh` como
  saturación suave.
- **Grabación**: no usa `MediaRecorder` (el soporte de formatos en iOS es poco fiable);
  un `AudioWorkletProcessor` ("tap") reenvía los bloques Float32 ya procesados al hilo
  principal, que los concatena y codifica a WAV con la misma función `encodeWav` de
  `wav.js` que usa el texto a voz.
- **Auriculares**: si activas "Escuchar en directo" sin auriculares, el micrófono capta
  lo que sale del altavoz y se realimenta (pitido). La grabación no depende de esto —
  funciona igual con la escucha en directo apagada.

### Voz de perrito (alta calidad, no en directo)

Los efectos de arriba tienen un límite de calidad inherente: al procesar en tiempo real,
cualquier cambio de tono que preserve la duración necesita algún tipo de solapado de
"granos" de audio, y eso siempre deja un temblor audible por poco que se optimice.

Esta función es distinta a propósito: **graba primero, transforma después**, con dos pasos
en cadena para poder mover el tono sin arrastrar la velocidad (el "efecto ardilla" de
`playbackRate` a secas sube tono y velocidad a la vez, que es justo lo que no se quería):

1. `timeStretch()` alarga o acorta el audio en el tiempo **sin tocar el tono**, con la
   técnica clásica de solapa-y-suma (OLA): ventanas de Hann de ~40 ms leídas cada `Ha`
   muestras y reescritas cada `Hs` muestras (más separadas si se alarga, más juntas si
   se acorta), normalizando por la suma real de ventanas en cada punto en vez de asumir
   solape perfecto — esa asunción solo vale cuando `Hs == Ha`, y aquí varía a propósito.
2. El resultado, ya con la duración cambiada (`original × ratio`), se reproduce en un
   `OfflineAudioContext` a velocidad `ratio` — eso comprime la duración de vuelta a la
   original, y como el remuestreo es lo que desplaza el tono, el resultado final es
   tono desplazado con la duración intacta.

Después encadena, en ese orden: paso bajo (quita aspereza en los agudos), un realce suave
de presencia, compresor de dinámica, y una reverb corta generada con ruido con caída
exponencial (sin fichero de audio, todo calculado).

Usa un segundo `AudioWorkletNode` con la misma clase `tap` del fichero de efectos en directo,
conectado en paralelo directamente al micrófono (nunca al efecto en directo que esté activo),
así que graba siempre audio limpio sin importar qué esté seleccionado arriba.

Los 4 parámetros son ajustables desde la propia interfaz (deslizadores), no hace falta tocar
código: **tono** (semitonos, −6 a +12, grave a agudo, duración intacta), **suavidad**
(frecuencia del paso bajo, 4000–14000 Hz), **brillo** (ganancia del realce de presencia,
0–6 dB) y **calidez** (mezcla de la reverb, 0–40%). Se guardan en `localStorage` y, si ya
hay una grabación hecha, mover cualquier deslizador la vuelve a generar sola (sin regrabar)
— para poder afinar de oído.
