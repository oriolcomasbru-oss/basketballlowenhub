# LÖWEN COACHES HUB — README

App web interna del cuerpo técnico de **Basketball Löwen Braunschweig** (BBL).
Todo vive en **`index.html`** (un único archivo ~1 MB: HTML + 3 bloques `<style>` + JS vanilla).
Se despliega en **Netlify** (backend Supabase, sync desde Google Sheets).

> **Lee primero `HANDOFF-lowen-coaches-hub.md`** — tiene el modelo de datos, el mapa de
> funciones, el historial y los *gotchas*. Este README es solo el arranque rápido.

## Archivos
- `index.html` — la app (lo único que se edita normalmente).
- `netlify.toml` — config Netlify.
- `netlify/functions/sheets.js` — proxy de los CSV de Google Sheets.

## Desplegar
Repo: `github.com/oriolcomasbru-oss/basketballlowenhub`. Netlify despliega solo con cada push a `main`.

Método manual (antiguo):
Empaquetar los 3 en `coaches-hub-netlifyN.zip` → arrastrar a Netlify → abrir web → **Ctrl+Shift+R**.
(No se puede probar en vivo desde el entorno de build; se valida con `node --check` + balance de llaves.)

## ⚠️ Reglas críticas
1. **NO imprimir `defaultState()`** (línea ~1900, JSON en una sola línea gigante → gasta muchísimo contexto).
   Usa greps acotados con `awk -F: '$1<7307'` para quedarte en la app principal.
2. **3 bloques `<style>`** (main ~7, phxScoped ~6023, phxEmbed ~6747). Los overrides de clases `.phx`
   van en el **ÚLTIMO** bloque para ganar (`rfind("</style>")`).
3. El bloque `<style>` principal tiene un **descuadre benigno de 1 llave** (una `{`/`}` dentro de una
   cadena CSS). No es error; ignóralo.
4. Trabaja SIEMPRE sobre el `index.html` que sube el usuario; nunca desde cero. Entrega zips numerados (v42, v43…).

---

## Primeros comandos (orientación en el archivo)

Ejecuta estos para situarte sin gastar contexto (copia/pega en bash):

```bash
cd <carpeta-del-proyecto>

# 0) tamaño y nº de líneas
wc -l index.html

# 1) mapa de vistas y funciones clave de la app principal (sin tocar defaultState)
grep -nE "function (cycleView|sessionSheetView|printSession|monthlyView|renderPlaybook|renderPlan|applyView|setView|renderOppScout|renderTeamScout|trainingCard|renderScout|renderReportSections|renderDualCard|availSemaforo|availDayMini|parsePracticePDF|sessionPdfSlot|cycleFor|mergePractices)" index.html | awk -F: '$1<7307'

# 2) sync de Google Sheets
grep -nE "function (syncFromGoogle|syncCalendar|syncKinexon|syncGames|syncMedical)|PUBCSV" index.html | awk -F: '$1<7307'

# 3) permisos / pestañas
grep -nE "SECT_KEYS=|SECT_LABELS|data-view=" index.html | awk -F: '$1<7307' | head

# 4) claves de jugador para disponibilidad
grep -nE "SEM_GROUPS|DL_KEYS|NAME_ALIAS" index.html | awk -F: '$1<7307'

# 5) VALIDACIÓN estándar antes de entregar (script principal)
python3 - <<'PY'
s=open("index.html").read().split("\n")
ds=[i for i,l in enumerate(s) if 'function defaultState()' in l][0]
op=max(i for i in range(ds) if '<script>' in s[i]); cl=min(i for i in range(op,len(s)) if '</script>' in s[i])
open("/tmp/main.js","w").write("\n".join(s[op+1:cl]))
print("main script lines", op+1, cl+1)
PY
node --check /tmp/main.js && echo "MAIN OK"

# 6) VALIDACIÓN del script del scouting-hub (phx)
python3 - <<'PY'
s=open("index.html").read().split("\n")
i=[k for k,l in enumerate(s) if 'window.__phxEmbed=true' in l][0]
op=max(k for k in range(i+1) if '<script>' in s[k]); cl=min(k for k in range(op,len(s)) if '</script>' in s[k])
open("/tmp/phx.js","w").write("\n".join(s[op+1:cl]))
PY
node --check /tmp/phx.js && echo "PHX OK"

# 7) balance de llaves por bloque <style> (el bloque main puede dar 1-off benigno)
python3 - <<'PY'
s=open("index.html").read().split("\n")
i=0
while i<len(s):
    if '<style' in s[i]:
        j=i
        while j<len(s) and '</style>' not in s[j]: j+=1
        b="\n".join(s[i:j+1]); print("style@",i+1,"{",b.count('{'),"}",b.count('}'))
        i=j+1
    else: i+=1
PY
```

## Empaquetar una entrega nueva
```bash
zip -r coaches-hub-netlify42.zip index.html netlify.toml netlify/functions/sheets.js
```
