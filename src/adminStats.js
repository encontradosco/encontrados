// El panel de estadísticas (#116, PR 6 + hotfixes + rediseño a dashboard).
//
// SOLO cifras agregadas — la misma clase de dato que ya es público hoy en
// GET /api/diag. Ni un nombre, ni un contacto, ni un person_id/face_id/
// update_id, visible o en el HTML: si un dato no cabría en el correo del
// reporte (src/report.js), no cabe acá. El drill-down por ID que resuelve
// nombres y contactos en vivo NO EXISTE en este PR — cuando exista, nace
// detrás de requireAdminSession en /api/admin/*, nunca en esta superficie.
//
// DISEÑO (rediseño post-#129, pedido explícito del operador: "un dashboard
// visual. gráficas. hoy puedes lanzar data, en cards y números... igual las
// explicaciones"):
//   - Cards arriba: el estado del sistema en 3 segundos, sin leer una tabla.
//   - Gráficas como ciudadano de primera, justo debajo — la serie de 7 días
//     es lo que el correo no puede contar.
//   - Las tablas y el texto "qué significa" NO se borran — bajan a bloques
//     <details> nativos (cero JS para abrirlos), siempre accesibles.
//   - Identidad visual: la MISMA de encontrados.co (public/styles.css) — el
//     panel es una sección más del sitio, no un producto aparte. La única
//     firma nueva es la barra de 3px en cada card, la misma idea que ya usa
//     el .tricolor de la cabecera: una franja de color que informa estado.
//
// El embudo (dependiente de computeMatchStats, el recompute contra
// Rekognition — medía 28,7s en prod) sigue diferido a su propio endpoint,
// GET /admin/stats/funnel (#127/#128): la página entera renderiza de
// inmediato con lo barato, y esa llamada aparte rellena DOS huecos —
// la card de "salud de la medición" arriba, y el bloque de detalle del
// embudo más abajo — desde un solo fetch.
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

function publicBanner() {
  return `<div class="stats-banner">⚠️ <strong>Vista temporal sin autenticación.</strong> El acceso de administración
(<a href="${esc(ISSUE_URL)}">#116</a>) se está terminando de configurar — mientras tanto, esta página
queda abierta con las mismas cifras agregadas que ya son públicas en <code>/api/diag</code>. Se cierra
detrás de una sesión en cuanto el acceso esté listo.</div>`;
}

function statCard({ label, value, detail, variant, id, loading }) {
  const cls = ['stat-card', variant ? `stat-card--${variant}` : '', loading ? 'stat-card--loading' : '']
    .filter(Boolean)
    .join(' ');
  return `<div class="${cls}"${id ? ` id="${esc(id)}"` : ''}>
  <p class="stat-card__label">${esc(label)}</p>
  <p class="stat-card__value">${value}</p>
  ${detail ? `<p class="stat-card__detail">${detail}</p>` : ''}
</div>`;
}

function dot(color) {
  return `<span class="stat-card__dot" style="background:${color}"></span>`;
}

// Tabla + explicación de siempre, ahora detrás de un <details> nativo — el
// número exacto y el "qué significa" siguen ahí, a un tap/clic, nunca
// borrados (pedido explícito del operador, dos veces).
function detailsBlock(summaryText, innerHtml, { open = false } = {}) {
  return `<details class="stats-detail"${open ? ' open' : ''}>
  <summary>${esc(summaryText)}</summary>
  <div class="stats-detail__body">${innerHtml}</div>
</details>`;
}

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

