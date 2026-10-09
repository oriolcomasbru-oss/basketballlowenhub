# LÖWEN COACHES HUB — Informe de traspaso (handoff)

> **Cómo usar este documento:** súbelo a la nueva conversación de Claude junto con el
> archivo **`index.html`** más reciente (o el zip `coaches-hub-netlify41.zip`). Con esto la
> nueva instancia tiene todo el contexto para continuar. La versión actual es **v41**.

---

## 1. Qué es el proyecto

App web interna para el cuerpo técnico de **Basketball Löwen Braunschweig** (BBL, Alemania).
La usa **Oriol** (assistant coach / operaciones). Idioma de la interfaz: **inglés**; la
conversación de trabajo es en **español/catalán**.

Es una **única página HTML** (`index.html`, ~10.000 líneas, ~1 MB) que contiene TODO:
HTML + CSS (en 3 bloques `<style>`) + JavaScript vanilla. Se despliega en **Netlify**.
Backend en **Supabase** (auth + guardado de informes). Sincroniza datos desde **Google Sheets**.

---

## 2. Archivos y despliegue

El entregable son 3 archivos, empaquetados en `coaches-hub-netlifyN.zip`:

- **`index.html`** — la app entera (lo único que se edita normalmente).
- **`netlify.toml`** — config de Netlify (functions dir, headers).
- **`netlify/functions/sheets.js`** — proxy serverless que sirve los CSV de Google Sheets
  con CORS (acepta `?url=` validando host docs.google.com/googleusercontent.com, o `?id=&sheet=`).

**Flujo de despliegue:** el usuario arrastra el zip a Netlify → deploy → abre la web y hace
**Ctrl+Shift+R** (hard refresh) para saltar caché. URL: `https://coacheshub-basketballlowen.netlify.app`.

**No se puede probar en vivo desde el entorno de build** (no hay acceso a Netlify/Supabase/Sheets
reales). Se valida con `node --check` y balance de llaves CSS; el usuario prueba tras desplegar.

---

## 3. Arquitectura y convenciones técnicas

- **Vanilla JS**, sin framework. Helper de DOM: `h(tag, props, ...kids)` (props: `class`,
  `html` = innerHTML, `onX` = listener, `dataset`, resto = atributos; hijos `null`/`false` se ignoran).
- **Persistencia/undo:** `commit(fn)` ejecuta la mutación, hace snapshot para undo/redo y persiste.
  `persist()` guarda sin snapshot (para ediciones inline de inputs). `renderPlan()` re-renderiza
  la sección Planning. `uid()` genera ids. `$(sel)` = querySelector.
- **Dos "apps" en el mismo archivo:**
  1. **App principal** (script grande, ~línea 1720–4600+). Vistas por pestañas.
  2. **Scouting hub embebido** (`.phx`, script `window.__phxEmbed=true`, ~7300+). Sus estilos van
     en `<style id="phxScoped">` y `<style id="phxEmbed">`, TODO prefijado con `.phx`.
- **Almacenamiento:** IndexedDB (objeto `Store`) para fotos/estado; Supabase para informes;
  localStorage para sesión/flags. Google Sheets solo lectura vía el proxy `sheets.js`.
- **pdf.js** (cargado desde cdnjs) para importar PDF de entrenos.

### ⚠️ Gotchas importantes (leer antes de tocar)
1. **`defaultState()`** es un objeto JSON en **UNA sola línea gigantesca** (~línea 1900).
   **NO hacer `grep`/`view` que lo imprima** — consume muchísimo contexto. Usar `grep` con
   patrones específicos y `awk -F: '$1<7307'` para acotar.
2. **Hay 3 bloques `<style>`** (main ~línea 7, phxScoped ~6023, phxEmbed ~6747). Para que un
   override de una clase `.phx` gane, hay que ponerlo en el **ÚLTIMO** bloque (`rfind("</style>")`),
   porque los bloques posteriores pisan a los anteriores.
