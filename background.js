'use strict';

importScripts('shared.js'); // ajustes, catálogo de parámetros y utilidades comunes

/*
 * Strip Tracking — service worker.
 *
 * - La limpieza la hace declarativeNetRequest con UNA regla dinámica cuya lista
 *   de parámetros se construye a partir de los ajustes: estándar + riesgo activado
 *   (con variantes de mayúsculas) + propios (ver shared.js y params.json). Una sola
 *   regla evita que varias reglas de redirección compitan entre sí.
 * - Aquí también se gestionan las estadísticas locales y la insignia del icono.
 *
 * Privacidad: solo se guardan nombres de parámetro y hostname.
 * Nunca valores ni URLs completas. Nada sale del navegador.
 */

const PARAMS_RULE_ID = 1;
const ALLOW_RULE_BASE = 1000; // ids de las reglas dinámicas de excepción
const MAX_RECENT = 200;
const MAX_DOMAINS = 2000;
const MAX_DAYS = 400;
const MIDNIGHT_ALARM = 'midnight';

// Cola única: serializa lecturas/escrituras de storage y cambios de reglas.
let chain = Promise.resolve();
function enqueue(label, fn) {
  chain = chain.then(fn).catch((e) => console.error(`strip-tracking: error en «${label}»`, e));
  return chain;
}

/* ---------- reglas ---------- */

async function applyRules() {
  const [settings, catalog] = await Promise.all([getSettings(), loadCatalog()]);
  const dnr = chrome.declarativeNetRequest;
  const types = ['main_frame', 'sub_frame'];

  // Pausado: sin reglas (las excepciones por sitio dejan de tener sentido).
  const addRules = settings.enabled
    ? [
        {
          id: PARAMS_RULE_ID,
          priority: 1,
          action: {
            type: 'redirect',
            redirect: { transform: { queryTransform: { removeParams: [...buildMatcher(catalog, settings).keys()] } } },
          },
          condition: { requestMethods: ['get'], resourceTypes: types },
        },
        ...settings.allow.map((domain, i) => ({
          id: ALLOW_RULE_BASE + i,
          priority: 2,
          action: { type: 'allow' },
          condition: { requestDomains: [domain], resourceTypes: types },
        })),
      ]
    : [];

  const existing = await dnr.getDynamicRules();
  await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules });
}

/* ---------- detección (para las estadísticas) ---------- */

function extractTracked(urlString, matcher) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.search) return null;
  const found = [];
  for (const [name] of u.searchParams) {
    const canonical = matcher.get(name);
    if (canonical) found.push(canonical); // en estadísticas se agrupa por nombre canónico
  }
  if (!found.length) return null;
  return { host: u.hostname.replace(/^www\./, '').toLowerCase(), found };
}

/* ---------- estadísticas ---------- */

function emptyStats() {
  return { since: Date.now(), urls: 0, params: 0, byParam: {}, byDomain: {}, byDay: {}, recent: [] };
}

function normalizeStats(s) {
  const base = emptyStats();
  if (!s || typeof s !== 'object') return base;
  return {
    since: Number.isFinite(s.since) ? s.since : base.since,
    urls: Number(s.urls) || 0,
    params: Number(s.params) || 0,
    byParam: s.byParam && typeof s.byParam === 'object' ? s.byParam : {},
    byDomain: s.byDomain && typeof s.byDomain === 'object' ? s.byDomain : {},
    byDay: s.byDay && typeof s.byDay === 'object' ? s.byDay : {},
    recent: Array.isArray(s.recent) ? s.recent : [],
  };
}

function prune(stats) {
  const domains = Object.keys(stats.byDomain);
  if (domains.length > MAX_DOMAINS) {
    // Se conservan los más frecuentes; a igualdad, los vistos más recientemente
    // (así un dominio nuevo no queda expulsado siempre por los antiguos).
    const keep = domains
      .sort(
        (a, b) =>
          stats.byDomain[b].urls - stats.byDomain[a].urls ||
          (stats.byDomain[b].last || 0) - (stats.byDomain[a].last || 0)
      )
      .slice(0, MAX_DOMAINS);
    const next = {};
    for (const k of keep) next[k] = stats.byDomain[k];
    stats.byDomain = next;
  }
  const days = Object.keys(stats.byDay).sort();
  while (days.length > MAX_DAYS) delete stats.byDay[days.shift()];
  if (stats.recent.length > MAX_RECENT) stats.recent.length = MAX_RECENT;
}

function record(host, found) {
  return enqueue('guardar estadísticas', async () => {
    const { stats } = await chrome.storage.local.get('stats');
    const s = normalizeStats(stats);
    const now = Date.now();
    s.urls += 1;
    s.params += found.length;
    for (const p of found) s.byParam[p] = (s.byParam[p] || 0) + 1;
    const d = (s.byDomain[host] ||= { urls: 0, params: 0, last: 0 });
    d.urls += 1;
    d.params += found.length;
    d.last = now;
    const day = (s.byDay[dayKey()] ||= { urls: 0, params: 0 });
    day.urls += 1;
    day.params += found.length;
    s.recent.unshift({ t: now, host, params: [...new Set(found)] });
    prune(s);
    await chrome.storage.local.set({ stats: s });
  });
}

/* ---------- insignia ---------- */

async function updateBadge() {
  const [{ stats }, { enabled }] = await Promise.all([
    chrome.storage.local.get('stats'),
    getSettings(),
  ]);
  if (!enabled) {
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    await chrome.action.setBadgeText({ text: 'OFF' });
    return;
  }
  const n = stats?.byDay?.[dayKey()]?.urls || 0;
  await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  await chrome.action.setBadgeText({ text: n ? (n > 999 ? '999+' : String(n)) : '' });
}

// El contador de «hoy» debe reiniciarse a medianoche aunque no haya navegación.
function scheduleMidnight() {
  const next = new Date();
  next.setHours(24, 0, 5, 0);
  chrome.alarms.create(MIDNIGHT_ALARM, { when: next.getTime() });
}

/* ---------- eventos ---------- */

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  try {
    if (!details.url || !details.url.includes('?')) return;
    const [catalog, settings] = await Promise.all([loadCatalog(), getSettings()]);
    if (!settings.enabled) return;
    const { allow } = settings;
    const hit = extractTracked(details.url, buildMatcher(catalog, settings));
    if (!hit || isAllowed(hit.host, allow)) return;
    await record(hit.host, hit.found);
  } catch (e) {
    console.error('strip-tracking: error procesando navegación', e);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) enqueue('aplicar reglas', applyRules).then(updateBadge);
  else if (changes.stats) updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== MIDNIGHT_ALARM) return;
  scheduleMidnight();
  updateBadge();
});

function init() {
  scheduleMidnight();
  return enqueue('aplicar reglas', applyRules).then(updateBadge);
}

chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);
