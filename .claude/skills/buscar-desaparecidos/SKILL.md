---
name: buscar-desaparecidos
description: Úsala cuando alguien pida buscar a una persona por nombre en los sitios públicos de búsqueda de desaparecidos — Buscador Terremoto, Colombia te busca o Encontrados — con frases como «busca a [nombre]», «encuéntralo en Buscador Terremoto», «revisa si aparece en Colombia te busca» o «búscalo en Encontrados».
---

# Buscar en Buscador Terremoto / Colombia te busca / Encontrados

Úsala cuando alguien pida buscar a una persona en los sitios públicos de
búsqueda de desaparecidos del terremoto, sobre todo:

- Buscador Terremoto: https://buscador-terremoto-colombia.onrender.com/
- Colombia te busca: https://colombiatebusca.com
- Encontrados: https://encontrados.co
- frases como «busca a [nombre]», «encuéntralo en Buscador Terremoto»,
  «revisa si aparece en Colombia te busca», «búscalo en Encontrados».

Esta skill solo lee **datos públicos** — la misma información que vería
cualquier visitante anónimo de cada sitio. Nunca expone contacto de quien
reporta ni reportes pendientes de revisión (ver «Privacidad y seguridad» más
abajo, y la regla 4 de [`CLAUDE.md`](../../../CLAUDE.md) si estás trabajando
dentro de este repo).

## Objetivo

Buscar en el sitio solicitado y resumir solo la información pública
disponible sobre la persona pedida.

Si la persona no especifica el sitio, busca en todas las fuentes configuradas
cuando sea posible, y etiqueta claramente de dónde viene cada resultado.

## Fuentes

### 1. Buscador Terremoto

URL base:

```text
https://buscador-terremoto-colombia.onrender.com
```

Endpoint de búsqueda descubierto en el frontend público:

```text
GET https://buscador-terremoto-colombia.onrender.com/api/search?q={query}
GET https://buscador-terremoto-colombia.onrender.com/api/search?q={query}&estado=missing
GET https://buscador-terremoto-colombia.onrender.com/api/search?q={query}&estado=deceased_confirmed
GET https://buscador-terremoto-colombia.onrender.com/api/search?q={query}&pagina={page}
```

URL de detalle:

```text
https://buscador-terremoto-colombia.onrender.com/persona/{slug}
```

El endpoint devuelve un JSON parecido a:

```json
{
  "hasMore": false,
  "page": 1,
  "results": [
    {
      "full_name": "...",
      "condition_status": "missing",
      "verification_level": "authority_confirmed",
      "last_seen_location_public": "...",
      "reported_unit": "...",
      "approximate_age": null,
      "last_seen_at": null,
      "approved_sightings_count": 0,
      "public_description": "...",
      "public_source_label": "...",
      "slug": "..."
    }
  ]
}
```

### 2. Colombia te busca

URL base:

```text
https://colombiatebusca.com
```

Este sitio no tiene un endpoint documentado. Antes de buscar, inspecciona la
página pública para identificar su mecanismo de búsqueda actual (formulario o
API). No asumas que usa la misma API que Buscador Terremoto.

Si aparece un endpoint público, documéntalo y úsalo. Si no hay ninguno
visible, usa la página/UI pública y resume solo los resultados visibles ahí.

### 3. Encontrados

URL base:

```text
https://encontrados.co
```

Igual que con Colombia te busca: inspecciona primero la página pública para
identificar su mecanismo de búsqueda actual. No asumas que usa la misma API
que los otros dos sitios.

Si aparece un endpoint público, documéntalo y úsalo. Si no hay ninguno
visible, usa la página/UI pública y resume solo los resultados visibles ahí.

**Nunca uses aquí una ruta de `/api/admin/*`, una sesión de rescatista, ni
ningún dato que no vería un visitante anónimo** — la superficie pública de
Encontrados ya pasa por `publicUpdate()` / `maskReporter()`
([`src/privacy.js`](../../../src/privacy.js)); esta skill no debe intentar
saltarse esa puerta.

## Cómo buscar

1. Determina qué fuente pidió la persona:
   - «Buscador Terremoto», «Encontrarnos» (alias viejo), o
     `buscador-terremoto-colombia.onrender.com` → Buscador Terremoto.
   - «Colombia te busca» o `colombiatebusca.com` → Colombia te busca.
   - «Encontrados» o `encontrados.co` → Encontrados.
   - Si no especifica → busca en todas las fuentes configuradas.

