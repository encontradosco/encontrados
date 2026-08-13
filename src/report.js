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

// Los tres horarios fijos del cron (#116, PR 4 — hora de Bogotá: 7, 13, 19).
// No existe una tabla de "cuándo salió el reporte anterior" — nunca se
// diseñó una, y no hace falta: con un cron de horario FIJO, la mejor
// aproximación honesta a "desde el reporte anterior" es la hora programada
// inmediatamente antes de esta corrida. Funciona bien mientras el cron corra
// puntual; si una corrida se salta (un despliegue caído, por ejemplo), el
// siguiente reporte simplemente suma un poco más en su ventana — no hay doble
// conteo ni hueco, solo una ventana más ancha esa vez. Colombia no tiene
// horario de verano, así que UTC-5 es un offset fijo, sin ambigüedad.
const SCHEDULE_HOURS_BOGOTA = [7, 13, 19];
const BOGOTA_OFFSET_MS = 5 * 3600 * 1000;

// Umbral de aviso para el recompute del embudo (hotfix post-#127). Medido en
// prod: 28,7s con ~110 fotos contra un maxDuration de 30s — 1,3s de margen.
// Con maxDuration en 120s (ver vercel.json), 60s de umbral avisa cuando el
// margen bajó a la mitad, mucho antes de que vuelva a rozar el límite real.
const FUNNEL_DURATION_WARN_MS = 60 * 1000;

function previousScheduledBogota(generatedAt) {
  const bogotaMs = generatedAt.getTime() - BOGOTA_OFFSET_MS;
  const bogota = new Date(bogotaMs);
  const y = bogota.getUTCFullYear();
  const m = bogota.getUTCMonth();
  const d = bogota.getUTCDate();

  // Los horarios de "ayer" y "hoy" (en la hora de Bogotá) bastan: la brecha
  // más ancha entre dos horarios programados es de 12 h, muy por debajo de la
  // ventana de dos días que arma este barrido.
  const slots = [];
  for (const dayOffset of [-1, 0]) {
    for (const hour of SCHEDULE_HOURS_BOGOTA) {
      slots.push(Date.UTC(y, m, d + dayOffset, hour, 0, 0));
    }
  }
  const past = slots.filter((t) => t <= bogotaMs).sort((a, b) => a - b);
  // past[length-1] es el horario nominal de ESTA corrida; el anterior es el
  // que se busca acá.
  const previousBogotaMs = past[past.length - 2];
  return new Date(previousBogotaMs + BOGOTA_OFFSET_MS);
}

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

// 'YYYY-MM-DD' del DÍA DE BOGOTÁ que contiene este instante — el mismo corte
// que usan matchLogDaily/contactLogDaily en los dos adapters (hotfix: antes
// se armaba con `toISOString().slice(0, 10)`, que es el día en UTC, y entre
// las 19:00 y la medianoche Bogotá eso es el día SIGUIENTE — el bucket de
// gatherDailySeries quedaba desalineado del bucket real de la bitácora).
// formatToParts (no to_char ni parseo de string) para no depender de que la
// build de ICU del runtime formatee 'en-CA' con guiones en el orden esperado.
function bogotaDayKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOGOTA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
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

const SURFACE_LABEL = { rescate: 'Rescate (/rescate)', report: 'Reporte nuevo', api: 'Suscripción con foto (API)' };
const CHANNEL_LABEL = { email: 'Correo', whatsapp: 'WhatsApp', relevo: 'Relevo al operador' };

// Pivotea las filas planas de contactLogCounts ({channel, result, count}) a
// un objeto por canal — más fácil de tabular. Canales/resultados que no
// aparecieron quedan en 0, nunca ausentes: una fila con "0" dice "sí se
// contó, no hubo ninguno"; una fila ausente sería indistinguible de un bug.
function pivotContact(rows) {
  const byChannel = {
    email: { enviado: 0, fallido: 0, rechazado: 0 },
    whatsapp: { enviado: 0, fallido: 0, rechazado: 0 },
    relevo: { enviado: 0, fallido: 0, rechazado: 0 }
  };
  for (const r of rows || []) {
    if (byChannel[r.channel] && r.result in byChannel[r.channel]) {
      byChannel[r.channel][r.result] = Number(r.count);
    }
  }
  return byChannel;
}