3. El bloque `<style>` principal tiene un **descuadre benigno de 1 llave** (una `{` o `}` dentro
   de una cadena CSS). No es un error; viene de siempre. Verificar el balance por bloque e ignorar
   ese 1-off del bloque main.
4. **Validación estándar** antes de empaquetar:
   - Extraer el script principal (entre el `<script>` anterior a `function defaultState()` y su
     `</script>`) y el script phx (el que contiene `window.__phxEmbed=true`) y correr `node --check`.
   - Comprobar balance `{` vs `}` por cada bloque `<style>`.

---

## 4. Modelo de datos (state)

- `state.plan.sessions[ISO]` = **array** de sesiones del día:
  `{ id, label, start:"HH:MM", goal, summary, notes(HTML), blocks:[ {id,title,min,coach,items:[{t,c}]} ], pdf? }`
  (los `items` = subbloques; `t` puede ser texto o HTML según el campo).
- `state.plan.month[ISO]` = `[{type:"training|event|context", text, id}]` (calendario mensual).
- `state.plan.kload[ISO]` = `{avg, per:{playerKey:carga}}` (carga Kinexon por día).
- `state.plan.avail[ISO]` = `{playerKey: "out"|"notfull"|"nocontact"|"ind"| ...}` (disponibilidad).
- `state.plan.squad` = `[{key, name, pos?}]` (plantilla).
- `state.plan.plays` = `[[call, description]]` (playbook lateral de la hoja de sesión, editable).
- `state.playbookOff` / `state.playbookDef` = `[{id, title, color, entries:[{id,label,detail,img?}]}]`
  (Playbook Offense/Defense; `img` = dataURL, solo en Offense).
- `state.games` = partidos `{id,date,opponent,competition,home/venue,...}` (competitions: BBL, CUP,
  Friendly, ProB…).
- `state.perms` = permisos por usuario (`SECT_KEYS`/`SECT_LABELS`, `canEdit`/`canView`).
- `state.ui.*` = estado de UI (view, planTab, sessionDate, sessionIdx, pbTab, pbEdit, semOpen, os, ts…).
- **`PRACTICE_SESSIONS`** = const con las 31 prácticas importadas (Ago 5 – Sep 15).
  `mergePractices(s)` las vuelca en `sessions` (gap-fill, no pisa lo editado). Flag `_practicesV2`
  (`ensurePractices`) para importar una sola vez. Para reimportar tras cambiar el set: subir el flag a v3.

---

## 5. Vistas y funciones clave (mapa mental)

**Pestañas superiores (data-view):** rooster, market, negotiating, secondteam, discarded,
calendar, **Post game/practice** (teamscout), **Pre game** (oppscout), **Playbook** (playbook),
playerdev, playerdb. Routing en `applyView(v)` + `setView(v)`; contenedores `#viewX`.

- **Planning** (`renderPlan`) con subtabs Season / Month / **Game-to-game** / **Session**:
  - `cycleView()` — game-to-game. **Carrusel** horizontal de tarjetas de **300px fijos**
    (`.cycle-row` con `repeat(n,300px)` inline dentro de `.cycle-scroll` overflow-x). Cada día:
    cabecera + barra de carga integrada, caja de sesión (bloques/subbloques editables), botón
    **📄 Import PDF**, disponibilidad compacta (`availDayMini`: contadores IN/OUT/LIM + solo los que
    NO están), botón "Open session", link "PRE-GAME" en días de partido.
    Depende de `cycleFor()` (ventana partido→partido, solo BBL/CUP/Friendly), `mdLabel()`,
    `isCycleGame()`, `loadRGB()` (escala de carga 6 bandas verde→rojo).
  - `sessionSheetView()` — **editor WYSIWYG tipo hoja impresa** (reusa las clases `.ps-*` de
    `printSession`). Layout: **columna izquierda** = días de la semana (mini) ; **centro** = la hoja
    (tabla PRACTICE SCHEDULE | Notes, panel derecho con logo/club/fecha + pistas `COURTS_IMG` +
    playbook `PLAYS` editable con ＋play/−last) ; **columna derecha** = disponibilidad por posiciones
    (`availSemaforo`). El menú de fecha (‹ fecha › Today + session) está **arriba, junto a Print A4**
    (en `renderPlan`). Texto rico en detalles/notas con `showRepToolbar` (barra estilo Pre-Game).
    También botón **📄 Import PDF** (`sessionPdfSlot`).
  - `monthlyView()` — mes como **mapa de calor** (tinte por carga), chips de partido, dots de foco.
  - `printSession()` — genera el **A4** (mismo `.ps-*`; disponibilidad = `availSemaforo`; fecha en
    inglés; logo arriba-derecha; oculta badge Netlify en print).
