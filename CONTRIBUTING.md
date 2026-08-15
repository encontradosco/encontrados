# Cómo contribuir

Gracias por venir a ayudar. Este proyecto salió del terremoto del 10 de agosto de
2026 y está en producción con gente real del otro lado: familias buscando a los
suyos y rescatistas con una persona enfrente. Eso no lo vuelve intocable — lo
vuelve un proyecto donde vale la pena leer diez minutos antes de escribir la
primera línea.

## Lo primero: corre local en dos comandos

No necesitas credenciales de nada. Ni base de datos, ni claves de AWS, ni correo.

```bash
npm install
npm run dev      # SQLite en ./data/encontrados.db → http://localhost:3000
```

La app arranca completa. Lo que falta se degrada solo y te lo dice en el log:
sin credenciales de AWS el reconocimiento facial queda apagado (las fotos igual
se guardan), sin `SENDGRID_API_KEY` los correos se saltan, y sin `DATABASE_URL`
se usa SQLite local en vez de Postgres. Para trabajar en la interfaz, en los
formularios o en el texto, eso es todo lo que necesitas.

Los tests:

```bash
npm test         # node --test, sin red y sin servicios externos
```

> **Si `npm test` muere con `ERR_DLOPEN_FAILED` o un error de
> `NODE_MODULE_VERSION`:** es `better-sqlite3` compilado para otra versión de
> Node. `npm rebuild better-sqlite3` y vuelve a correr. Es tu entorno, no tu
> cambio.

## Si trabajas con un agente

Va a leer [`CLAUDE.md`](CLAUDE.md) solo al abrir el repo: ahí están las reglas
que no se pueden ignorar y a dónde ir por cada cosa. En
[`.claude/`](.claude/README.md) están los comandos de lo que más se repite acá
(`/pruebas`, `/pr-chico`, `/revision-privacidad`, `/cambio-de-esquema`) y un
arranque rápido para el primer día. Todo lo de este archivo aplica igual: quien
manda el PR responde por él, lo haya escrito a mano o no.

## Qué trabajar