function sumContact(pivot) {
  let total = 0;
  let enviados = 0;
  for (const ch of Object.values(pivot)) {
    for (const [result, count] of Object.entries(ch)) {
      total += count;
      if (result === 'enviado') enviados += count;
    }
  }
  return { total, enviados };
}

// "Medido desde…" (hotfix post-#127/#128): la frase que hace explícito que
// "acumulado" no es "toda la historia" — sin esto, un total sin fecha se lee
// como si la app llevara midiendo desde siempre. Reusada por el correo
// (acá) y por el panel (src/adminStats.js) — mismo texto, misma fuente.
function instrumentedSinceNote(instrumentedSince) {
  if (!instrumentedSince || (!instrumentedSince.match && !instrumentedSince.contact)) {
    return '<p style="font-size:13px;color:#555;margin:0 0 8px;">Sin registros todavía en la bitácora.</p>';
  }
  const fmt = (d) => {
    if (!d) return 'sin registros todavía';
    const { day, month, hm } = bogotaClock(d);
    return `${day} ${month}, ${hm} Bogotá`;
  };
  return `<p style="font-size:13px;color:#555;margin:0 0 8px;">Medido desde: coincidencias desde ${esc(fmt(instrumentedSince.match))} · envíos desde ${esc(fmt(instrumentedSince.contact))}. Antes de esa fecha no es que no pasara nada — es que todavía no se medía.</p>`;
}

