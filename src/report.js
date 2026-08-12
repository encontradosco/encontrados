// Reporte operativo recurrente por correo (#116, PR 2) — el segundo de los
// PRs chicos de la secuencia aprobada, y el que llega ANTES que el panel.
//
// Tres veces al día (7:00 / 13:00 / 19:00 Bogotá) recomputa el cruce de
// coincidencias (computeMatchStats, #117) más los conteos generales de la
// base, arma el HTML EXACTO que aprobó @ni500 en el issue
// (https://github.com/encontradosco/encontrados/issues/116#issuecomment-5271536079)
// y lo manda por SendGrid a los buzones que diga REPORT_RECIPIENTS.
//
// Solo cifras agregadas — cero nombres, cero contactos, cero ids de persona o
// de foto. Es la misma garantía de privacidad que ya protege /api/match-stats;
// este módulo no la relaja, la hereda.
const env = require('./env');
const { esc } = require('./html');
const { sendEmail } = require('./notify');
const { computeMatchStats } = require('./facematch');

const BOGOTA_TZ = 'America/Bogota';

const numberFmt = new Intl.NumberFormat('es-CO');
function n(v) {
  return numberFmt.format(v);
}

// "12 ago, 13:00" — hora de Bogotá, sin depender del huso del runtime (una
// función serverless corre en UTC).
function bogotaClock(date) {
  const parts = new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TZ,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return { day: get('day'), month: get('month'), hm: `${get('hour')}:${get('minute')}` };
}

function persona(count) {
  return count === 1 ? 'persona' : 'personas';
}

function subject(generatedAt, stats) {
  const { day, month, hm } = bogotaClock(generatedAt);
  const clave = stats
    ? `${n(stats.reported_people_matched)} ${persona(stats.reported_people_matched)} con coincidencia`
    : 'reconocimiento facial no disponible';
  return `[encontrados] Reporte operativo — ${day} ${month}, ${hm} · ${clave}`;
}

const TABLE_STYLE = 'border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;';
const TH_STYLE = 'text-align:left;padding:6px 10px;border:1px solid #ddd;background:#f4f4f4;';
const TD_STYLE = 'padding:6px 10px;border:1px solid #ddd;vertical-align:top;';