// El fragmento caro, en DOS piezas con id propio — el script del lado del
// cliente las separa e inyecta cada una en su lugar (la card de salud
// arriba del todo, el detalle del embudo más abajo) desde una sola llamada.
// `stats` puede venir null (reconocimiento facial apagado): nunca una card
// que muestre un cero que parezca un dato real — declara explícitamente que
// no se pudo medir.
function buildFunnelFragmentHtml(stats, matcherStatus) {
  let cardHtml;
  let detailsHtml;

  if (!stats) {
    cardHtml = statCard({
      id: 'salud-card-slot',
      label: 'Salud de la medición',
      value: '—',
      detail: `Reconocimiento facial no disponible (${esc(matcherStatus || 'desconocido')}).`,
      variant: 'warn'
    });
    detailsHtml = `<div id="funnel-details-fragment"><p style="padding:10px 12px;background:#fdf6e3;border:1px solid #f0dca0;border-radius:10px;">
⚠️ El reconocimiento facial no está disponible en esta corrida (${esc(matcherStatus || 'desconocido')}). Las coincidencias no se pudieron recalcular —
esto <strong>no significa que sean cero</strong>, significa que no se pudieron medir. La base general de abajo sigue siendo real.</p></div>`;
    return `${cardHtml}\n${detailsHtml}`;
  }

  const notFoundYet = Math.max(stats.reported_people_indexed - stats.reported_people_matched, 0);
  const healthy = stats.failed === 0 && stats.dangling_face_matches === 0;
  // El número grande es stats.failed: FOTOS subidas por quien busca (no
  // personas, no las buscadas) cuya comparación falló esta corrida — la
  // etiqueta lo dice en la propia card, no solo en el detalle de abajo, para
  // que no se lea como si contara personas buscadas (el mismo error que
  // tenía "Comparaciones que fallaron" en el resto del panel y el correo).
  cardHtml = statCard({
    id: 'salud-card-slot',
    label: 'Fotos sin comparar (de quien busca)',
    value: n(stats.failed),
    detail: `${n(stats.dangling_face_matches)} golpe(s) contra firma(s) huérfana(s) en el índice`,
    variant: healthy ? undefined : stats.failed > 0 ? 'bad' : 'warn'
  });

  const funnelBody =
    section('El embudo (acumulado)') +
    funnelChart(stats) +
    detailsBlock(
      'Ver la tabla y qué significa cada número',
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
      ) +
        table(
          ['Señal de confiabilidad', 'Cuántos', 'Qué significa'],
          [
            [
              'Fotos que no se pudieron comparar',
              n(stats.failed),
              'Son fotos subidas por <strong>quien busca</strong> a alguien —un rescatista, o quien se suscribe con una foto— no de las personas buscadas. Falló la consulta al reconocimiento facial para esa foto puntual; si tenía alguna coincidencia, no quedó contada. Por eso los números de arriba son el <strong>mínimo real</strong> — pueden ser más.'
            ],
            [
              'Coincidencias contra firmas huérfanas',
              n(stats.dangling_face_matches),
              'Golpes contra la firma facial de una persona ya borrada de la base, que sigue en el índice (#71). Si una misma firma huérfana golpea más de una vez, cuenta cada vez — puede haber menos firmas distintas por limpiar que este número.'
            ]
          ]
        )
    );
  detailsHtml = `<div id="funnel-details-fragment" class="stats-section">${funnelBody}</div>`;

  return `${cardHtml}\n${detailsHtml}`;
}