// El HTML del formato aprobado por @ni500 el 12-ago-2026, con las cifras
// vivas de esta corrida. `stats` puede venir null (reconocimiento facial
// apagado) — las tablas 1 y 2 (que dependen de él) se sustituyen por un
// aviso; el resto (bitácora, base general) no depende de Rekognition y sigue
// vivo siempre. `activity` es la bitácora de match_log/contact_log (#116,
// PR 4): { match, contact, since: { at, match, contact } } — match y contact
// acumulados desde siempre; since.match/since.contact desde el horario
// programado anterior (ver previousScheduledBogota).
function buildReportHtml(generatedAt, counts, stats, matcherStatus, activity, funnelDurationMs) {
  const howNote = `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #999;color:#333;background:#fafafa;">
<strong>¿Cómo se calcula esto?</strong> Las tablas 1 y 2 son un <em>recálculo</em> (método provisional): cada vez que sale este reporte, la app vuelve a comparar
las fotos que ha subido quien busca a alguien —un rescatista que reporta haber encontrado a una persona, o quien se suscribe adjuntando una foto— contra las
fotos de los reportes de personas desaparecidas. Es una foto del estado <strong>de hoy</strong>: si una foto se borró, su coincidencia deja de contar.
La tabla 3, en cambio, ya es <strong>bitácora real</strong> (#116, PR 3–4): cada coincidencia y cada intento de aviso quedan registrados
<strong>en el momento en que ocurren</strong> — incluyendo las que un rescatista ve en pantalla, que antes eran invisibles y no dejaban rastro en ninguna parte.</blockquote>`;

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
            'Fotos que no se pudieron comparar',
            n(stats.failed),
            'Son fotos subidas por <strong>quien busca</strong> a alguien —un rescatista, o quien se suscribe con una foto— no de las personas buscadas. Falló la consulta al reconocimiento facial para esa foto puntual; si tenía alguna coincidencia, no quedó contada. Por eso los números de abajo son el <strong>mínimo real</strong> — pueden ser más.'
          ],
          [
            'Coincidencias contra firmas huérfanas',
            n(stats.dangling_face_matches),
            'Golpes contra la firma facial de una persona ya borrada de la base, que sigue en el índice (#71). Si una misma firma huérfana golpea más de una vez, cuenta cada vez — puede haber menos firmas distintas por limpiar que este número.'
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

  const matchPivot = activity.match || { total: 0, rescate: 0, report: 0, api: 0 };
  const contactPivot = pivotContact(activity.contact);

  const matchTable = table(
    ['Superficie', 'Coincidencias registradas'],
    [
      ...['rescate', 'report', 'api'].map((s) => [SURFACE_LABEL[s], n(matchPivot[s] || 0)]),
      ['<strong>Total</strong>', `<strong>${n(matchPivot.total || 0)}</strong>`]
    ]
  );

  const contactTable = table(
    ['Canal', 'Enviados', 'Fallidos', 'Rechazados'],
    ['email', 'whatsapp', 'relevo'].map((ch) => [
      CHANNEL_LABEL[ch],
      n(contactPivot[ch].enviado),
      n(contactPivot[ch].fallido),
      n(contactPivot[ch].rechazado)
    ])
  );

  const bitacoraSection =
    section('3 · Envíos y coincidencias registradas en el momento (acumulado, desde que existe la bitácora)') +
    instrumentedSinceNote(activity.instrumentedSince) +
    '<p style="font-size:13px;color:#555;margin:0 0 4px;">Coincidencias — cada vez que el matcher encuentra a alguien, en el momento en que pasa (ya no es el recálculo del embudo de arriba):</p>' +
    matchTable +
    `<p style="font-size:13px;color:#555;margin:12px 0 4px;">Envíos intentados, por canal — <strong>los fallos y rechazos importan más que los enviados</strong>: un canal que solo cuenta lo que salió bien siempre se ve sano. "${esc(CHANNEL_LABEL.relevo)}" es todo lo que fue al buzón del <strong>equipo</strong>, nunca a una familia ni a un rescatista: coincidencias pendientes de revisión (modo relevo), solicitudes de publicar en Colombia Te Busca, y avisos de rescatista.</p>` +
    contactTable;

  const notYet =
    section('4 · Lo que todavía NO podemos medir') +
    table(
      ['Señal', 'Por qué sigue afuera'],
      [
        [
          'Respaldo de /ideas y /bug cuando GitHub falla (correo directo al equipo)',
          'No tiene ninguna persona asociada — es un formulario de feedback general, no un reporte sobre alguien — y la bitácora de envíos exige por diseño una persona vinculada a cada fila (hereda la misma retención ligada a la persona que el resto del esquema). Contarlo sin forzar esa columna es un cambio de esquema; queda afuera hasta que el equipo decida cómo modelarlo.'
        ],
        [
          'Respuestas del bot conversacional de WhatsApp',
          'Son diálogo (confirmaciones, ayuda), no avisos sobre una coincidencia o una actualización — categoría distinta a la que cubre contact_log hoy.'
        ],
        [
          'Envíos manuales del operador (por fuera de la app)',
          'Los avisos que el equipo manda a mano desde su propio correo/WhatsApp — por ejemplo, 48 personas contactadas así en dos días — no pasan por ningún endpoint de encontrados.co, así que no hay dónde registrarlos hoy. Necesitarían un endpoint propio; fuera de alcance de esta pasada.'
        ]
      ]
    );

  const base =
    section('5 · La base en general') +
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

  const since = activity.since;
  let deltaLine;
  if (since) {
    const sinceMatch = since.match || { total: 0 };
    const sinceContact = sumContact(pivotContact(since.contact));
    const { day, month, hm } = bogotaClock(since.at);
    deltaLine = `<p style="font-size:13px;color:#555;"><strong>Cambio desde el reporte anterior</strong> (aprox. desde ${esc(day)} ${esc(month)}, ${esc(hm)} hora Bogotá — el horario programado anterior; ver la nota al pie sobre cómo se calcula):
${n(sinceMatch.total)} coincidencia(s) nueva(s) registrada(s), ${n(sinceContact.total)} envío(s) intentado(s) (${n(sinceContact.enviados)} entregado(s)).</p>`;
  } else {
    deltaLine = `<p style="font-size:13px;color:#555;"><strong>Cambio desde el reporte anterior:</strong> no disponible en esta corrida.</p>`;
  }

  // Duración del recompute (hotfix post-#127): la señal más barata de que el
  // margen se está achicando. Un lector que ve esta cifra crecer corrida a
  // corrida sabe que hay que revisar maxDuration ANTES de que llegue a
  // fallar — no después.
  const durationNote =
    typeof funnelDurationMs === 'number'
      ? ` · Recompute del embudo: ${(funnelDurationMs / 1000).toFixed(1)}s`
      : '';

  const footer = `<p style="font-size:12px;color:#888;font-style:italic;">Generado automáticamente 3×/día · Destinos por variable de entorno · Plan: #116${durationNote} · El "reporte anterior" de la línea de arriba es el horario programado, no un registro de envíos reales — si una corrida se saltó, la siguiente ventana es más ancha, no hay hueco ni doble conteo.</p>`;

  return `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#111;max-width:640px;">
${howNote}
${reliabilityAndFunnel}
${bitacoraSection}
${notYet}
${base}
${deltaLine}
${footer}
</div>`;
}

