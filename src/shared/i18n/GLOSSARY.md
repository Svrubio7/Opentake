# OpenTake in Spanish: the glossary

Spanish from Spain, written by a product designer from Spain, never translated word for word. Same calm,
plain tone as the English. Rules:

- **Tú**, imperatives in tú: *Elige*, *Pulsa*, *Graba*. Never *usted*, never *vosotros* in labels.
- **Sentence case** (*Carpeta de grabaciones*, not *Carpeta De Grabaciones*).
- **No em dashes** (—) in either language: use a colon, a comma or a full stop. `i18n.test.ts` fails them.
- Spain spelling: *vídeo*, *guion* (no accent), *ordenador*, *móvil*, *clic*.
- Short. Spanish runs 20-30% longer: when a label does not fit, find a shorter word, do not shrink the type.
- Never translate: OpenTake, Quetzal, MP4, WebM, GIF, SRT, VTT, LUFS, RNNoise, Speex, Vosk, MediaPipe, YouTube,
  Reels, TikTok, Shorts, LinkedIn, X, file-name tokens like `{date}`.
- Numbers, sizes and dates go through `num`, `bytes`, `dateTime` in `core.ts` (Spanish: `1,4 GB`, `17 oct, 14:05`).

| English | Español | Notes |
|---|---|---|
| take / takes | toma / tomas | feminine: *la toma, recuperada, nueva* |
| recording (the file, the act) | grabación | *Carpeta de grabaciones* |
| record (verb, tab) | grabar / Grabar | |
| stop | detener (button: *Detener*) | *Al detener* = when you stop |
| pause / resume | pausa, pausar / reanudar | |
| export (verb / noun) | exportar / exportación | |
| captions | subtítulos | |
| camera | cámara | |
| mic (tab) / microphone | Micro / micrófono | *prueba de micro* = mic check |
| screen | pantalla | |
| window (app window) | ventana | |
| scene | escena | |
| teleprompter / prompter | teleprompter | the window: *ventana del teleprompter* |
| script | guion | |
| look (a saved setup, a camera look) | estilo | *Guardar estilo* |
| preset | preajuste | mic and export presets |
| setup (Record section) / first-run setup | Preparar / configuración inicial | |
| overlays (Record section) | Capas | logo, rótulo, teclas drawn over the video |
| frame (output size and shape) | formato | *Formato del vídeo* |
| file format (MP4, WebM, GIF) | tipo de archivo | |
| framing (auto framing) | encuadre (encuadre automático) | |
| background | fondo | |
| name card / lower third | rótulo | |
| intro and outro | intro y cierre | |
| logo / watermark | logo / marca de agua | |
| keystrokes | teclas pulsadas | |
| pointer / click | puntero / clic | |
| spotlight | foco | |
| auto zoom | zoom automático | |
| countdown | cuenta atrás | |
| cut / trim / split | corte / recortar / dividir | |
| undo / redo | deshacer / rehacer | |
| playhead / timeline / waveform | cabezal / línea de tiempo / forma de onda | |
| in / out point | punto de entrada / de salida | |
| loudness | sonoridad | |
| level / meter | nivel / medidor | |
| noise suppression / gate | supresión de ruido / puerta de ruido | |
| compressor / limiter / EQ / de-esser | compresor / limitador / ecualizador / de-esser | |
| hi-res | alta resolución | |
| folder / drive | carpeta / disco | *El disco está lleno* |
| free (space) | libres | *12 GB libres* |
| Settings / Shortcuts / About | Ajustes / Atajos / Acerca de | |
| update / restart | actualización / reiniciar | |
| show in folder | mostrar en la carpeta | |
| file name template | plantilla de nombre | |
| drawing on the screen | dibujar en la pantalla | pen *lápiz*, highlighter *rotulador*, arrow *flecha*, rectangle *rectángulo* |
| mirror / click-through | espejo / dejar pasar los clics | |
| voice tracking | seguimiento de voz | |
| Recovered (tag) | Recuperada | |
| suggestion / tip | sugerencia / consejo | |
| permission | permiso | |

Key names in the shortcuts sheet: Ctrl, Alt, Cmd and Esc stay; **Shift is Mayús, Enter is Intro, Space is
Espacio, Delete is Supr, Backspace is Retroceso** (the Spanish keyboard's own labels).
