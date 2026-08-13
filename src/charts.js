// Gráficas de columnas, generadas en el servidor como SVG plano (#116,
// hotfix post-#127/#128 — "darle visualización de dashboard"). Sin
// dependencias nuevas, sin CDN, sin framework — el mismo estilo
// server-rendered que el resto de la app. Estático a propósito: sin JS, para
// que cargue igual de rápido que cualquier otra página de encontrados.co y
// para que no haya nada que romperse en un navegador viejo a las 3am.
//
// Specs de marca (barras ≤24px, extremo redondeado de 4px, gap de 2px entre
// segmentos, grid recesivo, sin doble eje) del skill de dataviz del
// operador — pero la PALETA es la que ya usa este sitio, no la genérica del
// skill: encontrados.co ya tiene tres colores de estado en public/styles.css
// (.badge.ok/.warn/.bad, los mismos que pintan "a salvo"/"herido"/
// "desaparecido" en cada ficha), así que enviado/fallido/rechazado los
// reusan tal cual — respeta la identidad visual existente en vez de traer
// un vocabulario de color nuevo para una sección más del sitio.
const { esc } = require('./html');

const COLOR = {
  primary: '#2b6cb0', // var(--accent) del sitio — una sola serie (coincidencias)
  good: '#4a7c59', // .badge.ok — enviado
  warning: '#c8863c', // .badge.warn — rechazado
  critical: '#c0392b', // .badge.bad — fallido
  grid: '#e8e4da', // var(--border)
  textPrimary: '#1f1e1d', // var(--ink)
  textSecondary: '#73726c', // var(--muted)
  unavailableFill: '#f4f1ea', // var(--paper)
  unavailableStroke: '#d8d3c6' // var(--border-strong)
};

const RESULT_COLOR = { enviado: COLOR.good, rechazado: COLOR.warning, fallido: COLOR.critical };
const RESULT_LABEL = { enviado: 'Enviados', fallido: 'Fallidos', rechazado: 'Rechazados' };

function niceMax(max) {
  if (max <= 0) return 4; // nunca un chart con techo 0 — ver anti-patterns
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const steps = [1, 2, 2.5, 5, 10];
  for (const s of steps) {
    if (max <= s * pow) return s * pow;
  }
  return 10 * pow;
}

function legend(items, x, y) {
  let out = '';
  let cx = x;
  for (const it of items) {
    out += `<rect x="${cx}" y="${y}" width="10" height="10" rx="2" fill="${it.color}"></rect>`;
    out += `<text x="${cx + 14}" y="${y + 9}" font-size="11" fill="${COLOR.textSecondary}">${esc(it.label)}</text>`;
    cx += 14 + it.label.length * 6.2 + 18;
  }
  return out;
}

// `groups`: [{ label, segments: [{ key, value, color }], available }]
// `available: false` dibuja un placeholder rayado con "—" en vez de una
// barra — nunca una barra de altura 0 para un día sin instrumentación (eso
// sería el mismo error de fondo que un cero disfrazado de dato, ahora en un
// dibujo en vez de en una celda).
function columnChart({ title, ariaLabel, groups, legendItems, height = 200, maxValue }) {
  const barSlot = 64;
  const barWidth = 24; // spec: bar ≤24px
  const leftAxis = 44;
  const bottomAxis = 28;
  const topPad = legendItems ? 34 : 16;
  const width = leftAxis + groups.length * barSlot + 16;
  const chartH = height - topPad - bottomAxis;

  const max = niceMax(maxValue ?? Math.max(0, ...groups.map((g) => g.segments.reduce((s, seg) => s + seg.value, 0))));
  const y = (v) => topPad + chartH - (v / max) * chartH;
  const barH = (v) => (v / max) * chartH;

  // Gridlines: 0, mitad, techo — "redondeados a números limpios" (marks spec).
  const ticks = [0, max / 2, max].map(Math.round);
  let gridSvg = '';
  for (const t of ticks) {
    const ty = y(t);
    gridSvg += `<line x1="${leftAxis}" y1="${ty}" x2="${width - 8}" y2="${ty}" stroke="${COLOR.grid}" stroke-width="1"></line>`;
    gridSvg += `<text x="${leftAxis - 8}" y="${ty + 3}" font-size="10" fill="${COLOR.textSecondary}" text-anchor="end">${t.toLocaleString('es-CO')}</text>`;
  }

  let bars = '';
  groups.forEach((g, i) => {
    const cx = leftAxis + i * barSlot + barSlot / 2;
    const bx = cx - barWidth / 2;
    const baseline = topPad + chartH;

    if (g.available === false) {
      // Placeholder de altura FIJA (no proporcional a ningún valor real) —
      // nunca se lee como un dato, y el "—" lo dice sin ambigüedad.
      const phH = 18;
      bars += `<rect x="${bx}" y="${baseline - phH}" width="${barWidth}" height="${phH}" rx="4" fill="${COLOR.unavailableFill}" stroke="${COLOR.unavailableStroke}" stroke-width="1" stroke-dasharray="3,2"></rect>`;
      bars += `<text x="${cx}" y="${baseline - phH - 6}" font-size="10" fill="${COLOR.textSecondary}" text-anchor="middle">—</text>`;
    } else {
      let stackTop = baseline;
      const segs = g.segments.filter((s) => s.value > 0);
      segs.forEach((seg, si) => {
        const h = Math.max(barH(seg.value), seg.value > 0 ? 2 : 0);
        const segY = stackTop - h;
        // Gap de 2px en el color de superficie entre segmentos apilados —
        // nunca un borde: el gap es el mecanismo, un stroke sería tinta que
        // no es dato.
        const gapAdjust = si > 0 ? 2 : 0;
        bars += `<rect x="${bx}" y="${segY + gapAdjust}" width="${barWidth}" height="${Math.max(h - gapAdjust, 0)}" rx="${si === segs.length - 1 ? 4 : 0}" fill="${seg.color}"></rect>`;
        stackTop = segY;
      });
      const total = g.segments.reduce((s, seg) => s + seg.value, 0);
      if (total > 0) {
        bars += `<text x="${cx}" y="${stackTop - 6}" font-size="10" fill="${COLOR.textPrimary}" text-anchor="middle">${total.toLocaleString('es-CO')}</text>`;
      }
    }

    bars += `<text x="${cx}" y="${height - 6}" font-size="10" fill="${COLOR.textSecondary}" text-anchor="middle">${esc(g.label)}</text>`;
  });

  const legendSvg = legendItems ? legend(legendItems, leftAxis, 8) : '';
  const titleSvg = title
    ? `<text x="0" y="14" font-size="12" fill="${COLOR.textPrimary}" font-weight="600">${esc(title)}</text>`
    : '';

  return `<svg role="img" aria-label="${esc(ariaLabel)}" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;height:auto;font-family:-apple-system,Helvetica,Arial,sans-serif;">
${titleSvg}
${legendSvg}
<line x1="${leftAxis}" y1="${topPad + chartH}" x2="${width - 8}" y2="${topPad + chartH}" stroke="${COLOR.grid}" stroke-width="1"></line>
${gridSvg}
${bars}
</svg>`;
}

