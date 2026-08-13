# Trabajar este repo con Claude Code

Esta carpeta es la configuración compartida del proyecto para
[Claude Code](https://docs.claude.com/en/docs/claude-code). Se versiona a
propósito: la idea es que cualquiera clone el repo, abra su agente y sea
productivo sin que nadie le explique nada por chat.

```
.claude/
  settings.json     # permisos compartidos: lo obviamente seguro va sin preguntar
  skills/           # los comandos de lo que más se repite acá
```

Nada de esto contiene credenciales ni las necesita.

---

## Arranque rápido (10 minutos, sin credenciales)

**Lo que hay que instalar:**

- **Node 22** (el `package.json` pide `>=18`; CI corre 22, y `better-sqlite3` y
  `sharp` traen binarios listos para esa versión).
- **Claude Code**: `npm install -g @anthropic-ai/claude-code`.
- Opcional pero cómodo: [`gh`](https://cli.github.com), el CLI de GitHub, para
  abrir PRs y leer issues desde la misma sesión.

**Lo que hay que correr:**

```bash
git clone https://github.com/encontradosco/encontrados.git
cd encontrados
npm install
npm test        # debe quedar en verde
npm run dev     # http://localhost:3000
claude          # y ya: CLAUDE.md se carga solo
```

**Lo que NO hace falta:** ninguna variable de entorno, ningún `.env`, ninguna
credencial de AWS, de SendGrid, de WhatsApp ni de la base de datos de
producción. La app arranca completa sobre SQLite local y apaga en silencio lo
que no puede hacer (te lo dice en el log). **Para desarrollar no se necesita
producción, y es mejor así**: lo que hay allá son datos de personas reales.

Lo único que cambia con credenciales es el reconocimiento facial: sin AWS el
flujo del rescatista se abre y se recorre, pero no encuentra a nadie.

---

## Cuatro cosas para pedirle a tu Claude el primer día

Sirven para tomarle el pulso al repo sin escribir código todavía:

1. **«Lee `agent.md` y explícame el camino completo de una foto que sube un
   rescatista, desde el POST hasta el correo, nombrando archivo y función en
   cada paso.»**
   Es el flujo central del producto y toca casi todo el árbol.

2. **«¿Qué pasa hoy si `SENDGRID_API_KEY` no está puesta? ¿Y si `AVISO_EMAIL` no
   está? Muéstrame en el código dónde se decide.»**
   Acá casi toda variable que falta *apaga* una función en silencio, a propósito.
   Entender ese patrón explica la mitad de los reportes de «no está pasando nada».

3. **«Corre `npm test` y resúmeme qué cubre la suite por archivo. ¿Cuál es el que
   protege que no se filtre el contacto de una familia?»**
   Son ~30 archivos de `node --test` sin framework. La respuesta que buscas
   incluye `test/privacy.test.js`.

4. **«Busca en los issues abiertos uno marcado `good first issue`, léelo, y
   propóneme el PR más pequeño que lo resuelva — sin escribirlo todavía.»**
   Es el ciclo real del proyecto, y de paso te muestra dónde para el agente
   cuando el cambio cae en una de las tres categorías que decide una persona.

Y si querés una quinta: **«¿Este cambio que estoy pensando cambia comportamiento
de cara al usuario, el esquema o privacidad?»** Esa pregunta, hecha antes de
escribir, ahorra el rodeo entero.

---

## Los comandos

Cada uno vive en `skills/<nombre>/SKILL.md` y se invoca escribiendo `/<nombre>`.
Claude también los usa solo cuando la conversación los pide.

| Comando | Para qué |
|---|---|
| `/pruebas` | Correr la suite y **escribir** una prueba nueva calcando las convenciones del repo |
| `/pr-chico` | Abrir el PR: rama, título, cuerpo, y el autochequeo de si esto lo decide una persona |
| `/revision-privacidad` | Verificar que un cambio no filtre datos personales antes de mandarlo |
| `/cambio-de-esquema` | Agregar o cambiar una columna sin carpeta de migraciones y sin romper un adaptador |

---

## Los permisos de `settings.json`

Están puestos para que no vivas aprobando prompts por cosas que no pueden hacer
daño: correr las pruebas, instalar dependencias, y **lecturas** de `git` y `gh`.

Todo lo que escribe queda fuera a propósito, y lo que puede tocar producción o
un secreto está **denegado explícitamente**: desplegar, mergear, forzar un push,
conectarse a una base remota, o leer un `.env`. Un `deny` no se puede aprobar por
error en el momento equivocado; por eso está escrito y no simplemente omitido.

Si querés permisos adicionales para vos, **no edites este archivo**: poné los
tuyos en `.claude/settings.local.json`, que está en `.gitignore` y no viaja al
repo.
