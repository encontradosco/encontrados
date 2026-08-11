# Política de seguridad

Esta aplicación guarda datos personales sensibles de terceros en una emergencia:
fotos de personas desaparecidas, firmas faciales, y el contacto de quien las
busca. Un hallazgo de seguridad acá no es un bug más — puede exponer a alguien
que ya está en una situación vulnerable, y el escenario que nos preocupa tiene
nombre: después de un desastre aparecen extorsionistas que se hacen pasar por
quien tiene información de un familiar.

## Cómo reportar

**No abras un issue público.** Un issue es visible para todo el mundo desde el
segundo cero, incluido quien quiera aprovechar lo que encontraste antes de que
alcancemos a arreglarlo.

Usa uno de estos dos canales:

1. **[Reporte privado de vulnerabilidades de GitHub](https://github.com/encontradosco/encontrados/security/advisories/new)** —
   preferido. Queda en un hilo privado con los mantenedores.
2. **Correo a `cris@pappcorn.com`** si prefieres no usar GitHub o no tienes
   cuenta.

Incluye lo que puedas: qué encontraste, cómo reproducirlo, y qué se puede hacer
con eso. Un reporte corto y claro vale más que uno exhaustivo que llega tarde.

**Si el hallazgo expone datos de una persona real, descríbelo sin adjuntarlos.**
Dinos dónde mirar; no nos mandes la evidencia con los datos adentro.

## Qué esperar

- **Acuse de recibo en 48 horas.** Si no llega, insiste — el proyecto se mueve
  rápido y algo se nos pasó.
- Te contamos qué encontramos al validarlo y cuándo pensamos arreglarlo.
- Te acreditamos en el arreglo si quieres. Si prefieres quedar anónimo, también.

No tenemos programa de recompensas. Es un proyecto de emergencia sin fines de
lucro, y preferimos decirlo de frente en vez de dejarlo ambiguo.

## En alcance

Lo que corre en `encontrados.co` y el código de este repositorio. Nos interesa
especialmente:

- Acceso a datos que deberían ser privados: el contacto de quien reporta, fotos
  que no deberían ser públicas, firmas faciales.
- Fallas en el borrado: datos que siguen existiendo después de que se pidió
  eliminarlos, en cualquier capa (base de datos, almacenamiento, índice facial).
- Escritura no autorizada en la API o en los formularios.
- Cualquier camino que permita hacerse pasar por un rescatista verificado o por
  quien reporta.

## Fuera de alcance

- Ataques de denegación de servicio por volumen.
- Ingeniería social a las personas del proyecto.
- Hallazgos automáticos de un escáner sin un impacto demostrado.
- La infraestructura de terceros que usamos (Vercel, Neon, AWS, SendGrid) —
  repórtalos a ellos.

## Nota para quien contribuye

Los preview deployments de los pull requests corren con una base de datos
desechable y vacía, sin credenciales de producción. Están hechos para que puedas
probar tu cambio sin tocar nada real.