// Texto plano paralelo, para el cliente que no rinde HTML — mismas cifras,
// sin tablas.
function buildReportText(generatedAt, counts, stats, matcherStatus, activity, funnelDurationMs) {
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
      `Fotos que no se pudieron comparar (de quien busca, no de las personas buscadas): ${n(stats.failed)}`,
      `Coincidencias contra firmas huérfanas (golpes, no firmas distintas): ${n(stats.dangling_face_matches)}`,
      ''
    );
  }

  const matchPivot = activity.match || { total: 0, rescate: 0, report: 0, api: 0 };
  const contactPivot = pivotContact(activity.contact);
  const contactTotals = sumContact(contactPivot);
  const fmtSince = (d) => (d ? `${bogotaClock(d).day} ${bogotaClock(d).month}, ${bogotaClock(d).hm} Bogotá` : 'sin registros todavía');
  lines.push(
    'Bitácora (acumulado, en el momento en que ocurre):',
    `  Medido desde: coincidencias desde ${fmtSince(activity.instrumentedSince && activity.instrumentedSince.match)} · envíos desde ${fmtSince(activity.instrumentedSince && activity.instrumentedSince.contact)}`,
    `  Coincidencias registradas: ${n(matchPivot.total)} (rescate ${n(matchPivot.rescate)}, reporte ${n(matchPivot.report)}, API ${n(matchPivot.api)})`,
    `  Envíos intentados: ${n(contactTotals.total)} (${n(contactTotals.enviados)} entregados)`,
    ''
  );

  if (activity.since) {
    const sinceMatch = activity.since.match || { total: 0 };
    const sinceContact = sumContact(pivotContact(activity.since.contact));
    const { day, month, hm } = bogotaClock(activity.since.at);
    lines.push(
      `Cambio desde el reporte anterior (aprox. desde ${day} ${month}, ${hm} Bogotá): ` +
        `${n(sinceMatch.total)} coincidencia(s) nueva(s), ${n(sinceContact.total)} envío(s) intentado(s) (${n(sinceContact.enviados)} entregado(s)).`,
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
    'Generado automáticamente 3×/día · Destinos por variable de entorno · Plan: #116' +
      (typeof funnelDurationMs === 'number' ? ` · Recompute del embudo: ${(funnelDurationMs / 1000).toFixed(1)}s` : '')
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

// Las cifras BARATAS (#116, hotfix post-PR6): bitácora + conteos generales.
// Nunca toca Rekognition — solo consultas a la base, todas con índice. Esto
// es lo que /admin/stats renderiza en el camino síncrono del request: medido
// en prod, GET /api/match-stats (el recompute de abajo) tarda 28,7s con
// ~110 fotos, y el panel lo estaba llamando adentro del request de la
// página — eso fue el 504. Esta función es la mitad que SÍ puede vivir ahí.
async function gatherCheapReportData(store, matcher, { at = new Date() } = {}) {
  const generatedAt = at;
  const counts = await store.counts();

  // Bitácora (#116, PR 4): acumulado de siempre + la ventana desde el
  // horario programado anterior. Independiente del matcher — existe aunque
  // Rekognition esté apagado ahora mismo, porque son hechos ya ocurridos.
  const sinceAt = previousScheduledBogota(generatedAt);
  const sinceIso = sinceAt.toISOString();
  const [matchAll, contactAll, matchSince, contactSince, matchEarliest, contactEarliest] = await Promise.all([
    store.matchLogCounts(),
    store.contactLogCounts(),
    store.matchLogCounts({ since: sinceIso }),
    store.contactLogCounts({ since: sinceIso }),
    store.matchLogEarliest(),
    store.contactLogEarliest()
  ]);
  const activity = {
    match: matchAll,
    contact: contactAll,
    since: { at: sinceAt, match: matchSince, contact: contactSince },
    // Hotfix post-#127/#128: "acumulado" no es lo mismo que "toda la
    // historia" — la bitácora tiene una fecha de nacimiento (#125). Sin esto,
    // un total "desde siempre" se lee como si hubiera medido desde el inicio
    // de la app, y no es cierto. null = todavía no hay ni un registro.
    instrumentedSince: {
      match: matchEarliest ? new Date(matchEarliest) : null,
      contact: contactEarliest ? new Date(contactEarliest) : null
    }
  };

  return { generatedAt, counts, activity, matcherStatus: matcher.status };
}

// La parte CARA: el recompute del embudo contra Rekognition
// (computeMatchStats, #117). Aislada para que quien la llame pueda medir su
// propia duración y decidir cuándo correrla — nunca adentro del camino
// síncrono de una página que un navegador está esperando.
async function gatherFunnelStats(store, matcher) {
  const startedAt = Date.now();
  const stats = await computeMatchStats(store, matcher);
  const durationMs = Date.now() - startedAt;
  return { stats, durationMs };
}

// La ÚNICA función que calcula TODAS las cifras del correo (#116, PR 6 +
// hotfix). El correo puede pagar el recompute completo porque corre en su
// propio cron, con su propio presupuesto — nunca adentro de una página que
// alguien está mirando cargar. El panel (src/adminStats.js) usa
// gatherCheapReportData directo para su render inmediato, y
// gatherFunnelStats aparte, en su propio endpoint diferido.
async function gatherReportData(store, matcher, opts = {}) {
  const cheap = await gatherCheapReportData(store, matcher, opts);
  const { stats, durationMs } = await gatherFunnelStats(store, matcher);
  return { ...cheap, stats, funnelDurationMs: durationMs };
}

// Serie diaria de los últimos `days` días (#116, PR 6 — solo la usa el
// panel; el correo no la necesitó pedir). Rellena los días sin filas con
// cero, para que la tabla no tenga huecos que parezcan un bug de la
// consulta en vez de "no pasó nada ese día" — PERO un día anterior al primer
// registro de la tabla no es "cero", es "sin instrumentación" (hotfix
// post-#127/#128): matchesAvailable/contactAvailable distinguen los dos
// casos para que quien renderice nunca confunda uno con otro.
async function gatherDailySeries(store, { days = 7 } = {}) {
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const [matchDaily, contactDaily, matchEarliest, contactEarliest] = await Promise.all([
    store.matchLogDaily({ since: sinceIso }),
    store.contactLogDaily({ since: sinceIso }),
    store.matchLogEarliest(),
    store.contactLogEarliest()
  ]);
  // matchLogEarliest/contactLogEarliest devuelven un INSTANTE en UTC (no un
  // bucket de día) — bogotaDayKey lo pasa por el mismo corte de Bogotá que
  // usan matchLogDaily/contactLogDaily, para que "disponible desde" compare
  // contra el mismo calendario que las filas que está comparando (hotfix:
  // antes se armaba con `.slice(0, 10)` sobre el string UTC, que es el día
  // en UTC — desalineado del bucket de Bogotá que arman los adapters).
  const matchEarliestDay = matchEarliest ? bogotaDayKey(new Date(matchEarliest)) : null;
  const contactEarliestDay = contactEarliest ? bogotaDayKey(new Date(contactEarliest)) : null;

  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) {
    dayKeys.push(bogotaDayKey(new Date(Date.now() - i * 24 * 3600 * 1000)));
  }

  const matchByDay = new Map(matchDaily.map((r) => [r.day, Number(r.count)]));
  const contactByDay = new Map();
  for (const r of contactDaily) {
    if (!contactByDay.has(r.day)) contactByDay.set(r.day, { enviado: 0, fallido: 0, rechazado: 0 });
    contactByDay.get(r.day)[r.result] = Number(r.count);
  }

  return dayKeys.map((day) => ({
    day,
    matches: matchByDay.get(day) || 0,
    matchesAvailable: !!matchEarliestDay && day >= matchEarliestDay,
    contact: contactByDay.get(day) || { enviado: 0, fallido: 0, rechazado: 0 },
    contactAvailable: !!contactEarliestDay && day >= contactEarliestDay
  }));
}

// Arma el reporte y lo manda a cada destinatario de REPORT_RECIPIENTS (un
// correo por destinatario — no expone la lista de operadores entre sí).
// Nunca revienta: si no hay destinos configurados, se niega RUIDOSAMENTE
// (log + { ok:false }), nunca en silencio — el mismo principio que ya rige
// sendEmail y relayToOperators en este repo.
async function sendReport(store, matcher) {
  const recipients = reportRecipients();
  if (!recipients.length) {
    console.error('[report] SKIPPED — REPORT_RECIPIENTS no está configurada. Nadie recibió el reporte operativo.');
    return { ok: false, error: 'REPORT_RECIPIENTS no configurada', sent: 0, failed: 0, recipients: 0 };
  }

  const { generatedAt, stats, counts, activity, matcherStatus, funnelDurationMs } = await gatherReportData(store, matcher);

  // Señal antes de que sea un fallo (hotfix post-#127): un 504 de plataforma
  // mata la función a medio camino — nada de lo que corra DESPUÉS del
  // recompute llega a ejecutarse, así que esto no puede avisar de un timeout
  // ya ocurrido. Lo que sí puede es avisar de que el margen se está
  // achicando, corrida a corrida, ANTES de que llegue a cero — por eso queda
  // en el log de cada corrida exitosa, no solo en la fallida.
  if (funnelDurationMs > FUNNEL_DURATION_WARN_MS) {
    console.warn(
      `[report] el recompute del embudo tardó ${(funnelDurationMs / 1000).toFixed(1)}s — ` +
        `por encima del umbral de aviso (${FUNNEL_DURATION_WARN_MS / 1000}s). Crece con las fotos; revisar maxDuration y la concurrencia de computeMatchStats.`
    );
  }

  const html = buildReportHtml(generatedAt, counts, stats, matcherStatus, activity, funnelDurationMs);
  const text = buildReportText(generatedAt, counts, stats, matcherStatus, activity, funnelDurationMs);
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
    `[report] generado ${generatedAt.toISOString()} — ${recipients.length} destino(s), ${sent} enviado(s), ${failed} fallido(s), ` +
      `stats_disponibles=${!!stats}, recompute=${(funnelDurationMs / 1000).toFixed(1)}s`
  );
  return {
    ok: failed === 0,
    generated_at: generatedAt.toISOString(),
    stats_available: !!stats,
    recipients: recipients.length,
    sent,
    failed,
    funnel_duration_ms: funnelDurationMs
  };
}

module.exports = {
  buildReportHtml,
  buildReportText,
  reportRecipients,
  sendReport,
  previousScheduledBogota,
  // Reutilizados por el panel (#116, PR 6) — una sola fuente de verdad para
  // las cifras y para cómo se arman las tablas. gatherCheapReportData es lo
  // que el panel llama en su camino síncrono (hotfix post-#127);
  // gatherFunnelStats es la parte cara, diferida a su propio endpoint.
  gatherReportData,
  gatherCheapReportData,
  gatherFunnelStats,
  gatherDailySeries,
  table,
  section,
  pivotContact,
  sumContact,
  SURFACE_LABEL,
  CHANNEL_LABEL,
  n,
  bogotaClock,
  bogotaDayKey,
  instrumentedSinceNote
};
