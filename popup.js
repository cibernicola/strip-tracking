'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const nf = new Intl.NumberFormat('es-ES');
const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const fmt = (n) => nf.format(n || 0);
const shortDay = (k) => `${k.slice(8, 10)}/${k.slice(5, 7)}`; // YYYY-MM-DD → dd/mm

const EMPTY = () => ({ since: null, urls: 0, params: 0, byParam: {}, byDomain: {}, byDay: {}, recent: [] });

let siteHost = null; // host de la pestaña activa (null si no es http/https)
let catalog = null; // params.json: { standard, risk }
let lastStats = EMPTY();
let cookieStats = null;
let rank = 'params';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function chip(text, onRemove, removeLabel, mono) {
  const c = el('span', 'chip' + (mono ? ' mono' : ''));
  const t = el('span', 't', text);
  t.title = text;
  const x = el('button', 'x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', removeLabel);
  x.addEventListener('click', onRemove);
  c.append(t, x);
  return c;
}

function fillChips(container, items, build, emptyText) {
  container.replaceChildren();
  if (!items.length) container.append(el('p', 'empty', emptyText));
  for (const it of items) container.append(build(it));
}

function setMsg(sel, text, bad) {
  const m = $(sel);
  m.textContent = text || '';
  m.classList.toggle('bad', !!bad);
}

/* ---------- pestañas ---------- */

const TABS = ['overview', 'params', 'cookies', 'data'];

function selectTab(name, focus) {
  if (!TABS.includes(name)) name = 'overview';
  for (const b of $$('.tab')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  for (const p of $$('.panel')) p.hidden = p.id !== 'tab-' + name;
  $('main').scrollTop = 0;
  try {
    localStorage.setItem('tab', name);
  } catch {}
}

for (const b of $$('.tab')) {
  b.addEventListener('click', () => selectTab(b.dataset.tab));
  b.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(b.dataset.tab);
    if (e.key === 'ArrowRight') selectTab(TABS[(i + 1) % TABS.length], true);
    else if (e.key === 'ArrowLeft') selectTab(TABS[(i + TABS.length - 1) % TABS.length], true);
    else return;
    e.preventDefault();
  });
}

/* ---------- ajustes ---------- */

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
}

async function currentHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab?.url || '');
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

function renderSettings(settings) {
  $('#enabled').checked = settings.enabled;
  $('#status').textContent = settings.enabled ? '● ACTIVO' : '○ PAUSADO';
  document.body.classList.toggle('off', !settings.enabled);

  renderSite(settings);

  // Excepciones de limpieza de URLs
  $('#allowCount').textContent = settings.allow.length ? String(settings.allow.length) : '';
  fillChips(
    $('#allowList'),
    settings.allow,
    (d) => chip(d, () => saveSettings({ allow: settings.allow.filter((x) => x !== d) }), `Quitar la excepción de ${d}`),
    'Ninguno todavía.'
  );

  // Parámetros propios
  $('#customCount').textContent = settings.custom.length ? String(settings.custom.length) : '';
  fillChips(
    $('#customList'),
    settings.custom,
    (p) => chip(p, () => saveSettings({ custom: settings.custom.filter((x) => x !== p) }), `Dejar de eliminar el parámetro ${p}`, true),
    'Ninguno todavía.'
  );

  renderRisk(settings);
  renderCookies(settings);
}