- **Disponibilidad unificada:** `availSemaforo(iso)` (rejilla por posición: PG/Guards/Forwards/
  Power F./Centers + dobles licencia separados con ·DL; semáforo verde/rojo/ámbar) y `availDayMini(iso)`
  (versión compacta para game-to-game). Grupos y claves en **`SEM_GROUPS`** (ver §7).
- **Pre game** (`renderOppScout` → `renderScout` → `renderReportSections`): informe de rival.
  `renderDualCard` = tabla **Our Offense / Our Defense** con columnas **AREA | THEY | WE** (compacta,
  solo texto, sin tablas dentro). Formato rico con `showRepToolbar`. Fichas PLAYERS (embed `.phx`)
  con stats.
- **Post game/practice** (`renderTeamScout` → `trainingCard(iso,idx)` para prácticas): Team stats +
  Notes + **panel "Training sheet"** (horario read-only de la sesión de ese día + botón "Open/edit →").
- **Playbook** (`renderPlaybook`): toggle **Offense | Defense** (una pestaña, dos sets:
  `state.playbookOff`/`state.playbookDef`). **Modo edición** con botón **✎ Edit / ✓ Done**
  (`state.ui.pbEdit`): en lectura no se edita; en edición hay inputs, drag&drop de secciones y calls,
  colores, añadir/borrar. **Imágenes solo en Offense** por call: drop de archivo, pegar Ctrl+V, o clic;
  miniatura → **popup** (`openImgPopup`). Datos base seed en `defaultPlaybook(kind)`.
- **PDF import** (`sessionPdfSlot` + `parsePracticePDF`): lee el PDF con **pdf.js**, reconstruye
  líneas por coordenada Y, separa columna horario (x<55%) de notas (x≥55%), parsea cabeceras
  `HH:MM (AM/PM) - TITULO  N´  COACH` + subitems, calcula duraciones por diferencia de horas, y
  **vuelca en `se.blocks`** (NO guarda el PDF). Funciona con hojas tipo "PRACTICE SCHEDULE".

**Sync Google Sheets** (`syncFromGoogle` corre [syncGames, syncCalendar, syncMedical, syncKinexon]):
- `PUBCSV.calendar` (gid 354227494) = calendario/entrenamientos → **rejilla semanal** (día=columna,
  fechas DD/MM/YYYY). `calCellType` clasifica cada celda (training/event/context; game se ignora).
  Gap-fill: no pisa lo curado.
- `PUBCSV.kinexon` (gid 872319668) = carga equipo → fechas **DD/MM/YYYY** (`isoFromDMY`), carga =
  columna 6 "Mechanical Load", suma AM+PM, excluye TEAM, mapea nombres con `fkey`+`NAME_ALIAS`.

---

## 6. Historial de cambios relevante (para no repetir)

- Sheets calendar (rejilla) + kinexon (bug MDY→DMY) arreglados.
- PLAYERS del scouting hub ensanchado; Our Offense/Defense → tabla AREA|THEY|WE compacta; OFF/DEF
  del game plan en negro/dorado del club.
