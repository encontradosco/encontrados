---
name: cambio-de-esquema
description: Agregar o cambiar una columna, una tabla, un índice o un CHECK en este repo, que no tiene carpeta de migraciones — el esquema se crea solo en cada arranque, sobre dos adaptadores (Postgres y SQLite) que tienen que quedar iguales, y varias instancias arrancan a la vez contra la misma base. Úsala cuando el cambio toque `src/store/`, un campo nuevo que haya que persistir, o cuando alguien pregunte cómo se migra la base acá.
---

# Cambiar el esquema

**Esto lo decide una persona.** El esquema es una de las tres categorías que no
avanzan solas (ver `/pr-chico`): la base de producción es compartida, y una
migración tiene consecuencias que un preview —que arranca con la base vacía— no
puede mostrar. Prepara el cambio completo, decláralo en el PR y espera.

## Cómo funciona acá

**No hay carpeta de migraciones.** El esquema se crea solo al arrancar, en cada
cold start, con `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` +
`ALTER TABLE … ADD COLUMN`. Eso vive en `src/store/postgres.js` (producción) y
`src/store/sqlite.js` (dev y pruebas).

De ahí salen tres invariantes:

### 1. Todo se agrega en los DOS adaptadores

El mismo contrato sobre dos motores. Una columna que existe solo en uno se
manifiesta como un bug que pasa toda la suite (que corre sobre SQLite) y falla en
producción — o al revés. Con la sintaxis de cada uno:

- **Postgres**: `ALTER TABLE x ADD COLUMN IF NOT EXISTS col TIPO`.
- **SQLite**: no soporta `IF NOT EXISTS` en `ADD COLUMN`. El patrón del archivo
  es un `try { db.exec('ALTER TABLE …') } catch { /* ya existe */ }`. Cálcalo.

Cuida los tipos equivalentes: `DOUBLE PRECISION`/`REAL`, `BYTEA`/`BLOB`,
`JSONB`/`TEXT`. Y hay una decisión ya tomada que conviene respetar: las marcas de
tiempo que se comparan en JS van como **texto ISO en los dos motores**, porque un
`TIMESTAMPTZ` vuelve como `Date` en Postgres y como string en SQLite — esa
diferencia se cuela en producción y no en las pruebas.

### 2. Todo statement tiene que ser seguro corriendo en paralelo consigo mismo

En Vercel varias instancias arrancan **a la vez contra la misma base**, y todas
corren el bootstrap. Por eso todo es `IF NOT EXISTS` o idempotente.

El caso peligroso es un `DROP CONSTRAINT`: entre el drop y el `ADD` hay una
ventana donde otra instancia ve la tabla sin su restricción. La regla del repo es
que **un constraint que se suelta se repone en el MISMO statement**, y hay una
prueba que lo vigila: `test/schema-bootstrap.test.js` captura el SQL que emite el
bootstrap con un `pg` de mentiras y verifica la forma. Si tu cambio toca un
`CHECK`, esa prueba es la que te va a hablar.

### 3. La retención se hereda, no se reinventa

Toda tabla que cuelga de `people(id)` va con `ON DELETE CASCADE`: es lo que hace
que `DELETE /api/people/:id` cumpla lo que promete la política de privacidad.
Una tabla nueva sin cascada abre un hueco de retención en silencio.

Y si la tabla es una bitácora, **solo IDs y enums** — nunca un nombre, un
contacto ni texto libre. Así están `match_log` y `contact_log`.

## Pasos

1. **Escribe el `CREATE`/`ALTER` en los dos adaptadores**, con la sintaxis de
   cada motor y en el mismo lugar del archivo donde están los demás.
2. **Rellena hacia atrás mentalmente**: la columna nace `NULL` en todas las filas
   que ya existen. El código que la lee tiene que aguantar eso — en producción no
   hay un momento en que la tabla esté vacía.
3. **Nada de `NOT NULL` sin default** sobre una tabla con datos: la instancia que
   corra ese `ALTER` primero se cae al arrancar.
4. **Prueba con base nueva y con base vieja.** Base nueva es `npm test` (SQLite en
   memoria). Base vieja se simula en local: corre `npm run dev` con tu
   `./data/encontrados.db` de siempre y mira que arranque sin excepción.
   > Si tu cambio **ensancha un `CHECK`** en SQLite, ese archivo local no lo va a
   > aceptar: SQLite no puede ampliar un CHECK por `ALTER TABLE`. Bórralo
   > (`rm data/encontrados.db`) — es de desarrollo y se reconstruye solo.
5. **Agrega la prueba.** `test/schema-bootstrap.test.js` para la forma del SQL,
   y una prueba de comportamiento para lo que la columna hace.
6. **En el PR**: declara que toca el esquema, di qué columna, de qué tipo, con
   qué valor por omisión para las filas viejas, y **qué pasa si dos instancias
   corren el bootstrap al mismo tiempo**. Eso es lo que una persona necesita para
   decidir.

## Lo que no se hace

- **No correr SQL a mano contra la base de producción** para «adelantar» la
  migración. Si el arranque no la puede hacer solo, el cambio no está terminado.
- **No cambiar un tipo en su lugar** ni renombrar una columna en uso: se agrega
  la nueva, se llena, se lee de las dos, y la vieja se retira en otro PR.
- **No borrar una columna** en el mismo PR que deja de usarla. Producción está
  corriendo el código anterior hasta que el deploy termine.