/* Tarjeta del sitio actual: dos interruptores rápidos */
function renderSite(settings) {
  const box = $('#siteBox');
  box.hidden = !siteHost;
  if (!siteHost) return;
  $('#siteHost').textContent = siteHost;
  $('#siteHost').title = siteHost;

  const covered = isAllowed(siteHost, settings.allow);
  const exact = settings.allow.includes(siteHost);
  const urlBtn = $('#siteBtn');
  urlBtn.classList.toggle('on', !covered);
  urlBtn.disabled = !settings.enabled || (covered && !exact);
  urlBtn.textContent = covered ? (exact ? 'URLs · sin limpiar' : 'URLs · excluido (padre)') : 'URLs · limpiando';
  urlBtn.title = exact ? 'Volver a limpiar las URLs de este sitio' : covered ? 'Excluido por un dominio superior' : 'No limpiar las URLs de este sitio';

  const c = settings.cookies;
  const kcovered = c.keep.some((k) => related(k, siteHost));
  const kexact = c.keep.includes(siteHost);
  const ckBtn = $('#ckSiteBtn');
  ckBtn.classList.toggle('on', kcovered);
  ckBtn.disabled = kcovered && !kexact;
  ckBtn.textContent = kcovered ? 'Cookies · protegidas' : 'Cookies · se borran';
  ckBtn.title = kexact ? 'Dejar de mantener las cookies de este sitio' : kcovered ? 'Cubierto por otro dominio de la lista blanca' : 'Mantener las cookies de este sitio';
}

$('#enabled').addEventListener('change', (e) => saveSettings({ enabled: e.target.checked }));

$('#siteBtn').addEventListener('click', async () => {
  if (!siteHost) return;
  const { allow } = await getSettings();
  await saveSettings({ allow: allow.includes(siteHost) ? allow.filter((d) => d !== siteHost) : [...allow, siteHost] });
});

/* ---------- parámetros propios ---------- */

$('#customForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#customInput');
  // Admite que se pegue «?foo=bar» o «foo=bar»: se queda con el nombre.
  const name = input.value.trim().replace(/^[?&]+/, '').split('=')[0];
  const cur = await getSettings();
  if (!name) return;
  if (!validParamName(name)) return setMsg('#customMsg', 'Nombre no válido: sin espacios ni caracteres como = & # ? % +', true);
  if (catalog.standard.some((n) => caseVariants(n).has(name))) return setMsg('#customMsg', `«${name}» ya está cubierto por la lista estándar (también en mayúsculas).`, true);
  if (catalog.risk.some((r) => caseVariants(r.name).has(name))) return setMsg('#customMsg', `«${name}» está en el grupo de riesgo: actívalo ahí.`, true);
  if (cur.custom.includes(name)) return setMsg('#customMsg', `«${name}» ya está añadido.`, true);
  if (cur.custom.length >= MAX_CUSTOM) return setMsg('#customMsg', `Máximo ${MAX_CUSTOM} parámetros propios.`, true);
  await saveSettings({ custom: [...cur.custom, name] });
  input.value = '';
  setMsg('#customMsg', `«${name}» añadido.`);
});

/* ---------- grupo de riesgo ---------- */

let riskBuilt = false;
function renderRisk(settings) {
  const on = new Set(settings.risk);
  $('#riskCount').textContent = `${on.size}/${catalog.risk.length}`;
  const list = $('#riskList');
  if (!riskBuilt) {
    // Se construye una sola vez; luego solo se sincronizan los interruptores (no se pierde el foco).
    riskBuilt = true;
    for (const r of catalog.risk) {
      const row = el('label', 'riskrow');
      const sw = el('span', 'switch');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.setAttribute('role', 'switch');
      cb.dataset.name = r.name;
      cb.addEventListener('change', async () => {
        const cur = new Set((await getSettings()).risk);
        cb.checked ? cur.add(r.name) : cur.delete(r.name);
        await saveSettings({ risk: [...cur] });
      });
      sw.append(cb, el('span', 'track'));
      const text = el('span');
      text.append(el('b', null, r.name), el('small', null, r.reason));
      row.append(sw, text);
      list.append(row);
    }
  }
  for (const cb of list.querySelectorAll('input')) cb.checked = on.has(cb.dataset.name);
}

/* ---------- cookies ---------- */

// Cualquier cambio de la lista la marca como editada por el usuario (deja de aplicarse la de por defecto).
const saveKeep = (keep) => saveCookies({ keep, keepEdited: true });