// Vanilla, sin dependencias: pide el fragmento apenas carga la página y lo
// reparte en sus dos destinos (la card de salud, el detalle del embudo).
// Mientras espera, ambos dicen con claridad que están calculando; si falla o
// expira, lo dicen también — nunca un cero que parezca un dato real.
const FUNNEL_SCRIPT = `<script>
(function () {
  var cardSlot = document.getElementById('salud-card-slot');
  var detailsSlot = document.getElementById('funnel-details-slot');
  fetch('/admin/stats/funnel')
    .then(function (res) {
      if (!res.ok) throw new Error('status ' + res.status);
      return res.text();
    })
    .then(function (html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var card = tmp.querySelector('#salud-card-slot');
      var details = tmp.querySelector('#funnel-details-fragment');
      if (card && cardSlot) cardSlot.replaceWith(card);
      if (details && detailsSlot) detailsSlot.replaceWith(details);
    })
    .catch(function () {
      var msg = '<p style="padding:10px 12px;background:#fdecea;border:1px solid #f0b8ae;border-radius:10px;">' +
        '⚠️ No se pudo calcular el embudo de coincidencias en este momento (recompute contra Rekognition — puede tardar). ' +
        'Intenta recargar en un minuto.</p>';
      if (cardSlot) cardSlot.outerHTML = '<div class="stat-card stat-card--bad"><p class="stat-card__label">Salud de la medición</p>' +
        '<p class="stat-card__value">—</p><p class="stat-card__detail">No se pudo calcular. Intenta recargar.</p></div>';
      if (detailsSlot) detailsSlot.innerHTML = msg;
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
  const contactTotals = sumContact(contactPivot);

  // Las 3 cards que SÍ pueden ir de inmediato (datos baratos, de la base) +
  // el 4to slot, que arranca en "calculando" y lo llena FUNNEL_SCRIPT.
  const heroCards =
    `<div class="stats-hero">` +
    statCard({
      label: 'Coincidencias registradas',
      value: n(matchPivot.total),
      detail: `Rescate ${n(matchPivot.rescate)} · Reporte ${n(matchPivot.report)} · API ${n(matchPivot.api)}`
    }) +
    statCard({
      label: 'Envíos intentados',
      value: n(contactTotals.total),
      detail: `${dot('#4a7c59')}${n(contactTotals.enviados)} enviados &nbsp; ${dot('#c0392b')}${n(pivotSum(contactPivot, 'fallido'))} fallidos &nbsp; ${dot('#c8863c')}${n(pivotSum(contactPivot, 'rechazado'))} rechazados`,
      variant: pivotSum(contactPivot, 'fallido') > 0 ? 'bad' : pivotSum(contactPivot, 'rechazado') > 0 ? 'warn' : undefined
    }) +
    statCard({
      label: 'Personas en la base',
      value: n(counts.people),
      detail: `${n(counts.updates)} actualizaciones · ${n(counts.photos_indexed)} de ${n(counts.photos)} fotos indexadas`
    }) +
    statCard({ id: 'salud-card-slot', label: 'Salud de la medición', value: '…', detail: 'Calculando contra Rekognition…', loading: true }) +
    `</div>`;

  const bitacoraDetails = detailsBlock(
    'Ver el desglose completo y qué significa cada número',
    instrumentedSinceNote(activity.instrumentedSince) +
      table(
        ['Superficie', 'Coincidencias registradas'],
        [
          ...['rescate', 'report', 'api'].map((s) => [SURFACE_LABEL[s], n(matchPivot[s] || 0)]),
          ['<strong>Total</strong>', `<strong>${n(matchPivot.total || 0)}</strong>`]
        ]
      ) +
      table(
        ['Canal', 'Enviados', 'Fallidos', 'Rechazados'],
        ['email', 'whatsapp', 'relevo'].map((ch) => [
          CHANNEL_LABEL[ch],
          n(contactPivot[ch].enviado),
          n(contactPivot[ch].fallido),
          n(contactPivot[ch].rechazado)
        ])
      )
  );

  const since = activity.since;
  let deltaNote = '';
  if (since) {
    const sinceMatch = since.match || { total: 0 };
    const sinceContact = sumContact(pivotContact(since.contact));
    const at = bogotaClock(since.at);
    deltaNote = `<p class="stats-note"><strong>Desde el horario programado anterior</strong> (aprox. ${esc(at.day)} ${esc(at.month)}, ${esc(at.hm)} Bogotá): ${n(sinceMatch.total)} coincidencia(s) nueva(s), ${n(sinceContact.total)} envío(s) intentado(s) (${n(sinceContact.enviados)} entregado(s)).</p>`;
  }

  const dailySection = `<div class="stats-section">
    ${section('Últimos 7 días')}
    <div class="stats-chart-card">${dailyMatchesChart(daily)}</div>
    <div class="stats-chart-card">${dailyContactChart(daily)}</div>
    ${detailsBlock('Ver la tabla exacta, día por día', dailyTable(daily))}
  </div>`;

  const channelSection = `<div class="stats-section">
    ${section('Envíos por canal (acumulado)')}
    <div class="stats-chart-card">${contactByChannelChart(contactPivot, CHANNEL_LABEL)}</div>
    ${bitacoraDetails}
  </div>`;

  // Placeholder del embudo: arranca con "calculando" + <noscript>, y
  // FUNNEL_SCRIPT lo reemplaza entero por #funnel-details-fragment.
  const funnelPlaceholder = `<div id="funnel-details-slot" class="stats-section">
    ${section('El embudo (acumulado)')}
    <p style="padding:10px 12px;background:#f4f1ea;border:1px solid #e8e4da;border-radius:10px;">⏳ Calculando el embudo de coincidencias contra Rekognition — puede tardar unos segundos…</p>
    <noscript><p>⚠️ Esta sección necesita JavaScript para cargar (pide el embudo aparte, para que el resto de la página no espere por Rekognition). Sin JS, no se muestra.</p></noscript>
  </div>`;

  const baseSection = `<div class="stats-section">
    ${section('La base en general')}
    ${detailsBlock(
      'Ver personas, actualizaciones, suscripciones y fotos',
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
      ),
      { open: false }
    )}
  </div>`;

  const footer = `<p class="stats-note" style="font-style:italic;">Generado ${esc(day)} ${esc(month)}, ${esc(hm)} Bogotá · Mismas cifras que el reporte por correo (#116) · Sin drill-down por ID — eso vive detrás de sesión en /api/admin/*, no acá.</p>`;

  const body = `
    <h1>Panel de estadísticas</h1>
    ${banner}
    ${heroCards}
    ${deltaNote}
    ${dailySection}
    ${channelSection}
    ${funnelPlaceholder}
    ${baseSection}
    ${footer}
    ${FUNNEL_SCRIPT}
  `;

  return layout('Panel de estadísticas', body, { path: '/admin/stats', robots: 'noindex, nofollow', mainClass: 'stats-wide' });
}

function pivotSum(pivot, result) {
  return Object.values(pivot).reduce((s, ch) => s + (ch[result] || 0), 0);
}

module.exports = { buildStatsPageHtml, buildFunnelFragmentHtml };
