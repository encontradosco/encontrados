// El canal privado de mantenedores en Discord: a dónde llegan los avisos al
// equipo (el aviso de un rescatista, los avisos retenidos por el relevo, el
// respaldo de /ideas y /bug) cuando DISCORD_AVISOS_WEBHOOK_URL está puesta.
// Sin esa variable todo sigue yendo por correo a AVISO_EMAIL, como antes: así
// el orden del despliegue no importa.
//
// Por qué un webhook y no un bot: un webhook solo puede escribir en SU canal y
// borrar SUS mensajes. No lee nada, no ve a nadie y no se puede usar para otra
// cosa. Es la credencial más chica que hace el trabajo — y la retención
// (borrar a los N días) se hace con esa misma credencial, sin un bot que
// mantener vivo.
//
// La URL del webhook ES la credencial (lleva el token adentro). Nunca se
// escribe en un log: los mensajes de abajo dicen "webhook de Discord", jamás
// la URL.

// Lo que se guarda en el canal es dato de personas (el teléfono de quien avisa
// y dónde dice que está la persona buscada). Por eso tiene fecha de
// vencimiento: a los 30 días el mensaje se borra (ver purgeExpiredAvisos).
const RETENTION_DAYS = 30;

// Discord corta en 2000 caracteres por mensaje. Se parte un poco antes para
// dejar margen a la marca de "parte i/n".
const MAX_CHUNK = 1900;

// Un 429 de Discord trae `retry_after` en segundos. Se espera una vez, y solo
// si la espera es corta: esto corre dentro de una función serverless con
// tiempo limitado, y un aviso que falla queda registrado igual.
const MAX_RETRY_WAIT_MS = 5000;

// SUPPRESS_EMBEDS: que Discord no despliegue vistas previas de los enlaces a
// fichas. Cada vista previa es una petición de Discord al sitio y una tarjeta
// más con el nombre de la persona en el canal.
const FLAG_SUPPRESS_EMBEDS = 1 << 2;

// Código de error de Discord cuando el MENSAJE ya no existe (alguien lo borró
// a mano). Distinto de 10015, que es el WEBHOOK el que ya no existe.
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_WEBHOOK = 10015;

// En vivo desde process.env, igual que AVISO_EMAIL: cambiar de destino es una
// variable, no un despliegue, y una prueba puede quitarla.
function discordWebhookUrl() {
  return (process.env.DISCORD_AVISOS_WEBHOOK_URL || '').trim();
}

// El id del webhook es el penúltimo segmento de la ruta
// (/api/webhooks/{id}/{token}). Se guarda con cada mensaje: un webhook solo
// puede borrar los mensajes que él mismo escribió, así que si el webhook se
// cambia, los mensajes del anterior tienen que borrarse a mano — y la purga
// tiene que saber cuáles son.
function webhookIdOf(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const i = parts.indexOf('webhooks');
    return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
  } catch {
    return null;
  }
}

function withPath(url, suffix, params = {}) {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/+$/, '') + suffix;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// Parte el texto por líneas sin pasarse de MAX_CHUNK. Una línea más larga que
// eso (no debería existir, pero el texto viene de afuera) se corta a la fuerza.
function splitForDiscord(text) {
  const chunks = [];
  let current = '';
  for (const raw of String(text).split('\n')) {
    let line = raw;
    while (line.length > MAX_CHUNK) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(line.slice(0, MAX_CHUNK));
      line = line.slice(MAX_CHUNK);
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > MAX_CHUNK) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retryWaitMs(res) {
  try {
    const body = await res.clone().json();
    const ms = Math.ceil(Number(body.retry_after) * 1000);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  } catch {
    return null;
  }
}

// Una petición con un solo reintento ante 429. Nunca lanza.
async function discordFetch(url, init) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      return { ok: false, status: 0, error: e?.message || String(e) };
    }
    if (res.status === 429 && attempt === 0) {
      const wait = await retryWaitMs(res);
      if (wait !== null && wait <= MAX_RETRY_WAIT_MS) {
        await sleep(wait);
        continue;
      }
    }
    return { ok: res.ok, status: res.status, res };
  }
  return { ok: false, status: 429, error: 'rate limit' };
}

// Guarda el id del mensaje para poder borrarlo a los RETENTION_DAYS. Si no se
// puede guardar, el mensaje queda en el canal sin fecha de borrado: el log lo
// dice con su id (que no es un dato de nadie) para que alguien lo borre a mano.
async function remember(store, messageId, webhookId) {
  try {
    if (!store || typeof store.insertDiscordAviso !== 'function') throw new Error('sin store');
    await store.insertDiscordAviso({ messageId, webhookId });
  } catch (e) {
    console.error(
      `[discord:avisos] el mensaje ${messageId} se publicó pero NO quedó registrado para su borrado a los ` +
        `${RETENTION_DAYS} días (${e?.message || e}). Hay que borrarlo a mano.`
    );
  }
}

