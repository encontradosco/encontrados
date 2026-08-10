# Instrucciones para agentes (AI y humanos)

## Regla principal: SIEMPRE publicar a producción

**Todo cambio debe quedar en producción inmediatamente.** Después de cualquier
modificación al código:

1. Corre las pruebas: `npm test` (deben quedar en verde).
2. Haz commit con mensaje claro y push a la rama de trabajo.
3. **Lleva el cambio a `main` de inmediato** (merge del PR, o push directo a
   `main` si no hay PR). Vercel despliega `main` a producción automáticamente.
4. No dejes trabajo "pendiente de deploy": si está en `main`, está vivo; si no
   está en `main`, no existe.

Este es un servicio de emergencias: un cambio útil que no está publicado no
ayuda a nadie.

## Contexto del proyecto

- **aqui.online**: tablero de estado de personas en emergencias.
- Toda la interfaz y los mensajes al usuario son **en español**.
- Canales activos: web y API REST. WhatsApp está implementado pero dormido (sin credenciales aún) — no mostrar referencias a WhatsApp en la interfaz hasta que se active. (Telegram fue retirado.)
- Fotos: solo para reconocimiento facial (AWS Rekognition). NUNCA crear rutas que muestren o sirvan fotos.
- Producción: Vercel (función serverless única + Postgres/Neon). Dev/tests: SQLite.
- Remitente de correo fijo: `a@torrenegra.com` (SendGrid).
- Suscripciones por correo requieren verificación; toda alerta lleva enlace de baja.
- El matching difuso de nombres vive en `src/names.js` + `people.js`; los umbrales
  (0.85 merge / 0.55 búsqueda) están calibrados — no los cambies sin pruebas.