- Import de **31 prácticas** (`PRACTICE_SESSIONS`, flag `_practicesV2`).
- **Session** rediseñada a hoja WYSIWYG (`sessionSheetView`), texto rico, semana izquierda,
  disponibilidad derecha, fecha arriba junto a Print A4, logo arriba-derecha.
- **Game-to-game** a carrusel de 300px, disponibilidad `availDayMini`.
- **Playbook** nuevo (Offense/Defense, edit toggle, imágenes por call, drag&drop).
- **PDF Import** que lee y vuelca (no guarda) con pdf.js.
- Post game/practice muestra la **hoja de entrenamiento**.
- Stats de scout: valor 10px una línea (fichas 252px), meta en una línea, dropdown playbook en negro.

---

## 7. Claves de jugador para disponibilidad (`SEM_GROUPS`)

```
PG:            dejour, gian, devin        (DL: lenni)
Guards:        ferdi, sheldon             (DL: esli)
Forwards:      chip, benny                (DL: noah)
Power F.:      tajh, felipe               (DL: chris, lj)
Centers:       zaba, eddy                 (DL: romario, leonhard, cavit)
```
Si un jugador aparece con estado raro, es que su clave no coincide con la de `state.plan.avail`
(p. ej. "dejour" podría ser apodo). Ajustar la clave en `SEM_GROUPS`.

---

## 8. Pendiente / roadmap (lo que quedaba)

**A confirmar con el usuario:**
- **Rooster "en construcción"**: ¿sustituir el Rooster funcional por la pantalla "under construction"
  (como Player database) o dejarlo? (hay un patrón de gate ya en la app).
- **Month**: ¿añadir indicador de sesión (punto/etiqueta) en el día del calendario? (hoy la sesión
  sale en Session, no en Month).

**Depende de datos/credenciales del usuario:**
- **Duplicar game plan de otro partido** (desplegable + duplicar): falta el **RPC de LECTURA** de
  informes en Supabase (se conoce el de guardar: `save_report`). Con el nombre del RPC de lectura se cierra.
- **Synergy / Player Database** (portales con login): **no se pueden usar credenciales del usuario**
  por seguridad. Alternativa: que exporte **CSV/Excel** y se integra.

**Features grandes sin construir:**
- **Q1 y Q2 lado a lado** en el game plan.
- **Player Development**: tabla visual (jugadores × objetivos × meses) con **métrica de medición
  no subjetiva** + colores. Requiere definir con el usuario qué métricas medibles por objetivo.
- **Unificar Rooster + Player Database + Market** (2 pestañas: "los que nos interesan" / "mercado")
  + autocarga **RealGM**.
- **Post game/practice**: construir el **informe post-partido** en sí (ahora solo se añadió la hoja
  de entrenamiento). De eso depende el link "post-game" en game-to-game (hoy el código dice
  "el post game lo definimos aparte").

---

## 9. Flujo de trabajo recomendado en la nueva conversación

1. Subir `index.html` (o el zip v41). Pedir a Claude que trabaje SOBRE ese `index.html`.
2. Para cada cambio: localizar con `grep -nE '...' | awk -F: '$1<7307'`, editar con `str_replace`
   o script Python, **evitando** imprimir `defaultState()`.
3. Validar (`node --check` de ambos scripts + balance de llaves por `<style>`).
4. Empaquetar `index.html` + `netlify.toml` + `netlify/functions/sheets.js` en un nuevo
   `coaches-hub-netlifyN.zip` y presentarlo.
5. El usuario despliega en Netlify + **Ctrl+Shift+R**.

**Preferencia del usuario:** entregas concretas, poco ida y vuelta, criterio de diseñador gráfico/UX
senior, y honestidad sobre lo que no da tiempo a hacer bien (mejor decirlo que entregarlo a medias).