// Serie de 7 días — coincidencias (una sola serie, azul, sin leyenda).
function dailyMatchesChart(daily) {
  const groups = daily.map((d) => ({
    label: d.day.slice(5), // MM-DD, el año no aporta acá
    available: d.matchesAvailable,
    segments: [{ key: 'matches', value: d.matches, color: COLOR.primary }]
  }));
  const ariaLabel =
    'Coincidencias registradas por día, últimos 7 días: ' +
    daily.map((d) => `${d.day} ${d.matchesAvailable ? d.matches : 'sin instrumentación'}`).join(', ');
  return columnChart({ title: 'Coincidencias por día', ariaLabel, groups });
}

// Serie de 7 días — envíos por resultado (apilado, paleta de estado).
function dailyContactChart(daily) {
  const groups = daily.map((d) => ({
    label: d.day.slice(5),
    available: d.contactAvailable,
    segments: ['enviado', 'fallido', 'rechazado'].map((k) => ({
      key: k,
      value: d.contact[k] || 0,
      color: RESULT_COLOR[k]
    }))
  }));
  const legendItems = ['enviado', 'fallido', 'rechazado'].map((k) => ({ label: RESULT_LABEL[k], color: RESULT_COLOR[k] }));
  const ariaLabel =
    'Envíos intentados por día y resultado, últimos 7 días: ' +
    daily
      .map((d) =>
        d.contactAvailable
          ? `${d.day} enviados ${d.contact.enviado}, fallidos ${d.contact.fallido}, rechazados ${d.contact.rechazado}`
          : `${d.day} sin instrumentación`
      )
      .join(', ');
  return columnChart({ title: 'Envíos por día y resultado', ariaLabel, groups, legendItems });
}

// Envíos por canal — acumulado (apilado, paleta de estado). No tiene
// problema de "sin instrumentación": es un total desde que existe la
// bitácora, la fecha de corte ya va en el texto que acompaña la sección.
function contactByChannelChart(contactPivot, channelLabels) {
  const channels = ['email', 'whatsapp', 'relevo'];
  const groups = channels.map((ch) => ({
    label: channelLabels[ch],
    available: true,
    segments: ['enviado', 'fallido', 'rechazado'].map((k) => ({
      key: k,
      value: contactPivot[ch][k] || 0,
      color: RESULT_COLOR[k]
    }))
  }));
  const legendItems = ['enviado', 'fallido', 'rechazado'].map((k) => ({ label: RESULT_LABEL[k], color: RESULT_COLOR[k] }));
  const ariaLabel = channels
    .map((ch) => `${channelLabels[ch]}: enviados ${contactPivot[ch].enviado}, fallidos ${contactPivot[ch].fallido}, rechazados ${contactPivot[ch].rechazado}`)
    .join(', ');
  return columnChart({ title: 'Envíos por canal (acumulado)', ariaLabel, groups, legendItems });
}

// El embudo — 3 magnitudes, no es un funnel monotónico de verdad (la última
// barra puede superar a la de en medio), así que se trata como lo que es:
// una comparación de 3 magnitudes, una sola serie.
function funnelChart(stats) {
  const groups = [
    { label: 'Con foto útil', available: true, segments: [{ key: 'a', value: stats.reported_people_indexed, color: COLOR.primary }] },
    { label: 'Con coincidencia', available: true, segments: [{ key: 'b', value: stats.reported_people_matched, color: COLOR.primary }] },
    { label: 'Coincid. totales', available: true, segments: [{ key: 'c', value: stats.report_matches_total, color: COLOR.primary }] }
  ];
  const ariaLabel = `Embudo de coincidencias: ${stats.reported_people_indexed} personas con foto útil, ${stats.reported_people_matched} con al menos una coincidencia, ${stats.report_matches_total} coincidencias en total.`;
  return columnChart({ title: 'El embudo (acumulado)', ariaLabel, groups });
}

module.exports = { dailyMatchesChart, dailyContactChart, contactByChannelChart, funnelChart };
