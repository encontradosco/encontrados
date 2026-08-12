// Files the site's ideas and bug reports as GitHub issues.
//
// The alternative — pointing the footer links straight at GitHub's "new issue"
// page — puts a signup wall between us and the report. The people who notice
// that a photo never loads on their phone are the ones least likely to have a
// GitHub account, and they are exactly the reports worth having. So the form
// lives on the site and we file the issue on their behalf.
// Loading ./env for its side effect: it merges any .env file INTO process.env,
// which is why everything below reads process.env directly instead of the
// module's frozen snapshot. That matters twice — a serverless instance built
// before a variable was set still sees it, and a test can UNSET one to
// exercise the unconfigured path. Falling back to the snapshot would make
// "not configured" impossible to reach, and a suite that cannot simulate a
// missing token is a suite that files its fixtures as real issues.
require('./env');

const DEFAULT_REPO = 'encontradosco/encontrados';

// Overridable the same way SENDGRID_API_BASE is, so the tests exercise the
// real "issue actually filed" path instead of only the failure path.
function apiBase() {
  return process.env.GITHUB_API_BASE || 'https://api.github.com';
}

function repo() {
  return (process.env.GITHUB_REPO || DEFAULT_REPO).trim();
}

function token() {
  return (process.env.GITHUB_TOKEN || '').trim();
}

function issuesUrl() {
  return `https://github.com/${repo()}/issues`;
}

// Link for someone who already has a GitHub account and would rather file it
// themselves — offered alongside the form, never instead of it.
function newIssueUrl(labels) {
  const q = labels && labels.length ? `?labels=${encodeURIComponent(labels.join(','))}` : '';
  return `https://github.com/${repo()}/issues/new${q}`;
}

function configured() {
  return !!(token() && repo());
}

async function post(path, body) {
  return fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'encontrados.co'
    },
    body: JSON.stringify(body)
  });
}

// Returns { ok, url, number } or { ok: false, error }. Never throws: the
// caller has a fallback that must run, and an exception here would turn a
// perfectly good bug report into a 500.
async function createIssue({ title, body, labels = [] }) {
  if (!configured()) {
    return { ok: false, error: 'GITHUB_TOKEN/GITHUB_REPO no configurados' };
  }
  const path = `/repos/${repo()}/issues`;
  try {
    let res = await post(path, { title, body, labels });
    // A label that doesn't exist in the repo is rejected as 422. The label is
    // a nicety; the report is not — drop it and file the issue anyway.
    if (res.status === 422 && labels.length) {
      console.warn(`[github] etiqueta(s) ${labels.join(',')} rechazada(s) — reintentando sin etiquetas`);
      res = await post(path, { title, body });
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      console.error(`[github] FALLÓ ${res.status} repo=${repo()} :: ${text}`);
      return { ok: false, status: res.status, error: text };
    }
    const issue = await res.json();
    console.log(`[github] issue #${issue.number} creado: ${issue.html_url}`);
    return { ok: true, url: issue.html_url, number: issue.number };
  } catch (e) {
    console.error('[github] THREW', e);
    return { ok: false, error: e.message };
  }
}

module.exports = { createIssue, configured, issuesUrl, newIssueUrl, repo };