- Los issues marcados [`good first issue`](https://github.com/encontradosco/encontrados/labels/good%20first%20issue)
  son puntos de entrada reales, no tareas de relleno.
- Los marcados [`help wanted`](https://github.com/encontradosco/encontrados/labels/help%20wanted)
  son los que más falta hacen.
- ¿Encontraste algo por tu cuenta? Abre un issue antes de escribir el código si
  el cambio es grande. Si es chico, manda el PR directo.

## Qué tipo de cambio es el tuyo

De esto depende si mandas el PR de una o si conviene abrir un issue primero. No
es burocracia: es que algunos cambios se revisan mirando el diff y otros hay que
decidirlos antes de que alguien gaste una tarde escribiéndolos.

| | Qué es | Qué hacer |
|---|---|---|
| **Bug** | La app no hace lo que dice que hace | **PR directo.** Incluye cómo reproducirlo |
| **Mejora** | Hace lo que dice, pero podría hacerlo mejor: copy, accesibilidad, rendimiento, un refactor acotado | **PR directo** si es acotado. **Issue primero** si toca varios archivos o cambia una decisión de diseño existente |
| **Feature o cambio de comportamiento** | Algo nuevo que un usuario ve o hace, o que cambia un flujo que ya existe | **Issue primero, siempre** |

**Tres cosas mandan a issue aunque parezcan chicas**, porque su costo no se ve en
el diff:

1. **Lo que ve o hace un usuario** — un texto, un flujo, a dónde lleva un botón.
   Es un servicio de emergencia: una pantalla confusa le cuesta tiempo a alguien
   que está buscando a un familiar.
2. **El esquema de la base** — la de producción es compartida y migrarla tiene
   consecuencias que no se prueban en un preview.
3. **Privacidad** — fotos, contacto de quien reporta, retención o borrado. Las
   reglas están en el README y no son preferencias de estilo.

### Si mandas un PR que necesitaba issue

No se cierra ni se descarta. **Se pasa a draft**, se abre (o se pide) el issue, y
se conversa ahí. Cuando la decisión esté tomada, el mismo PR vuelve a *ready* y
sigue su camino. El trabajo no se pierde: lo que falta es el acuerdo, no el
código.

Si preferís evitarte ese rodeo, abre el issue antes. Una frase basta.

## Cómo se manda un cambio

**PRs pequeños, sobre `main`.** `main` es producción: Vercel despliega cada merge.
Un PR acotado se revisa y entra el mismo día; una rama grande compite con el
trabajo de los demás y se pudre. Ya nos pasó una vez y la rama se descartó.

1. Rama fresca sobre el `main` actual.
2. Un PR = una preocupación. Si arreglas el header y de paso renombras variables,
   son dos PRs.
3. `npm test` en verde antes de abrirlo.
4. En la descripción: qué se rompía, qué hiciste, y **cómo lo verificaste**. Si
   es visual, di en qué ancho lo probaste. Los números convencen más que los
   adjetivos: "la marca envolvía a dos líneas en 375px, ahora entra en una" es
   una descripción; "mejoré el header" no.

Tu PR arranca un **preview deployment**: una copia desechable con base de datos
vacía, sin datos reales. Es para ver tu cambio, no para probar contra
producción.

### Antes de construirlo, conversa si tu cambio…

- **cambia lo que ve o hace un usuario** — un texto, un flujo, un botón que
  decide a dónde va la gente. Esto es un servicio de emergencia: una pantalla
  confusa le cuesta tiempo a alguien que está buscando a un familiar.
- **toca el esquema de la base** — la de producción es compartida y migrarla
  tiene consecuencias.
- **toca privacidad**: fotos, contacto de quien reporta, retención de datos.
  Estas reglas están en el README y no son preferencias de estilo.

Abre un issue y lo hablamos. No es pedir permiso; es que el costo de
equivocarse acá lo paga alguien más.

## Reglas duras

**Nunca subas datos personales reales.** Ni en un test, ni en un fixture, ni en
un pantallazo de un issue, ni en un comentario. Los tests usan nombres
sintéticos ("Persona Prueba Uno") y así se quedan. Esto incluye fotos, teléfonos,
correos y documentos.

**Nunca subas credenciales.** Si necesitas una variable nueva, agrégala a
`.env.example` con un valor de ejemplo, nunca con el real.

**Las dos reglas de las fotos son opuestas a propósito** y hay que respetarlas:
la foto que sube un **rescatista** se compara, se indexa su firma facial y los
bytes se borran — nunca se muestra. La foto de un **reporte de desaparecido** sí
se guarda y sí se publica, porque de eso se trata: que alguien la reconozca. Si
tu cambio toca cualquiera de las dos, dilo explícitamente en el PR.

**Un hallazgo de seguridad no va en un issue público.** Ver
[SECURITY.md](SECURITY.md).

## La revisión

Revisan los mantenedores core: [@torrenegra](https://github.com/torrenegra),
[@ni500](https://github.com/ni500), [@yesid-lopez](https://github.com/yesid-lopez)
y [@cris-pappcorn](https://github.com/cris-pappcorn) — este último es un agente
de IA, y lo decimos de frente porque vas a interactuar con él. Buscamos tres
cosas, en este orden: que resuelva un problema real, que no rompa a nadie más, y
que sea lo más pequeño que puede ser para lograrlo. Vas a recibir preguntas —
son sobre el código, no sobre ti.

`main` está protegida: todo entra por PR, con los tests en verde y la aprobación
de uno de los cuatro. **Nadie aprueba su propio PR** — GitHub no lo permite, y
está bien que no lo permita: todo cambio lo mira alguien distinto de quien lo
escribió, incluido el de un mantenedor. Esa es la mitad que sostiene la de
abajo.

### Qué entra con una revisión y qué espera a una persona

**Con la revisión de un solo mantenedor se mergea lo rutinario:** corrección de
errores, texto y copy, refactors que no cambian comportamiento observable, y
documentación. Ahí lo que manda es la velocidad — un arreglo urgente en medio de
una emergencia no debería esperar a que coincidan dos husos horarios.

**Se detiene, y la decisión la toma una persona, en tres casos** — los mismos
tres que mandan a issue:

1. **Lo que cambia el comportamiento de cara al usuario** — un texto, un flujo,
   a dónde lleva un botón.
2. **El esquema de la base.**
3. **Privacidad o datos personales**, incluidos la retención y el borrado.

El motivo es que acá **`main` es producción**: Vercel despliega cada merge, así
que mergear *es* desplegar. De ese hecho sale toda la regla, y no hay cómo
adivinarlo desde afuera, por eso está escrito.

El corte es **por consecuencia, no por tamaño ni por tipo de archivo**. Un PR de
una línea que cambia lo que lee una familia espera; un refactor de trescientas
líneas que no cambia nada observable, no. Lo que no puede hacerle daño a alguien
que está buscando a un familiar no tiene por qué esperar a que alguien despierte.

### Qué puedes esperar de nosotros

Que te respondamos. Y que si tu PR cae en una de las tres categorías te lo
digamos con esas palabras — qué falta decidir y quién lo decide — en vez de
dejarlo callado. Un PR que espera una decisión y un PR olvidado se ven igual
desde afuera; distinguirlos nos toca a nosotros.

Si un PR se queda quieto más de un par de días, coméntalo. No es desinterés: es
un proyecto de emergencia y la atención se mueve.

## El código

Sin frameworks y a propósito: HTML renderizado en el servidor, un CSS pequeño,
cero build en el frontend. Tiene que funcionar en un teléfono viejo con una
barra de señal. Antes de proponer una dependencia nueva, pregúntate si el
problema se resuelve sin ella — casi siempre sí.

Sigue el estilo del archivo que estás tocando. Los comentarios explican **por
qué**, no qué: el qué ya está en el código.
