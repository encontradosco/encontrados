// La bitácora de coincidencias y de envíos (#116, PR 4 — la instrumentación;
// PR 3 creó las dos tablas). Instrumenta, no gobierna: cada match en pantalla
// y cada intento de aviso ya iban a pasar de todos modos — esto solo deja
// rastro de que pasaron.
//
// Regla de oro: un fallo escribiendo la bitácora NUNCA rompe ni retrasa el
// flujo principal. Un rescatista parado al lado de una persona, o un envío
// real, mandan sobre nuestra observabilidad — siempre. Por eso cada función
// atrapa su propio error, lo manda a console.error (para que sí quede en los
// logs de Vercel) y sigue como si nada.

async function logMatch(store, { personId, updateId, faceId, similarity, surface }) {
  try {
    await store.insertMatchLog({
      personId,
      updateId: updateId ?? null,
      faceId,
      similarity: similarity == null ? null : similarity,
      surface
    });
  } catch (e) {
    console.error(
      `[logbook:match] no se pudo registrar la coincidencia (persona ${personId}, superficie ${surface}) — el match sigue en pie:`,
      e.message
    );
  }
}

async function logContact(store, { personId, updateId, channel, result }) {
  try {
    await store.insertContactLog({ personId, updateId: updateId ?? null, channel, result });
  } catch (e) {
    console.error(
      `[logbook:contact] no se pudo registrar el envío (persona ${personId}, canal ${channel}, resultado ${result}) — el envío sigue en pie:`,
      e.message
    );
  }
}

// #150: cada vez que findOrCreatePerson evalúa fusionar un reporte nuevo con
// una persona existente por nombre (score >= 0.85), quede o no quede
// fusionado. `personId` es el CANDIDATO evaluado, no necesariamente quien
// terminó dueño del update — ver el comentario del esquema en
// src/store/sqlite.js.
async function logMerge(store, { personId, updateId, score, departmentMatch, faceMatch, blocked }) {
  try {
    await store.insertMergeLog({
      personId,
      updateId: updateId ?? null,
      score,
      departmentMatch,
      faceMatch,
      blocked: !!blocked
    });
  } catch (e) {
    console.error(
      `[logbook:merge] no se pudo registrar la fusión evaluada (persona ${personId}, score ${score}) — la decisión sigue en pie:`,
      e.message
    );
  }
}

// Traduce el { ok, ... } que ya devuelven sendEmail/sendWhatsApp/relayToOperators
// a un resultado del enum de contact_log. Cualquier envío que sí se intentó
// (llegó a llamar al proveedor, o al relevo) es 'enviado' o 'fallido' — nunca
// 'rechazado'. 'rechazado' es un valor aparte para cuando la app decide, por
// su cuenta, no intentar nada (ver notifyFaceMatch: una suscripción sin
// verificar en modo directo).
function resultFromSend(res) {
  return res && res.ok ? 'enviado' : 'fallido';
}

module.exports = { logMatch, logContact, logMerge, resultFromSend };
