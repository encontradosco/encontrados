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
const { suppressedCell, suppressBreakdown } = require('./report');

const RESULT_KEYS = ['enviado', 'fallido', 'rechazado'];

// Versión hablada de una celda suprimida, para el aria-label — nunca el
// número real, y en palabras en vez del signo "<" (más claro leído por un
// lector de pantalla que "menor que cinco" con un símbolo de por medio).
function spoken(cell) {
  if (!cell) return 'sin dato';
  if (cell.hidden) return 'cifra no publicada';
  if (cell.suppressed) return 'menos de 5';
  return String(cell.value);
}

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

// `groups`: [{ label, segments: [{ key, value, color, suppressed?, hidden? }], available, totalDisplay? }]
// `available: false` dibuja un placeholder rayado con "—" en vez de una
// barra — nunca una barra de altura 0 para un día sin instrumentación (eso
// sería el mismo error de fondo que un cero disfrazado de dato, ahora en un
// dibujo en vez de en una celda).
//
// Supresión de celdas pequeñas (#132): un segmento `suppressed` (valor 1-4)
// o `hidden` (valor real posiblemente grande, ocultado para que no se
// deduzca por resta un vecino pequeño — ver report.js, suppressBreakdown) se
// dibuja con la MISMA altura fija rayada que ya usa `available: false`,
// nunca proporcional a su valor real — una barra de altura 1 delataría el
// dato aunque la etiqueta dijera "<5". `totalDisplay`, cuando viene, es la
// etiqueta YA decidida por report.js para el total de la pila (puede ser el
// número exacto, "<5" o "—"); si no viene, se recalcula sumando segmentos
// (camino que usa funnelChart, sin datos suprimibles).
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
        const gapAdjust = si > 0 ? 2 : 0;
        if (seg.suppressed || seg.hidden) {
          // Altura FIJA, no proporcional — ver la nota sobre `groups` arriba.
          const phH = 14;
          const segY = stackTop - phH;
          bars += `<rect x="${bx}" y="${segY + gapAdjust}" width="${barWidth}" height="${Math.max(phH - gapAdjust, 0)}" rx="${si === segs.length - 1 ? 4 : 0}" fill="${COLOR.unavailableFill}" stroke="${seg.color}" stroke-width="1" stroke-dasharray="3,2"></rect>`;
          stackTop = segY;
        } else {
          const h = Math.max(barH(seg.value), 2);
          const segY = stackTop - h;
          // Gap de 2px en el color de superficie entre segmentos apilados —
          // nunca un borde: el gap es el mecanismo, un stroke sería tinta que
          // no es dato.
          bars += `<rect x="${bx}" y="${segY + gapAdjust}" width="${barWidth}" height="${Math.max(h - gapAdjust, 0)}" rx="${si === segs.length - 1 ? 4 : 0}" fill="${seg.color}"></rect>`;
          stackTop = segY;
        }
      });
      const totalLabel =
        g.totalDisplay != null ? g.totalDisplay : (() => {
          const total = g.segments.reduce((s, seg) => s + seg.value, 0);
          return total > 0 ? total.toLocaleString('es-CO') : null;
        })();
      if (totalLabel) {
        bars += `<text x="${cx}" y="${stackTop - 6}" font-size="10" fill="${COLOR.textPrimary}" text-anchor="middle">${totalLabel}</text>`;
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

// Serie de 7 días — coincidencias (una sola serie, azul, sin leyenda). Un
// solo valor por barra: no hay un total-vs-partes que proteger, así que
// alcanza con la supresión primaria (suppressedCell) por día.
function dailyMatchesChart(daily) {
  const cells = daily.map((d) => suppressedCell(d.matches));
  const groups = daily.map((d, i) => ({
    label: d.day.slice(5), // MM-DD, el año no aporta acá
    available: d.matchesAvailable,
    segments: [
      { key: 'matches', value: cells[i].value, color: COLOR.primary, suppressed: cells[i].suppressed, hidden: cells[i].hidden }
    ],
    totalDisplay: d.matchesAvailable ? cells[i].display : null
  }));
  const ariaLabel =
    'Coincidencias registradas por día, últimos 7 días: ' +
    daily.map((d, i) => `${d.day} ${d.matchesAvailable ? spoken(cells[i]) : 'sin instrumentación'}`).join(', ');
  return columnChart({ title: 'Coincidencias por día', ariaLabel, groups });
}

// Serie de 7 días — envíos por resultado (apilado, paleta de estado). Tres
// partes que suman un total mostrado arriba de la pila: supresión completa
// (suppressBreakdown) por día, para que una parte pequeña no se pueda
// deducir restando las otras dos del total.
function dailyContactChart(daily) {
  const perDay = daily.map((d) => {
    const parts = RESULT_KEYS.map((k) => ({ key: k, value: d.contact[k] || 0 }));
    return suppressBreakdown(parts, parts.reduce((s, p) => s + p.value, 0));
  });
  const groups = daily.map((d, i) => ({
    label: d.day.slice(5),
    available: d.contactAvailable,
    segments: perDay[i].cells.map((c) => ({ key: c.key, value: c.value, color: RESULT_COLOR[c.key], suppressed: c.suppressed, hidden: c.hidden })),
    totalDisplay: d.contactAvailable ? perDay[i].total.display : null
  }));
  const legendItems = RESULT_KEYS.map((k) => ({ label: RESULT_LABEL[k], color: RESULT_COLOR[k] }));
  const ariaLabel =
    'Envíos intentados por día y resultado, últimos 7 días: ' +
    daily
      .map((d, i) => {
        if (!d.contactAvailable) return `${d.day} sin instrumentación`;
        const byKey = Object.fromEntries(perDay[i].cells.map((c) => [c.key, c]));
        return `${d.day} enviados ${spoken(byKey.enviado)}, fallidos ${spoken(byKey.fallido)}, rechazados ${spoken(byKey.rechazado)}`;
      })
      .join(', ');
  return columnChart({ title: 'Envíos por día y resultado', ariaLabel, groups, legendItems });
}

// Envíos por canal — acumulado (apilado, paleta de estado). No tiene
// problema de "sin instrumentación": es un total desde que existe la
// bitácora, la fecha de corte ya va en el texto que acompaña la sección.
// Mismo tratamiento de supresión que dailyContactChart, por canal.
function contactByChannelChart(contactPivot, channelLabels) {
  const channels = ['email', 'whatsapp', 'relevo'];
  const perChannel = channels.map((ch) => {
    const parts = RESULT_KEYS.map((k) => ({ key: k, value: contactPivot[ch][k] || 0 }));
    return suppressBreakdown(parts, parts.reduce((s, p) => s + p.value, 0));
  });
  const groups = channels.map((ch, i) => ({
    label: channelLabels[ch],
    available: true,
    segments: perChannel[i].cells.map((c) => ({ key: c.key, value: c.value, color: RESULT_COLOR[c.key], suppressed: c.suppressed, hidden: c.hidden })),
    totalDisplay: perChannel[i].total.display
  }));
  const legendItems = RESULT_KEYS.map((k) => ({ label: RESULT_LABEL[k], color: RESULT_COLOR[k] }));
  const ariaLabel = channels
    .map((ch, i) => {
      const byKey = Object.fromEntries(perChannel[i].cells.map((c) => [c.key, c]));
      return `${channelLabels[ch]}: enviados ${spoken(byKey.enviado)}, fallidos ${spoken(byKey.fallido)}, rechazados ${spoken(byKey.rechazado)}`;
    })
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

// El embudo del encuentro (#132, punto 6) — 4 magnitudes ACUMULADAS desde
// siempre, nunca por día (ver report.js/adminStats.js: rebanar por día es
// justo lo que fabricó un falso "caso único" antes en este panel). Un solo
// valor por escalón — como dailyMatchesChart, no hay un total-vs-partes que
// proteger, así que alcanza con suppressedCell por escalón (ya calculado por
// quien llama). MISMA advertencia que funnelChart de arriba, más fuerte
// todavía: acá el último escalón NI SIQUIERA es necesariamente subconjunto de
// los anteriores (una persona puede pasar a 'safe' sin que medie ninguna
// coincidencia ni aviso de esta app) — por eso el texto que acompaña la
// gráfica, no la gráfica misma, es quien tiene que decir "piso, no total".
function reunionFunnelChart(steps) {
  const groups = steps.map((s) => ({
    label: s.label,
    available: true,
    segments: [{ key: s.key, value: s.cell.value, color: COLOR.primary, suppressed: s.cell.suppressed, hidden: s.cell.hidden }],
    totalDisplay: s.cell.display
  }));
  const ariaLabel = 'Embudo del encuentro, acumulado desde siempre: ' + steps.map((s) => `${s.label} ${spoken(s.cell)}`).join(', ');
  return columnChart({ title: 'El embudo del encuentro (acumulado)', ariaLabel, groups });
}

module.exports = { dailyMatchesChart, dailyContactChart, contactByChannelChart, funnelChart, reunionFunnelChart };
