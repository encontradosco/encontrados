---
name: pr-chico
description: Preparar y abrir un PR chico en este repo siguiendo sus convenciones — rama fresca desde main, un cambio por PR, título en español que describe el efecto, cuerpo con «cómo lo verificaste», tests en verde — y hacer el autochequeo de si el cambio cae en una de las tres categorías que decide una persona. Úsala cuando haya que abrir un PR, mandar un cambio, armar la rama o el mensaje de commit, o cuando alguien pregunte si su cambio se puede mergear.
---

# Abrir un PR chico

`main` es producción: Vercel despliega cada merge. **Mergear *es* desplegar**, en
vivo, sobre un servicio de emergencia. Todo lo de abajo sale de ahí.

## 1. Antes de escribir: ¿esto lo decide una persona?

Contesta las tres preguntas **antes** de construir, no al final:

1. ¿Cambia **lo que ve o hace un usuario**? Un texto, un flujo, a dónde lleva un
   botón, el orden de unos campos.
2. ¿Toca **el esquema de la base**? Ver `/cambio-de-esquema`.
3. ¿Toca **privacidad**? Fotos, contacto de quien reporta, retención, borrado,
   qué sale en una respuesta pública o en un mensaje saliente.

**Si alguna es sí:** conviene abrir un issue *antes* de escribir el código (una
frase basta), y si el PR ya existe, **decláralo con esas palabras en el cuerpo y
no lo mergees** — la decisión la toma una persona. Un PR que necesitaba issue no
se cierra ni se descarta: pasa a *draft*, se conversa en el issue, y vuelve a
*ready* cuando hay acuerdo. El trabajo no se pierde; lo que falta es el acuerdo.

**Si las tres son no** —corrección de errores, texto y copy, refactors sin
comportamiento observable, documentación— es rutinario y avanza con la revisión
de un mantenedor.

El corte es **por consecuencia, no por tamaño**: una línea que cambia lo que lee
una familia espera; trescientas que no cambian nada observable, no.

## 2. La rama

```bash
git fetch origin
git switch -c fix/lo-que-arregla origin/main
```

Siempre desde el `main` **actual**, no desde una rama vieja. Prefijos que ya usa
el repo: `fix/`, `refactor/`, `docs/`, `feat/`. Nombres descriptivos en español.

**Un PR = una preocupación.** Si arreglas el header y de paso renombras
variables, son dos PRs. Una rama grande de reconciliación compite con el trabajo
de los demás y se pudre — ya pasó una vez y esa rama se descartó.

## 3. El título

En español, **describiendo el efecto, no el archivo**. Es la convención real del
historial:

- ✅ «El contacto de una familia ya no viaja en ningún mensaje que se envíe»
- ✅ «Un rescatista que despierta el matcher no puede ser a quien le digan que no está disponible»
- ❌ «actualiza notify.js»
- ❌ «fix: privacy»

Sin prefijos de conventional commits: el historial de este repo son frases.

## 4. El cuerpo

La plantilla (`.github/PULL_REQUEST_TEMPLATE.md`) es una ayuda, no un formulario
que haya que llenar completo. Lo que no se puede saltar:

- **Qué se rompía o faltaba**, y qué hace este PR. Si cierra un issue: «Cierra #123».
- **Cómo lo verificaste** — lo más útil del PR. Los números convencen más que los
  adjetivos: «la marca envolvía a dos líneas en 375px, ahora entra en una» dice
  algo; «mejoré el header» no. Si es visual, en qué ancho lo probaste.
- La casilla de `npm test` en verde.
- Si tocaste **fotos** —las dos reglas son opuestas a propósito— dilo explícito.
- Si el PR lo escribió un agente, **dilo al final del cuerpo**. Acá eso se dice de
  frente, no se disimula.

## 5. Antes de abrirlo

```bash
npm test        # en verde, sin excepción
git diff origin/main --stat
```

Mira el `--stat` y pregúntate si de verdad es **un** cambio. Si tocaste
privacidad, corre `/revision-privacidad` antes de abrir.

```bash
gh pr create --base main --title "…" --body "…"
```

El PR levanta un **preview deployment**: una copia desechable con base vacía y
sin datos reales. Es para ver tu cambio, no para probar contra producción.

## 6. Lo que no se hace

- **No mergear** un PR de las tres categorías, ni el propio. GitHub tampoco lo
  permite, y está bien que no lo permita: todo cambio lo mira alguien distinto de
  quien lo escribió, incluido el de un mantenedor.
- **No forzar un push** sobre una rama que alguien ya está revisando.
- **No meter** en el mismo PR un arreglo urgente y una limpieza que puede esperar.
