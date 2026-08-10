// Public-safe shaping of the `reporter` field on an `updates` row.
//
// `reporter` is free text: a name typed on the web form, or — via the
// WhatsApp bot (src/bot.js) — the reporter's raw phone number. It is stored
// for internal provenance/dedup, but it must NEVER leave the server on a
// public read path (public API responses, public HTML). This module is the
// single place that decides what a public viewer gets to see instead.

// Conservative contact detector: 7+ digits (a phone number, with or without
// separators/country code) or an "@" (an email address). Anything else is
// treated as a name.
function looksLikeContact(s) {
  if (/@/.test(s)) return true;
  const digitCount = (s.match(/\d/g) || []).length;
  return digitCount >= 7;
}

// "María Gómez, Cruz Roja" -> "María G." (first name + initial of the next
// word). A single word ("Hermana") is returned as-is.
function nameLabel(s) {
  const first = s.split(/[,·]/)[0].trim();
  if (!first) return 'Reporte ciudadano';
  const parts = first.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || 'Reporte ciudadano';
  return `${parts[0]} ${parts[1][0].toUpperCase()}.`;
}

function maskFreeText(s) {
  if (!s) return null;
  return looksLikeContact(s) ? 'Reporte ciudadano' : nameLabel(s);
}

// src/routes/web.js tags self-reports by appending this marker to whatever
// the reporter typed (or using it alone). It carries real signal — a
// first-hand report is stronger than a second-hand one — so it's worth
// preserving even though the rest of the string still gets masked.
const SELF_REPORT_MARKER = 'la propia persona';

// Public-safe label for an update's `reporter`. Returns null when there is
// nothing to show. NEVER returns the raw value verbatim when it looks like
// a phone number or email.
function maskReporter(reporter) {
  const raw = String(reporter ?? '').trim();
  if (!raw) return null;

  const isSelf = raw.toLowerCase().includes(SELF_REPORT_MARKER);
  if (!isSelf) return maskFreeText(raw);

  const rest = raw.replace(new RegExp(`\\s*[·\\-]?\\s*${SELF_REPORT_MARKER}`, 'i'), '').trim();
  const restLabel = maskFreeText(rest);
  return restLabel ? `${restLabel} (reporte propio)` : 'Reporte propio';
}

// Explicit public projection of an `updates` row for API responses. Every
// field is named on purpose — never spread the raw row — so a future column
// with contact info can't leak silently through a blanket copy.
function publicUpdate(u) {
  if (!u) return null;
  return {
    id: u.id,
    person_id: u.person_id,
    status: u.status,
    message: u.message,
    location: u.location,
    lat: u.lat,
    lng: u.lng,
    source: u.source,
    created_at: u.created_at,
    reporter_label: maskReporter(u.reporter)
  };
}

module.exports = { looksLikeContact, maskReporter, publicUpdate };
