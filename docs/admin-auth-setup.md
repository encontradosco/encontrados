# Setup de "Sign in with Vercel" para /admin (#116, PR 5)

Esto lo corre un humano — @ni500 — en el dashboard de Vercel. El código no toca el dashboard ni genera secretos; solo consume las variables de entorno que quedan configuradas al final de esta guía.

Referencia oficial: [vercel.com/docs/sign-in-with-vercel](https://vercel.com/docs/sign-in-with-vercel).

## Por qué esta dirección

El operador aprobó dejar el auth en Vercel porque Nic y Alex ya tienen silla en el team de Vercel del proyecto — no hace falta gestionar contraseñas ni un tercer proveedor. "Sign in with Vercel" es un IdP OAuth 2.0 / OIDC estándar (GA), no un producto atado a Next.js — la app de encontrados lo consume con `fetch` plano, sin ningún SDK.

## 1. Crear la App en el dashboard de Vercel

1. Entra a **Settings** del team → **Apps** → **Create**.
2. Nombre: algo como `encontrados-admin`. El slug se genera solo.
3. **Save**.

## 2. Elegir el método de autenticación del cliente

Deja el default, `client_secret_basic` — es el que corresponde a una app de servidor (Express) que sí puede guardar un secreto de forma segura (variable de entorno en Vercel, nunca en el repo).

## 3. Generar el client secret

En la página **Manage** de la App, botón **Generate**. Guarda el valor — no se vuelve a mostrar completo. (Se pueden tener hasta dos secretos activos a la vez, para rotar sin downtime.)

## 4. Configurar las URLs de callback autorizadas

En **Manage** → **Authorization Callback URLs**, agrega **una entrada por cada entorno donde se vaya a probar o correr esto**:

| Entorno | Callback URL |
|---|---|
| Local | `http://localhost:3000/admin/auth/callback` |
| Producción | `https://encontrados.co/admin/auth/callback` |
| Preview (si aplica) | la URL de preview de Vercel + `/admin/auth/callback` — o selecciona el proyecto de Vercel del dropdown en vez de una URL fija, así cubre cualquier deployment domain del proyecto |

**Ojo:** el callback tiene que coincidir EXACTO con lo que la app arma (`BASE_URL` + `/admin/auth/callback`). Si `BASE_URL` no está seteada, la app la deriva de `VERCEL_PROJECT_PRODUCTION_URL`/`VERCEL_URL` (ver `src/env.js`) — en Vercel normalmente coincide sola; en local, con `BASE_URL` sin configurar cae a `http://localhost:3000`.

## 5. Configurar permisos (scopes)

En **Manage** → **Permissions**, habilita **openid** y **email** — nada más. La app no pide `profile` ni `offline_access`: no necesita el nombre ni la foto, y no retiene tokens entre requests (ver el comentario de diseño al inicio de `src/adminAuth.js`).

## 6. Variables de entorno — orden y dónde van

Configúralas en el dashboard de Vercel (Settings → Environment Variables) del proyecto de encontrados, **Production** (y **Preview** si vas a probar ahí):

| Variable | De dónde sale | Notas |
|---|---|---|
| `VERCEL_APP_CLIENT_ID` | Página **Manage** de la App (paso 1) | No es secreto, pero tampoco hace falta hardcodearlo |
| `VERCEL_APP_CLIENT_SECRET` | Generado en el paso 3 | **Secreto** — marca la variable como "Sensitive" en Vercel |
| `ADMIN_SESSION_SECRET` | Generado por ti: `openssl rand -hex 32` | **Secreto** — no tiene nada que ver con el secreto de Vercel; firma la cookie de sesión propia de la app. Rotar este valor cierra TODAS las sesiones activas de golpe (útil si hace falta) |
| `ADMIN_EMAILS` | Los correos que van a administrar, separados por coma — ej. `nicolas@ejemplo.com,alex@ejemplo.com` | **Nunca se hardcodea en el repo** — el repo es público. Sin esta variable (o vacía), `/admin` queda cerrada para TODOS, incluso para quien inicie sesión con éxito en Vercel |

Sin las tres primeras, `/admin/login/start` responde `503` (login no configurado) — la app se niega a arrancar un flujo a medias, nunca deja pasar por accidente.

## 7. Probar

1. Local: `npm run dev`, entra a `http://localhost:3000/admin` → debe redirigir a `/admin/login`.
2. Click "Iniciar sesión con Vercel" → Vercel pide login (si no estás ya logueado) y la pantalla de consentimiento.
3. Al aceptar, vuelve a `/admin` y debe mostrar tu correo + el aviso de "panel en construcción".
4. Prueba con una cuenta de Vercel que NO esté en `ADMIN_EMAILS` — debe dar `403`, no dejar pasar y no repetir el login en silencio.
5. "Cerrar sesión" en el panel → vuelve a pedir login.

## Lo que este PR NO hace

No crea ningún endpoint de administración real — eso es el PR 6 (el panel de verdad, agregados + drill-down). Este PR entrega el gate y un stub que confirma que el flujo funciona de punta a punta. Cualquier ruta que se agregue bajo `/api/admin/*` en el PR 6 nace protegida — el middleware ya está montado ahí, solo hay que agregar rutas dentro del router que devuelve `adminApiRoutes()`.
