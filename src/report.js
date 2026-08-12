// El reporte de operación por correo (#116, parte 2): tres veces al día, a los
// buzones de los operadores (REPORT_EMAILS), SIEMPRE el acumulado histórico —
// nunca solo el delta — y con los rechazos y fallos como primera métrica.
//
// La razón del orden viene de un incidente real: un canal estuvo horas botando
// todo mientras su health-check juraba `ok: true`, porque sus contadores solo
// contaban lo que pasó el filtro. Un reporte que abre con lo que falló no
// puede verse sano por accidente.
//
// Solo cifras agregadas: ni un nombre, ni un contacto, ni un id de persona
// viaja en este correo. test/report.test.js falla si algo de eso se cuela.
const env = require('./env');
const { sendEmail, notifyMode, avisoEmail, relayEnabled } = require('./notify');
const { computeMatchStats } = require('./facematch');

// Los destinos se leen EN VIVO de process.env (la regla de env.js: lo que
// puede cambiar en caliente no se lee del snapshot).
function reportRecipients() {
  return (process.env.REPORT_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Cuántas direcciones está rechazando SendGrid (rebotes, bloqueos, spam). Es
// la parte de "no llegó" que el 202 de enviar jamás cuenta. La versión
// por-dirección, con diagnóstico, vive en GET /api/diag/sendgrid; esto es solo
// el agregado, y si SendGrid no responde se dice "no disponible" en vez de un
// cero que parezca un dato.
const SUPPRESSION_PAGE = 500;

async function sendgridRejectionCounts() {
  const apiKey = (process.env.SENDGRID_API_KEY || env.SENDGRID_API_KEY || '').trim();
  const apiBase = process.env.SENDGRID_API_BASE || 'https://api.sendgrid.com';
  if (!apiKey) return { bounces: null, blocks: null, spam: null };

  const count = async (path) => {
    try {
      const r = await fetch(`${apiBase}${path}?limit=${SUPPRESSION_PAGE}`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!r.ok) return null;
      const body = await r.json();
      if (!Array.isArray(body)) return null;
      // Una página llena significa "al menos esto": no se pagina, porque esto
      // corre dentro de una función con reloj y el dato accionable es que hay
      // MUCHOS, no exactamente cuántos.
      return body.length === SUPPRESSION_PAGE ? `${SUPPRESSION_PAGE}+` : body.length;
    } catch {
      return null;
    }
  };

  const [bounces, blocks, spam] = await Promise.all([
    count('/v3/suppression/bounces'),
    count('/v3/suppression/blocks'),
    count('/v3/suppression/spam_reports')
  ]);
  return { bounces, blocks, spam };
}

const fmt = (v) => (v === null || v === undefined ? 'no disponible' : String(v));

function buildReportBody({ generatedAt, counts, pendingIndexing, matchStats, matcherStatus, rejections, relay, mailbox }) {
  const lines = [
    'Reporte de operación — encontrados.co',
    `Generado: ${generatedAt} (hora de Bogotá)`,
    'Todas las cifras son el ACUMULADO histórico, no el delta desde el correo anterior.',
    '',
    '== LO QUE FALLA O SE RECHAZA — mirar primero ==',
    '',
    matchStats
      ? `- Búsquedas faciales que fallaron al recomputar el cruce: ${matchStats.failed} de ${matchStats.searched + matchStats.failed} intentadas` +
        (matchStats.failed > 0 ? ' ⚠ (los totales de abajo son un piso, no el techo)' : '')
      : `- Búsquedas faciales: no disponible — el matcher facial no está disponible (${matcherStatus})`,
    `- Fotos guardadas SIN firma facial (el matcher no estaba cuando llegaron): ${pendingIndexing}` +
      (pendingIndexing > 0 ? ' ⚠ (POST /api/reindex las recoge)' : ''),
    `- Direcciones que SendGrid rechaza — rebotes: ${fmt(rejections.bounces)} · bloqueos: ${fmt(rejections.blocks)} · spam: ${fmt(rejections.spam)}`,
    relay
      ? mailbox
        ? '- Avisos a terceros: modo relevo, con buzón de operador configurado.'
        : '- Avisos a terceros: ⚠ MODO RELEVO SIN BUZÓN (AVISO_EMAIL vacío) — los avisos retenidos se están PERDIENDO.'
      : '- Avisos a terceros: modo directo — salen sin humano en el circuito.',
    '',
    '== EL CRUCE FACIAL (acumulado) ==',
    ''
  ];

  if (matchStats) {
    lines.push(
      `- Fotos de consulta que hoy coinciden con al menos un reporte: ${matchStats.query_photos_with_report_match}`,
      `- Personas reportadas alcanzadas por esas coincidencias: ${matchStats.reported_people_matched}`,
      `- Personas del lado que consulta: ${matchStats.query_people_matched}`,
      `- La misma cara consultada más de una vez: ${matchStats.query_photos_with_query_match}`,
      `- Firmas indexadas: ${matchStats.indexed.query} de consulta · ${matchStats.indexed.report} de reporte`,
      `- Coincidencias contra firmas colgadas (persona borrada, #71): ${matchStats.dangling_face_matches}`
    );
  } else {
    lines.push(
      `- El matcher facial no está disponible (${matcherStatus}): esta sección no se pudo recomputar.`,
      '  Eso también es un dato: mientras siga así, no hay coincidencias nuevas.'
    );
  }

  lines.push(
    '',
    '== EL REGISTRO (acumulado) ==',
    '',
    `- Personas: ${counts.people}`,
    `- Actualizaciones: ${counts.updates}`,
    `- Suscripciones: ${counts.subscriptions} (verificadas: ${counts.subscriptions_verified})`,
    `- Fotos: ${counts.photos} (indexadas: ${counts.photos_indexed} · de reporte: ${counts.photos_report} · de consulta: ${counts.photos_query})`,
    '',
    'Detalle por dirección de correo: GET /api/diag/sendgrid?email=…',
    'Configuración y autodiagnóstico: GET /api/diag'
  );

  return lines.join('\n');
}

async function composeReport(store, matcher) {
  const [counts, pending, rejections] = await Promise.all([
    store.counts(),
    store.photosMissingFaceId(500),
    sendgridRejectionCounts()
  ]);
  // Recomputa el cruce contra Rekognition (decenas de búsquedas, ver
  // computeMatchStats). Devuelve null con el matcher apagado — y el reporte
  // sale igual, declarándolo: un correo que no llega porque el matcher está
  // caído esconde justo la noticia que había que dar.
  const matchStats = await computeMatchStats(store, matcher);

  const generatedAt = new Date().toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  return {
    subject: `Reporte de operación encontrados.co — ${generatedAt} (acumulado)`,
    text: buildReportBody({
      generatedAt,
      counts,
      pendingIndexing: pending.length,
      matchStats,
      matcherStatus: matcher.status,
      rejections,
      relay: relayEnabled(),
      mailbox: Boolean(avisoEmail())
    })
  };
}

// Manda el reporte a cada buzón de REPORT_EMAILS. Va derecho por sendEmail —
// sin pasar por el relevo — porque sus destinatarios SON los operadores: no
// hay tercero a quien proteger. Sin destinos configurados no se manda nada y
// queda dicho en el log; los buzones no se inventan.
async function sendOperationalReport(store, matcher) {
  const recipients = reportRecipients();
  if (!recipients.length) {
    console.warn('[report] SKIPPED — REPORT_EMAILS sin configurar: el reporte no tiene a quién salir.');
    return { ok: false, sent: 0, failed: 0, skipped: 'REPORT_EMAILS sin configurar' };
  }

  const { subject, text } = await composeReport(store, matcher);
  let sent = 0;
  let failed = 0;
  for (const address of recipients) {
    const r = await sendEmail(address, subject, text);
    if (r.ok) sent++;
    else failed++;
  }
  if (failed > 0) {
    console.error(`[report] ${failed} de ${recipients.length} envíos fallaron (modo=${notifyMode()}).`);
  }
  return { ok: failed === 0, sent, failed };
}

module.exports = { sendOperationalReport, composeReport, buildReportBody };