async function saveCookies(patch) {
  const cur = await getSettings();
  await saveSettings({ cookies: { ...cur.cookies, ...patch } });
}

function renderCookies(settings) {
  const c = settings.cookies;
  $('#ckClose').checked = c.onClose;
  $('#ckStartup').checked = c.onStartup;
  const seg = $('#ckDelaySeg');
  seg.classList.toggle('off', !c.onClose);
  for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.min) === c.delayMin));

  const modes = [c.onClose && 'al cerrar sitios', c.onStartup && 'al iniciar'].filter(Boolean);
  $('#cookieState').textContent = modes.length ? modes.join(' + ') : 'desactivado';
  const tab = $('#t-cookies');
  if (modes.length) tab.dataset.on = '';
  else delete tab.dataset.on;

  $('#ckPaused').hidden = settings.enabled;
  $('#ckKeepCount').textContent = String(c.keep.length);
  fillChips(
    $('#ckKeepList'),
    c.keep,
    (d) => chip(d, () => saveKeep(c.keep.filter((x) => x !== d)), `Dejar de mantener las cookies de ${d}`),
    'La lista está vacía: se borrarían las cookies de todos los sitios.'
  );
  $('#ckReset').hidden = !c.keepEdited;

  const total = cookieStats?.total || 0;
  const today = cookieStats?.byDay?.[dayKey()] || 0;
  $('#ckTotal').textContent = fmt(total);
  $('#ckToday').textContent = total ? `${fmt(today)} hoy` : 'aún ninguna';
}

// Vista previa de lo que se borraría ahora mismo (el service worker cuenta sin borrar). null si falla.
async function cookiePreview() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'cookies-preview' });
    return r && !r.error ? r : null;
  } catch {
    return null;
  }
}

// Activar un modo de borrado automático es destructivo: se explica y se muestra la exposición actual antes de aceptar.
async function toggleCookieMode(key, input) {
  if (!input.checked) return saveCookies({ [key]: false });
  const prev = await cookiePreview();
  const what =
    key === 'onClose'
      ? 'Cuando dejes de usar un sitio se borrarán sus cookies, pasado el tiempo de espera.'
      : 'Al iniciar el navegador se borrarán las cookies de todo lo que no esté en la lista blanca.';
  const exposure = prev
    ? `

Ahora mismo hay ${fmt(prev.count)} cookies de ${fmt(prev.sites)} dominios fuera de la lista blanca y sin pestaña abierta.`
    : '';
  if (!confirm(`${what}${exposure}

Se cerrará la sesión en esos sitios y no se puede deshacer. ¿Activar?`)) {
    input.checked = false;
    return;
  }
  await saveCookies({ [key]: true });
}

$('#ckClose').addEventListener('change', (e) => toggleCookieMode('onClose', e.target));
$('#ckStartup').addEventListener('change', (e) => toggleCookieMode('onStartup', e.target));
for (const b of $$('#ckDelaySeg button')) b.addEventListener('click', () => saveCookies({ delayMin: Number(b.dataset.min) }));

$('#ckSiteBtn').addEventListener('click', async () => {
  if (!siteHost) return;
  const { keep } = (await getSettings()).cookies;
  await saveKeep(keep.includes(siteHost) ? keep.filter((d) => d !== siteHost) : [...keep, siteHost]);
});

$('#ckForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#ckInput');
  if (!input.value.trim()) return;
  const host = parseHostInput(input.value);
  if (!host) return setMsg('#ckMsg', 'Dominio no válido. Ejemplo: github.com', true);
  const { keep } = (await getSettings()).cookies;
  if (keep.includes(host)) return setMsg('#ckMsg', `«${host}» ya está en la lista.`, true);
  if (keep.length >= MAX_KEEP) return setMsg('#ckMsg', `Máximo ${MAX_KEEP} dominios.`, true);
  await saveKeep([...keep, host]);
  input.value = '';
  setMsg('#ckMsg', `«${host}» añadido: se mantienen sus cookies y las de sus subdominios.`);
});