// Publica un aviso al canal. Devuelve { ok, status, error, messageIds } con la
// misma forma que sendEmail, para que el llamador y la bitácora no tengan que
// saber por dónde salió. Nunca lanza.
async function postAviso(store, { subject, body }) {
  const url = discordWebhookUrl();
  if (!url) return { ok: false, error: 'DISCORD_AVISOS_WEBHOOK_URL no configurada' };
  const webhookId = webhookIdOf(url);
  if (!webhookId) return { ok: false, error: 'DISCORD_AVISOS_WEBHOOK_URL no tiene forma de webhook de Discord' };

  const chunks = splitForDiscord(`**${subject}**\n${body}`);
  const messageIds = [];
  for (let i = 0; i < chunks.length; i++) {
    const content = chunks.length > 1 ? `${chunks[i]}\n_(parte ${i + 1}/${chunks.length})_` : chunks[i];
    // wait=true: sin esto Discord responde 204 sin cuerpo y no hay id que
    // guardar — el mensaje quedaría en el canal para siempre.
    const r = await discordFetch(withPath(url, '', { wait: 'true' }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        // Nada de lo que escribe alguien de afuera puede mencionar a nadie:
        // un "@everyone" en el campo de ubicación no notifica a nadie.
        allowed_mentions: { parse: [] },
        flags: FLAG_SUPPRESS_EMBEDS
      })
    });
    if (!r.ok) {
      const detail = r.res ? (await r.res.text().catch(() => '')).slice(0, 300) : r.error;
      console.error(
        `[discord:avisos] FALLÓ ${r.status} al publicar la parte ${i + 1}/${chunks.length} en el webhook de Discord: ${detail}`
      );
      return { ok: false, status: r.status, error: detail || `HTTP ${r.status}`, messageIds };
    }
    let message = null;
    try {
      message = await r.res.json();
    } catch {
      /* sin cuerpo: se reporta abajo */
    }
    if (message && message.id) {
      messageIds.push(String(message.id));
      await remember(store, String(message.id), webhookId);
    } else {
      console.error('[discord:avisos] Discord aceptó el mensaje pero no devolvió su id: no se podrá borrar solo.');
    }
  }
  console.log(`[discord:avisos] publicado en el canal privado (${chunks.length} mensaje(s))`);
  return { ok: true, status: 200, messageIds };
}

// Borra del canal los avisos con más de RETENTION_DAYS días. La dispara el
// cron de Vercel una vez al día. Solo toca mensajes del webhook ACTUAL — los de
// un webhook anterior no los puede borrar, y se cuentan aparte para que alguien
// los borre a mano.
async function purgeExpiredAvisos(store, { now = new Date(), limit = 100 } = {}) {
  const url = discordWebhookUrl();
  if (!url) return { ok: true, skipped: 'DISCORD_AVISOS_WEBHOOK_URL no configurada', deleted: 0 };
  const webhookId = webhookIdOf(url);
  if (!webhookId) return { ok: false, error: 'DISCORD_AVISOS_WEBHOOK_URL no tiene forma de webhook de Discord' };

  const before = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = await store.listExpiredDiscordAvisos({ webhookId, before, limit });
  const orphans = await store.countExpiredDiscordAvisosOfOtherWebhooks({ webhookId, before });

  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;
  let stoppedBy = null;
  for (const row of rows) {
    const r = await discordFetch(withPath(url, `/messages/${encodeURIComponent(row.message_id)}`), {
      method: 'DELETE'
    });
    if (r.ok) {
      deleted++;
      await store.deleteDiscordAviso(row.message_id);
      continue;
    }
    let code = null;
    if (r.res) {
      try {
        code = (await r.res.json()).code;
      } catch {
        /* sin cuerpo */
      }
    }
    if (r.status === 404 && code === UNKNOWN_MESSAGE) {
      // Ya lo borró alguien a mano: la promesa se cumplió igual.
      alreadyGone++;
      await store.deleteDiscordAviso(row.message_id);
      continue;
    }
    if (r.status === 404 && code === UNKNOWN_WEBHOOK) {
      // El webhook ya no existe: ningún borrado más va a funcionar. Se
      // detiene sin soltar las filas — siguen siendo mensajes por borrar.
      stoppedBy = 'el webhook ya no existe';
      break;
    }
    if (r.status === 429) {
      stoppedBy = 'rate limit de Discord';
      break;
    }
    failed++;
    console.error(`[discord:avisos] no se pudo borrar el mensaje ${row.message_id} (HTTP ${r.status}); se reintenta mañana.`);
  }

  const result = {
    ok: !stoppedBy && failed === 0,
    retentionDays: RETENTION_DAYS,
    candidates: rows.length,
    deleted,
    alreadyGone,
    failed,
    orphans,
    ...(stoppedBy ? { stoppedBy } : {})
  };
  if (orphans > 0) {
    console.error(
      `[discord:avisos] ${orphans} aviso(s) vencido(s) los escribió un webhook anterior: este no los puede borrar. Hay que borrarlos a mano.`
    );
  }
  console.log(`[discord:avisos] purga: ${JSON.stringify(result)}`);
  return result;
}

module.exports = {
  RETENTION_DAYS,
  discordWebhookUrl,
  webhookIdOf,
  splitForDiscord,
  postAviso,
  purgeExpiredAvisos
};
