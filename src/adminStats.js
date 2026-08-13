// El panel de estadísticas (#116, PR 6 + hotfix post-#127).
//
// SOLO cifras agregadas — la misma clase de dato que ya es público hoy en
// GET /api/diag. Ni un nombre, ni un contacto, ni un person_id/face_id/
// update_id, visible o en el HTML: si un dato no cabría en el correo del
// reporte (src/report.js), no cabe acá. El drill-down por ID que resuelve
// nombres y contactos en vivo NO EXISTE en este PR — cuando exista, nace
// detrás de requireAdminSession en /api/admin/*, nunca en esta superficie.
//
// El embudo (tablas "¿podemos confiar?" + "coincidencias") es la sección
// CARA — depende de computeMatchStats, que recomputa contra Rekognition y
// midió 28,7s en prod con ~110 fotos. Antes de este hotfix vivía en el mismo
// render que el resto de la página, adentro del presupuesto de la función
// serverless: eso fue el 504 (#127). Ahora la página se manda de inmediato
// con lo barato (bitácora + conteos + serie de 7 días, todo de la base, con
// índice), y el embudo se pide aparte, después de cargar, a
// GET /admin/stats/funnel — mismo gate, mismo maxDuration, pero SU PROPIO
// request, que puede tardar sin bloquear la página.
//
// Server-rendered, como el resto de la app — reusa layout()/esc() de
// src/html.js y table()/section()/n()/pivotContact()/sumContact()/
// SURFACE_LABEL/CHANNEL_LABEL/bogotaClock de src/report.js: una sola fuente
// de verdad para cómo se calculan y se tabulan estas cifras. El correo y el
// panel nunca deberían poder contradecirse.
const { layout, esc } = require('./html');
const {
  table,
  section,
  pivotContact,
  sumContact,
  SURFACE_LABEL,
  CHANNEL_LABEL,
  n,
  bogotaClock,
  instrumentedSinceNote
} = require('./report');
const { dailyMatchesChart, dailyContactChart, contactByChannelChart, funnelChart } = require('./charts');

const ISSUE_URL = 'https://github.com/encontradosco/encontrados/issues/116';

// Vista temporal sin autenticación — visible SOLO mientras PUBLIC_STATS
// mantiene esta página abierta al público. No dice "sin PII" ni cosas por el
// estilo: dice la verdad operativa, que es lo que un lector necesita saber.
function publicBanner() {
  return `<p style="padding:10px 12px;background:#fff3cd;border:1px solid #ffe08a;border-radius:4px;font-size:14px;">
⚠️ <strong>Vista temporal sin autenticación.</strong> El acceso de administración
(<a href="${esc(ISSUE_URL)}">#116</a>) se está terminando de configurar — mientras tanto, esta página
queda abierta con las mismas cifras agregadas que ya son públicas en <code>/api/diag</code>. Se cierra
detrás de una sesión en cuanto el acceso esté listo.</p>`;
}

// "—" para un día anterior al primer registro de la tabla correspondiente
// (hotfix post-#127/#128): un cero ahí sería la misma mentira por omisión
// que motivó el issue — "no medido" y "medido en cero" son hechos distintos,
// y la tabla no puede confundirlos. matchesAvailable/contactAvailable son
// independientes porque match_log y contact_log pueden tener su propio
// primer registro.
function dailyTable(daily) {
  return table(
    ['Día', 'Coincidencias', 'Enviados', 'Fallidos', 'Rechazados'],
    daily.map((d) => [
      esc(d.day),
      d.matchesAvailable ? n(d.matches) : '—',
      d.contactAvailable ? n(d.contact.enviado) : '—',
      d.contactAvailable ? n(d.contact.fallido) : '—',
      d.contactAvailable ? n(d.contact.rechazado) : '—'
    ])
  );
}

// El fragmento caro — solo su contenido interno, sin <html>/<head>/layout:
// lo consume tanto GET /admin/stats/funnel (lo manda tal cual) como el
// fallback del navegador sin JavaScript (ver buildStatsPageHtml). `stats`
// puede venir null (reconocimiento facial apagado): nunca se muestra un cero
// que parezca un dato real — se declara explícitamente que no se pudo medir.
function buildFunnelFragmentHtml(stats, matcherStatus) {
  if (!stats) {
    return `<p style="padding:10px 12px;background:#fff3cd;border:1px solid #ffe08a;border-radius:4px;">
⚠️ El reconocimiento facial no está disponible en esta corrida (${esc(matcherStatus || 'desconocido')}). Las coincidencias no se pudieron recalcular —
esto <strong>no significa que sean cero</strong>, significa que no se pudieron medir. La base general de abajo sigue siendo real.</p>`;
  }
  const notFoundYet = Math.max(stats.reported_people_indexed - stats.reported_people_matched, 0);
  return (
    funnelChart(stats) +
    section('¿Podemos confiar en los números de abajo?') +
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
    section('Coincidencias (el embudo, acumulado)') +
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
          `Las otras ${n(notFoundYet)} no han aparecido en ninguna foto — todavía.`
        ],
        ['→ Coincidencias en total', n(stats.report_matches_total), 'Una misma persona puede aparecer en varias fotos.']
      ]
    )
  );
}