$('#ckReset').addEventListener('click', () => {
  if (confirm('¿Restaurar la lista blanca por defecto? Se perderán tus cambios en la lista.')) {
    saveCookies({ keep: [...catalog.defaultKeep], keepEdited: false });
  }
});

$('#ckNow').addEventListener('click', async () => {
  const btn = $('#ckNow');
  btn.disabled = true;
  try {
    const prev = await cookiePreview();
    if (!prev) return setMsg('#ckNowMsg', 'No se pudo calcular qué se borraría.', true);
    if (!prev.count) return setMsg('#ckNowMsg', 'No hay nada que borrar.');
    if (!confirm(`Se borrarán ${fmt(prev.count)} cookies de ${fmt(prev.sites)} dominios que no están en la lista blanca ni tienen una pestaña abierta. Se cerrará la sesión en ellos y no se puede deshacer. ¿Continuar?`)) return;
    const res = await chrome.runtime.sendMessage({ type: 'cookies-sweep-now' });
    if (res?.error) throw new Error(res.error);
    setMsg('#ckNowMsg', `Borradas ahora: ${fmt(res?.count)}.`);
  } catch (e) {
    setMsg('#ckNowMsg', `No se pudo completar el borrado${e?.message ? ': ' + e.message : '.'}`, true);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- estadísticas ---------- */

function rankList(container, entries, valueOf, labelOf) {
  container.replaceChildren();
  if (!entries.length) {
    container.append(el('p', 'empty', 'Sin datos todavía.'));
    return;
  }
  const max = Math.max(...entries.map(valueOf));
  for (const e of entries) {
    const row = el('div', 'row');
    const label = el('span', 'label', labelOf(e));
    label.title = labelOf(e);
    const bar = el('span', 'bar');
    const fill = el('i');
    fill.style.width = (valueOf(e) / max) * 100 + '%';
    bar.append(fill);
    row.append(label, bar, el('span', 'val', fmt(valueOf(e))));
    container.append(row);
  }
}

function renderRank() {
  const s = lastStats;
  for (const b of $$('[data-rank]')) b.setAttribute('aria-pressed', String(b.dataset.rank === rank));
  if (rank === 'params') {
    rankList($('#rankList'), Object.entries(s.byParam).sort((a, b) => b[1] - a[1]).slice(0, 8), (e) => e[1], (e) => e[0]);
  } else {
    rankList($('#rankList'), Object.entries(s.byDomain).sort((a, b) => b[1].urls - a[1].urls).slice(0, 8), (e) => e[1].urls, (e) => e[0]);
  }
}

for (const b of $$('[data-rank]')) {
  b.addEventListener('click', () => {
    rank = b.dataset.rank;
    renderRank();
  });
}

function renderStats(stats) {
  const s = { ...EMPTY(), ...(stats || {}) };
  lastStats = s;

  const today = s.byDay[dayKey(new Date())] || { urls: 0, params: 0 };
  const days = [];
  let week = 0;
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = dayKey(d);
    const v = s.byDay[k] || { urls: 0, params: 0 };
    days.push([k, v]);
    if (i < 7) week += v.urls;
  }
  const avg = s.urls ? nf1.format(s.params / s.urls) : '0';
  const cards = [
    [fmt(today.urls), 'URLs hoy', 'hero'],
    [fmt(week), 'URLs · 7 días', ''],
    [fmt(s.urls), 'URLs totales', ''],
    [fmt(s.params), 'Parámetros quitados', 'mini'],
    [avg, 'Parámetros por URL', 'mini'],
    [fmt(Object.keys(s.byDomain).length), 'Dominios distintos', 'mini'],
  ];
  const cardsEl = $('#cards');
  cardsEl.replaceChildren();
  for (const [v, l, cls] of cards) {
    const c = el('div', 'kpi' + (cls ? ' ' + cls : ''));
    c.append(el('b', null, v), el('span', null, l));
    cardsEl.append(c);
  }
  $('#since').textContent = s.since ? '· desde ' + new Date(s.since).toLocaleDateString('es-ES') : '';

  // Gráfico de 14 días
  const chart = $('#chart');
  chart.replaceChildren();
  const total14 = days.reduce((n, [, v]) => n + v.urls, 0);
  chart.setAttribute('aria-label', `URLs limpiadas en los últimos 14 días: ${fmt(total14)}`);
  const maxDay = Math.max(1, ...days.map(([, v]) => v.urls));
  for (const [k, v] of days) {
    const col = el('div', 'col' + (v.urls ? '' : ' zero'));
    col.title = `${shortDay(k)}: ${fmt(v.urls)} URLs, ${fmt(v.params)} parámetros`;
    const bar = el('i');
    bar.style.height = (v.urls / maxDay) * 100 + '%';
    col.append(bar);
    chart.append(col);
  }
  $('#axisStart').textContent = shortDay(days[0][0]);

  renderRank();

  // Reciente
  const recent = $('#recent');
  recent.replaceChildren();
  if (!s.recent.length) recent.append(el('p', 'empty', 'Sin actividad todavía.'));
  for (const r of s.recent.slice(0, 15)) {
    const it = el('div', 'item');
    const t = new Date(r.t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const p = el('span', 'p', r.params.join(', '));
    p.title = r.params.join(', ');
    const h = el('span', 'h', r.host);
    h.title = r.host;
    it.append(el('span', 't', t), h, p);
    recent.append(it);
  }
}

/* ---------- carga ---------- */

function showError(e) {
  console.error('strip-tracking popup:', e);
  const box = $('#loadErr');
  box.textContent = `Error al mostrar el popup: ${e?.message || e}`;
  box.hidden = false;
}

async function load() {
  try {
    const { stats, cookieStats: ck } = await chrome.storage.local.get(['stats', 'cookieStats']);
    cookieStats = ck || null;
    renderStats(stats);
    catalog = await loadCatalog();
    renderSettings(await getSettings());
    $('#loadErr').hidden = true;
  } catch (e) {
    showError(e);
  }
}

$('#ver').textContent = `Strip Tracking v${chrome.runtime.getManifest().version}`;

/* ---------- exportación y reinicio ---------- */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

$('#exportJson').addEventListener('click', async () => {
  const { stats } = await chrome.storage.local.get('stats');
  download('strip-tracking-stats.json', JSON.stringify(stats || {}, null, 2), 'application/json');
});

$('#exportCsv').addEventListener('click', async () => {
  const { stats } = await chrome.storage.local.get('stats');
  const s = { ...EMPTY(), ...(stats || {}) };
  const rows = [['tipo', 'clave', 'urls', 'parametros']];
  for (const [k, v] of Object.entries(s.byDay).sort()) rows.push(['dia', k, v.urls, v.params]);
  for (const [k, v] of Object.entries(s.byDomain)) rows.push(['dominio', k, v.urls, v.params]);
  for (const [k, v] of Object.entries(s.byParam)) rows.push(['parametro', k, '', v]);
  // BOM + «;» para que Excel (configuración regional española) lo abra bien.
  download('strip-tracking-stats.csv', '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('¿Borrar todas las estadísticas? Esta acción no se puede deshacer.')) return;
  await chrome.storage.local.remove(['stats', 'cookieStats']);
  await load();
});

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.stats || c.settings || c.cookieStats)) load();
});

let startTab = 'overview';
try {
  startTab = localStorage.getItem('tab') || startTab;
} catch {}
selectTab(startTab);

currentHost().then((h) => {
  siteHost = h;
  return load();
});
