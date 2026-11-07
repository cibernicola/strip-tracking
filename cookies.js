'use strict';

/*
 * Borrado automático de cookies (opcional, desactivado por defecto).
 *
 * - «Al dejar de usar un sitio»: cuando se cierra la última pestaña de un sitio (o se navega a otro),
 *   se espera `delayMin` minutos y se borran las cookies que ese sitio enviaría, salvo que otra pestaña
 *   abierta las siga usando o que estén en la lista blanca.
 * - «Al iniciar el navegador»: pasado un minuto (para dar tiempo a que se restauren las pestañas), se borra
 *   todo lo que no esté en la lista ni lo use una pestaña abierta.
 * - «Borrar ahora» (botón del popup): lo mismo que al iniciar, a petición.
 *
 * La pausa global de la extensión (`enabled: false`) detiene los dos modos automáticos.
 * Las pestañas de incógnito no se siguen: el navegador borra sus cookies al cerrarlas.
 *
 * Privacidad: solo se guarda cuántas cookies se borran por dominio y por día; nunca nombres ni valores de cookies.
 * Se usa storage.session para recordar qué host tiene cada pestaña, porque el service worker se duerme.
 */

const SWEEP_ALARM = 'cookie-sweep';
const STARTUP_ALARM = 'cookie-startup';
const STARTUP_DELAY_MIN = 1;
const COOKIE_MAX_DOMAINS = 500;
const COOKIE_MAX_DAYS = 400;

// Cola propia: serializa seguimiento de pestañas y borrados.
let ckChain = Promise.resolve();
function ckEnqueue(label, fn) {
  const run = ckChain.then(fn);
  ckChain = run.catch((e) => console.error(`strip-tracking: error en «${label}»`, e));
  return run.catch(() => null);
}

// Como ckEnqueue, pero devuelve { ok, value } o { ok: false, error } para poder informar al popup.
function ckCall(label, fn) {
  const run = ckChain.then(fn);
  ckChain = run.catch((e) => console.error(`strip-tracking: error en «${label}»`, e));
  return run.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: String(error?.message || error) })
  );
}

const sessionGet = async (key, def) => (await chrome.storage.session.get(key))[key] ?? def;

// Hostname completo (sin quitar www.): importa para decidir qué cookies se envían a qué pestaña.
function hostOf(url) {
  try {
    const u = new URL(url || '');
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/* ---------- seguimiento de pestañas ---------- */

async function rebuildTabs() {
  const tabs = await chrome.tabs.query({});
  const map = {};
  for (const t of tabs) {
    if (t.incognito) continue; // el navegador ya borra las cookies de incógnito al cerrar
    const h = hostOf(t.url || t.pendingUrl);
    if (h) map[t.id] = h;
  }
  await chrome.storage.session.set({ tabHosts: map });
}

async function trackTab(tabId, newHost) {
  const map = await sessionGet('tabHosts', {});
  const old = map[tabId];
  if (newHost) map[tabId] = newHost;
  else delete map[tabId];
  await chrome.storage.session.set({ tabHosts: map });
  if (old && old !== newHost) await scheduleSweep(old);
}

async function scheduleSweep(host) {
  const { enabled, cookies } = await getSettings();
  if (!enabled || !cookies.onClose) return;
  const pending = await sessionGet('pending', {});
  pending[host] = Date.now() + cookies.delayMin * 60000;
  await chrome.storage.session.set({ pending });
  chrome.alarms.create(SWEEP_ALARM, { when: Math.min(...Object.values(pending)) });
}

/* ---------- borrado ---------- */

function cookieUrl(c, domain) {
  return (c.secure ? 'https://' : 'http://') + domain + c.path;
}

/*
 * hosts = lista de hosts cuyas cookies se pueden borrar, o null para «todas».
 * dryRun = true: solo cuenta lo que se borraría, sin borrar nada (vista previa).
 * Una cookie NO se borra si: la usa una pestaña abierta de su mismo almacén, o está en la lista blanca.
 * Devuelve { count: cookies afectadas, sites: dominios afectados }.
 */
async function sweep(hosts, dryRun = false) {
  if (!chrome.cookies) return { count: 0, sites: 0 }; // permiso retirado
  const { cookies: cfg } = await getSettings();
  const [stores, tabs] = await Promise.all([chrome.cookies.getAllCookieStores(), chrome.tabs.query({})]);
  const hostByTab = new Map(tabs.map((t) => [t.id, hostOf(t.url || t.pendingUrl)]));
  const found = {}; // dominio → nº de cookies borradas (o que se borrarían)

  for (const store of stores) {
    const open = (store.tabIds || []).map((id) => hostByTab.get(id)).filter(Boolean);
    const list = await chrome.cookies.getAll({ storeId: store.id });
    for (const c of list) {
      const domain = c.domain.replace(/^\./, '').toLowerCase();
      if (hosts && !hosts.some((h) => domainMatch(h, domain))) continue; // no es de los sitios cerrados
      if (open.some((h) => domainMatch(h, domain))) continue; // sigue en uso
      if (cfg.keep.some((k) => related(k, domain))) continue; // lista blanca
      if (dryRun) {
        found[domain] = (found[domain] || 0) + 1;
        continue;
      }
      const res = await chrome.cookies.remove({
        url: cookieUrl(c, domain),
        name: c.name,
        storeId: store.id,
        ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
      });
      if (res) found[domain] = (found[domain] || 0) + 1;
    }
  }
  const count = Object.values(found).reduce((a, b) => a + b, 0);
  if (!dryRun && count) await recordCookieStats(found, count);
  return { count, sites: Object.keys(found).length };
}

/* ---------- estadísticas (solo recuentos) ---------- */

async function recordCookieStats(removed, total) {
  const { cookieStats } = await chrome.storage.local.get('cookieStats');
  const s = {
    since: Number.isFinite(cookieStats?.since) ? cookieStats.since : Date.now(),
    total: Number(cookieStats?.total) || 0,
    byDomain: cookieStats?.byDomain && typeof cookieStats.byDomain === 'object' ? cookieStats.byDomain : {},
    byDay: cookieStats?.byDay && typeof cookieStats.byDay === 'object' ? cookieStats.byDay : {},
  };
  s.total += total;
  for (const [d, n] of Object.entries(removed)) s.byDomain[d] = (s.byDomain[d] || 0) + n;
  const day = dayKey();
  s.byDay[day] = (s.byDay[day] || 0) + total;

  const domains = Object.keys(s.byDomain);
  if (domains.length > COOKIE_MAX_DOMAINS) {
    const keep = domains.sort((a, b) => s.byDomain[b] - s.byDomain[a]).slice(0, COOKIE_MAX_DOMAINS);
    s.byDomain = Object.fromEntries(keep.map((k) => [k, s.byDomain[k]]));
  }
  const days = Object.keys(s.byDay).sort();
  while (days.length > COOKIE_MAX_DAYS) delete s.byDay[days.shift()];
  await chrome.storage.local.set({ cookieStats: s });
}

/* ---------- eventos ---------- */

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const host = tab?.incognito ? null : hostOf(changeInfo.url);
  ckEnqueue('pestaña actualizada', () => trackTab(tabId, host));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ckEnqueue('pestaña cerrada', () => trackTab(tabId, null));
});

chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  ckEnqueue('pestaña reemplazada', async () => {
    const map = await sessionGet('tabHosts', {});
    if (map[removedId]) map[addedId] = map[removedId];
    delete map[removedId];
    await chrome.storage.session.set({ tabHosts: map });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) {
    ckEnqueue('borrado diferido', async () => {
      const pending = await sessionGet('pending', {});
      const now = Date.now();
      const due = [];
      const rest = {};
      for (const [host, at] of Object.entries(pending)) (at <= now ? due.push(host) : (rest[host] = at));
      await chrome.storage.session.set({ pending: rest });
      const left = Object.values(rest);
      if (left.length) chrome.alarms.create(SWEEP_ALARM, { when: Math.min(...left) });
      const { enabled, cookies } = await getSettings();
      if (enabled && cookies.onClose && due.length) await sweep(due);
    });
  } else if (alarm.name === STARTUP_ALARM) {
    ckEnqueue('barrido de inicio', async () => {
      await rebuildTabs(); // vuelve a mirar las pestañas, ya restauradas
      const { enabled, cookies } = await getSettings();
      if (enabled && cookies.onStartup) await sweep(null);
    });
  }
});

// Al iniciar el navegador (no al instalar o recargar la extensión, para no sorprender).
// El barrido se retrasa un minuto: la restauración de la sesión puede terminar después de arrancar la extensión.
chrome.runtime.onStartup.addListener(() => {
  ckEnqueue('inicio', async () => {
    await chrome.storage.session.set({ pending: {} });
    await rebuildTabs();
    const { enabled, cookies } = await getSettings();
    if (enabled && cookies.onStartup) chrome.alarms.create(STARTUP_ALARM, { delayInMinutes: STARTUP_DELAY_MIN });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  ckEnqueue('instalación', rebuildTabs);
});

// Desde el popup: «cookies-preview» (cuenta sin borrar) y «cookies-sweep-now» (borra).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const dry = msg?.type === 'cookies-preview';
  if (!dry && msg?.type !== 'cookies-sweep-now') return;
  ckCall(dry ? 'vista previa' : 'borrar ahora', async () => {
    await rebuildTabs();
    return sweep(null, dry);
  }).then((r) => sendResponse(r.ok ? { count: r.value.count, sites: r.value.sites } : { error: r.error }));
  return true; // respuesta asíncrona
});