2. Para Buscador Terremoto, llama:

```text
https://buscador-terremoto-colombia.onrender.com/api/search?q=<nombre codificado>
```

3. Para Colombia te busca: inspecciona `https://colombiatebusca.com`, usa su
   mecanismo de búsqueda público actual, y si no se puede consultar
   automáticamente, dilo con claridad.

4. Para Encontrados: inspecciona `https://encontrados.co`, usa su mecanismo de
   búsqueda público actual, y si no se puede consultar automáticamente, dilo
   con claridad.

5. Busca primero una coincidencia exacta normalizada: minúsculas, sin tildes,
   nombre completo contra el nombre pedido.

6. Si no hay coincidencia exacta: dilo, resume coincidencias parecidas si las
   hay, e intenta de nuevo con nombres parciales o sin tildes.

7. Si hay una coincidencia exacta o probable: abre la página de detalle
   pública si existe, verifica los campos visibles ahí, y resume solo lo que
   devuelve la API pública o se ve en la página pública.

## Etiquetas de estado (Buscador Terremoto)

Mapeo de `condition_status`:

- `missing` → `Desaparecida`
- `possibly_trapped` → `Posiblemente atrapada`
- `located_alive` → `Localizada con vida`
- `reunited` → `Reunida con su familia`
- `deceased_confirmed` → `Fallecimiento confirmado`
- `closed` → `Caso cerrado`

Mapeo de `verification_level`:

- `unverified` → `Sin verificar`
- `moderator_reviewed` → `Revisado por moderación`
- `authority_confirmed` → `Confirmado por autoridad`

Para Colombia te busca y Encontrados, usa las etiquetas que muestre cada
sitio. No inventes un mapeo que no esté confirmado en la página o la API
pública.

## Estilo de respuesta

Responde en español salvo que la persona use otro idioma.

Para una coincidencia exacta, formato conciso:

```text
Sí, encontré a **{nombre_completo}** en **{nombre_fuente}**.

Estado: **{etiqueta_estado o No informado}**
Verificación: **{etiqueta_verificación o No informada}**
Lugar reportado: **{lugar o No informado}**
Edad aproximada: **{edad o No informada}**
Fecha y hora: **{fecha/hora o No informado}**
Posibles avistamientos/reportes revisados: **{conteo o 0/No informado}**
Fuente: **{etiqueta_fuente o No informada}**

Descripción pública: "{descripción_pública}"

Link directo al caso:
{url_caso}
```

Si la persona está con fallecimiento confirmado y la fuente es Medicina
Legal, sé claro pero cuidadoso:

```text
Estado: **Fallecimiento confirmado**
Fuente: **Medicina Legal**
```

Para coincidencias parecidas (sin exacta):

```text
No encontré una coincidencia exacta para **{consulta}** en **{nombre_fuente}**.

Estos son los resultados parecidos que aparecen:
1. **{nombre}** — {etiqueta_estado}, {lugar}
   Link: {url}
```

Si buscaste en varias fuentes, agrupa por fuente:

```text
Busqué en:
- Buscador Terremoto: https://buscador-terremoto-colombia.onrender.com/
- Colombia te busca: https://colombiatebusca.com
- Encontrados: https://encontrados.co

Resultados en Buscador Terremoto:
...

Resultados en Colombia te busca:
...

Resultados en Encontrados:
...
```

## Privacidad y seguridad

- No inventes información.
- No expongas reportes pendientes de revisión ni no públicos.
- Menciona que un reporte pendiente puede no ser público, cuando aplique.
- Si hay peligro inminente o es una emergencia, recomienda contactar a las
  autoridades o servicios de emergencia locales.
- Trata a las personas desaparecidas o fallecidas con un tono respetuoso.

## Ayudante en Python para Buscador Terremoto

```python
import requests, urllib.parse, unicodedata

BASE = "https://buscador-terremoto-colombia.onrender.com"

def norm(s):
    s = s or ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(s.lower().split())

query = "Persona Prueba Uno"
url = f"{BASE}/api/search?q={urllib.parse.quote(query)}"
data = requests.get(url, timeout=30).json()
exact = [r for r in data.get("results", []) if norm(r.get("full_name")) == norm(query)]
print(exact or data.get("results", []))
```