function table(headers, rows) {
  const head = headers.map((h) => `<th style="${TH_STYLE}">${esc(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td style="${TD_STYLE}">${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table style="${TABLE_STYLE}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function section(title) {
  return `<h2 style="font-size:16px;margin:20px 0 4px;">${esc(title)}</h2>`;
}

// El HTML exacto que aprobó @ni500 el 12-ago-2026, con las cifras vivas de
// esta corrida. `stats` puede venir null (reconocimiento facial apagado) —
// las tablas 1 y 2 (que dependen de él) se sustituyen por un aviso; la tabla
// 4 (la base general) no depende de Rekognition y sigue viva siempre.
function buildReportHtml(generatedAt, counts, stats, matcherStatus) {
  const howNote = `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #999;color:#333;background:#fafafa;">
<strong>¿Cómo se calcula esto?</strong> <em>(método provisional)</em> Cada vez que sale este reporte, la app vuelve a comparar las fotos que ha subido quien busca a alguien
—un rescatista que reporta haber encontrado a una persona, o quien se suscribe adjuntando una foto— contra las fotos de los reportes de personas desaparecidas.
Es una foto del estado <strong>de hoy</strong>: si una foto se borró, su coincidencia deja de contar. Desde el PR #117 este conteo ya se puede llevar de forma
recurrente; cuando entre la bitácora (PRs 3–4), el reporte pasará a contar cada coincidencia <strong>en el momento en que ocurre</strong> — incluyendo las que un
rescatista ve en pantalla, que hoy son invisibles.</blockquote>`;

  let reliabilityAndFunnel;
  if (!stats) {
    reliabilityAndFunnel = `<p style="padding:10px 12px;background:#fff3cd;border:1px solid #ffe08a;border-radius:4px;">
⚠️ El reconocimiento facial no está disponible en esta corrida (${esc(matcherStatus || 'desconocido')}). Las coincidencias no se pudieron recalcular —
esto <strong>no significa que sean cero</strong>, significa que no se pudieron medir. La base general de abajo sigue siendo real.</p>`;
  } else {
    const notFoundYet = Math.max(stats.reported_people_indexed - stats.reported_people_matched, 0);
    reliabilityAndFunnel =
      section('1 · ¿Podemos confiar en los números de abajo?') +
      table(
        ['Señal', 'Cuántos', 'Qué significa'],
        [
          [
            'Comparaciones que fallaron',
            n(stats.failed),
            'Estas personas no se pudieron comparar en esta corrida. Los números de abajo son el <strong>mínimo real</strong> — pueden ser más.'
          ],
          [
            'Fotos huérfanas en el índice',
            n(stats.dangling_face_matches),
            'Caras de personas ya borradas de la base que siguen en el índice facial. Hay que limpiarlas (#71).'
          ]
        ]
      ) +
      section('2 · Coincidencias (el embudo, acumulado)') +
      table(
        ['Paso', 'Cuántas', 'Qué significa'],
        [
          [
            'Personas buscadas con foto utilizable',
            n(stats.reported_people_indexed),
            'Tienen una foto donde se detectó bien la cara — solo estas pueden coincidir.'
          ],
          [
            '→ De esas, con al menos una coincidencia',
            n(stats.reported_people_matched),
            `A ${n(stats.reported_people_matched)} ${persona(stats.reported_people_matched)} las "vio" la app en alguna foto subida por quien busca. Las otras ${n(notFoundYet)} no han aparecido en ninguna foto — todavía.`
          ],
          [
            '→ Coincidencias en total',
            n(stats.report_matches_total),
            `Una misma persona puede aparecer en varias fotos: las ${n(stats.reported_people_matched)} ${persona(stats.reported_people_matched)} suman ${n(stats.report_matches_total)} coincidencias entre todas.`
          ]
        ]
      );
  }

  const notYet =
    section('3 · Lo que todavía NO podemos medir (se enciende con los próximos PRs)') +
    table(
      ['Señal', 'Desde cuándo'],
      [
        ['Correos, WhatsApps y relevos enviados (y cuáles fallaron)', 'PR 4'],
        ['Coincidencias vistas en pantalla por un rescatista en el momento', 'PRs 3–4']
      ]
    );

  const base =
    section('4 · La base en general') +
    table(
      ['Qué', 'Total', 'Qué significa'],
      [
        [
          'Personas registradas',
          n(counts.people),
          'Personas únicas en la base. Es menor que las fichas de las fuentes porque una misma persona puede tener varias fichas — al entrar se fusionan.'
        ],
        [
          'Actualizaciones',
          n(counts.updates),
          'Cada ficha de una fuente externa y cada reporte directo en la web entra como una actualización de una persona. Por eso hay más actualizaciones que personas.'
        ],
        [
          'Suscripciones (verificadas)',
          `${n(counts.subscriptions)} (${n(counts.subscriptions_verified)})`,
          'Familiares que pidieron aviso si su persona aparece. Solo las verificadas reciben correo.'
        ],
        [
          'Fotos (en el índice facial)',
          `${n(counts.photos)} (${n(counts.photos_indexed)})`,
          'Fotos en la base; las del índice son las que ya pueden producir coincidencias.'
        ]
      ]
    );

  const deltaLine = `<p style="font-size:13px;color:#555;"><strong>Cambio desde el reporte anterior:</strong> disponible cuando entre la bitácora (PR 3) — recordar el reporte previo requiere persistencia.</p>`;

  const footer = `<p style="font-size:12px;color:#888;font-style:italic;">Generado automáticamente 3×/día · Destinos por variable de entorno · Plan: #116</p>`;

  return `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#111;max-width:640px;">
${howNote}
${reliabilityAndFunnel}
${notYet}
${base}
${deltaLine}
${footer}
</div>`;
}

// Texto plano paralelo, para el cliente que no rinde HTML — mismas cifras,
// sin tablas.
function buildReportText(generatedAt, counts, stats, matcherStatus) {
  const lines = ['Reporte operativo de encontrados.co', ''];
  if (!stats) {
    lines.push(
      `Reconocimiento facial no disponible en esta corrida (${matcherStatus || 'desconocido'}).`,
      'Las coincidencias no se pudieron recalcular — no significa que sean cero.',
      ''
    );
  } else {
    lines.push(
      `Personas buscadas con foto utilizable: ${n(stats.reported_people_indexed)}`,
      `Con al menos una coincidencia: ${n(stats.reported_people_matched)}`,
      `Coincidencias en total: ${n(stats.report_matches_total)}`,
      `Fotos que no se pudieron comparar: ${n(stats.failed)}`,
      `Coincidencias contra firmas huérfanas: ${n(stats.dangling_face_matches)}`,
      ''
    );
  }
  lines.push(
    `Personas registradas: ${n(counts.people)}`,
    `Actualizaciones: ${n(counts.updates)}`,
    `Suscripciones (verificadas): ${n(counts.subscriptions)} (${n(counts.subscriptions_verified)})`,
    `Fotos (en el índice facial): ${n(counts.photos)} (${n(counts.photos_indexed)})`,
    '',
    'Ver el HTML de este correo para el detalle en tablas.',
    'Generado automáticamente 3×/día · Destinos por variable de entorno · Plan: #116'
  );
  return lines.join('\n');
}

// Live, no del snapshot de env.js — para que una prueba pueda fijarlo o
// borrarlo sin reiniciar el proceso, igual que AVISO_EMAIL en notify.js.
function reportRecipients() {
  const raw = process.env.REPORT_RECIPIENTS || env.REPORT_RECIPIENTS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Arma el reporte y lo manda a cada destinatario de REPORT_RECIPIENTS (un
// correo por destinatario — no expone la lista de operadores entre sí).
// Nunca revienta: si no hay destinos configurados, se niega RUIDOSAMENTE
// (log + { ok:false }), nunca en silencio — el mismo principio que ya rige
// sendEmail y relayToOperators en este repo.
async function sendReport(store, matcher) {
  const generatedAt = new Date();
  const recipients = reportRecipients();
  if (!recipients.length) {
    console.error('[report] SKIPPED — REPORT_RECIPIENTS no está configurada. Nadie recibió el reporte operativo.');
    return { ok: false, error: 'REPORT_RECIPIENTS no configurada', sent: 0, failed: 0, recipients: 0 };
  }

  const stats = await computeMatchStats(store, matcher);
  const counts = await store.counts();

  const html = buildReportHtml(generatedAt, counts, stats, matcher.status);
  const text = buildReportText(generatedAt, counts, stats, matcher.status);
  const emailSubject = subject(generatedAt, stats);

  const results = await Promise.allSettled(
    recipients.map((to) => sendEmail(to, emailSubject, text, { html }))
  );
  let sent = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value.ok) sent++;
    else {
      failed++;
      console.error('[report] envío fallido:', r.status === 'fulfilled' ? r.value.error : r.reason);
    }
  }
  console.log(
    `[report] generado ${generatedAt.toISOString()} — ${recipients.length} destino(s), ${sent} enviado(s), ${failed} fallido(s), stats_disponibles=${!!stats}`
  );
  return {
    ok: failed === 0,
    generated_at: generatedAt.toISOString(),
    stats_available: !!stats,
    recipients: recipients.length,
    sent,
    failed
  };
}

module.exports = {
  buildReportHtml,
  buildReportText,
  reportRecipients,
  sendReport
};