// Vanilla, sin dependencias: pide el fragmento apenas carga la página y lo
// inyecta. Mientras espera, dice con claridad que está calculando; si falla
// o expira, lo dice también — nunca deja el placeholder ambiguo ni lo
// reemplaza por un cero.
const FUNNEL_SCRIPT = `<script>
(function () {
  var el = document.getElementById('funnel-async');
  if (!el) return;
  fetch('/admin/stats/funnel')
    .then(function (res) {
      if (!res.ok) throw new Error('status ' + res.status);
      return res.text();
    })
    .then(function (html) {
      el.innerHTML = html;
    })
    .catch(function () {
      el.innerHTML = '<p style="padding:10px 12px;background:#fdecea;border:1px solid #f5b5ae;border-radius:4px;">' +
        '⚠️ No se pudo calcular el embudo de coincidencias en este momento (recompute contra Rekognition — puede tardar). ' +
        'Intenta recargar en un minuto.</p>';
    });
})();
</script>`;

// `data` es gatherCheapReportData(store, matcher) — SIN stats: el embudo se
// pide aparte (ver FUNNEL_SCRIPT). `daily` es gatherDailySeries().
function buildStatsPageHtml({ generatedAt, counts, activity, matcherStatus }, daily, { isPublic }) {
  const { day, month, hm } = bogotaClock(generatedAt);

  const banner = isPublic ? publicBanner() : '';

  const matchPivot = activity.match || { total: 0, rescate: 0, report: 0, api: 0 };
  const contactPivot = pivotContact(activity.contact);

  const bitacoraSection =
    section('Envíos y coincidencias registradas en el momento (acumulado, desde que existe la bitácora)') +
    instrumentedSinceNote(activity.instrumentedSince) +
    table(
      ['Superficie', 'Coincidencias registradas'],
      [
        ...['rescate', 'report', 'api'].map((s) => [SURFACE_LABEL[s], n(matchPivot[s] || 0)]),
        ['<strong>Total</strong>', `<strong>${n(matchPivot.total || 0)}</strong>`]
      ]
    ) +
    '<p style="font-size:13px;color:#555;margin:12px 0 4px;">Envíos intentados, por canal — <strong>los fallos y rechazos importan más que los enviados</strong>: un canal que solo cuenta lo que salió bien siempre se ve sano.</p>' +
    contactByChannelChart(contactPivot, CHANNEL_LABEL) +
    table(
      ['Canal', 'Enviados', 'Fallidos', 'Rechazados'],
      ['email', 'whatsapp', 'relevo'].map((ch) => [
        CHANNEL_LABEL[ch],
        n(contactPivot[ch].enviado),
        n(contactPivot[ch].fallido),
        n(contactPivot[ch].rechazado)
      ])
    );

  const since = activity.since;
  let deltaLine = '';
  if (since) {
    const sinceMatch = since.match || { total: 0 };
    const sinceContact = sumContact(pivotContact(since.contact));
    const at = bogotaClock(since.at);
    deltaLine = `<p style="font-size:13px;color:#555;"><strong>Desde el horario programado anterior</strong> (aprox. ${esc(at.day)} ${esc(at.month)}, ${esc(at.hm)} Bogotá): ${n(sinceMatch.total)} coincidencia(s) nueva(s), ${n(sinceContact.total)} envío(s) intentado(s) (${n(sinceContact.enviados)} entregado(s)).</p>`;
  }

  const seriesSection =
    section('Últimos 7 días') +
    dailyMatchesChart(daily) +
    dailyContactChart(daily) +
    dailyTable(daily);

  const baseSection =
    section('La base en general') +
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
          'Cada ficha de una fuente externa y cada reporte directo en la web entra como una actualización de una persona.'
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

  const footer = `<p style="font-size:12px;color:#888;font-style:italic;">Generado ${esc(day)} ${esc(month)}, ${esc(hm)} Bogotá · Mismas cifras que el reporte por correo (#116) · Sin drill-down por ID — eso vive detrás de sesión en /api/admin/*, no acá.</p>`;

  // El embudo depende de Rekognition y puede tardar — nunca adentro del
  // render de la página (ver la nota grande al inicio del archivo). Sin
  // JavaScript, <noscript> deja dicho por qué esa sección no llegó, en vez
  // de quedar en blanco sin explicación.
  const funnelPlaceholder = `
    <div id="funnel-async">
      <p style="padding:10px 12px;background:#f4f4f4;border:1px solid #ddd;border-radius:4px;">⏳ Calculando el embudo de coincidencias contra Rekognition — puede tardar unos segundos…</p>
      <noscript><p>⚠️ Esta sección necesita JavaScript para cargar (pide el embudo aparte, para que el resto de la página no espere por Rekognition). Sin JS, no se muestra.</p></noscript>
    </div>
    ${FUNNEL_SCRIPT}`;

  const body = `
    <h1>Panel de estadísticas</h1>
    ${banner}
    ${funnelPlaceholder}
    ${bitacoraSection}
    ${deltaLine}
    ${seriesSection}
    ${baseSection}
    ${footer}
  `;

  return layout('Panel de estadísticas', body, { path: '/admin/stats', robots: 'noindex, nofollow' });
}

module.exports = { buildStatsPageHtml, buildFunnelFragmentHtml };
