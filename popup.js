'use strict';

const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat('es-ES');
const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const fmt = (n) => nf.format(n || 0);
const shortDay = (k) => `${k.slice(8, 10)}/${k.slice(5, 7)}`; // YYYY-MM-DD → dd/mm

const EMPTY = () => ({ since: null, urls: 0, params: 0, byParam: {}, byDomain: {}, byDay: {}, recent: [] });

let siteHost = null; // host de la pestaña activa (null si no es http/https)

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* ---------- ajustes ---------- */

let catalog = null; // params.json: { standard, risk }

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
  $('#enabledLabel').textContent = settings.enabled ? 'Activo' : 'Pausado';
  document.body.classList.toggle('off', !settings.enabled);

  // Excepción para el sitio actual
  const box = $('#siteBox');
  box.hidden = !siteHost;
  if (siteHost) {
    const covered = isAllowed(siteHost, settings.allow);
    const exact = settings.allow.includes(siteHost);
    $('#siteHost').textContent = siteHost;
    $('#siteHost').title = siteHost;
    const btn = $('#siteBtn');
    btn.disabled = !settings.enabled || (covered && !exact);
    btn.textContent = exact ? 'Volver a limpiar aquí' : covered ? 'Excluido por un dominio superior' : 'No limpiar en este sitio';
  }

  // Lista de excepciones
  const list = $('#allowList');
  list.replaceChildren();
  $('#allowBox').hidden = !settings.allow.length;
  for (const d of settings.allow) {
    const row = el('div', 'item');
    const name = el('span', 'h', d);
    name.title = d;
    const rm = el('button', 'icon', '✕');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Quitar la excepción de ${d}`);
    rm.addEventListener('click', () => saveSettings({ allow: settings.allow.filter((x) => x !== d) }));
    row.append(name, rm);
    list.append(row);
  }

  renderCustom(settings);
  renderRisk(settings);
}

/* ---------- parámetros propios ---------- */

function renderCustom(settings) {
  const list = $('#customList');
  list.replaceChildren();
  for (const p of settings.custom) {
    const row = el('div', 'item');
    const name = el('span', 'h mono', p);
    name.title = p;
    const rm = el('button', 'icon', '✕');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Dejar de eliminar el parámetro ${p}`);
    rm.addEventListener('click', () => saveSettings({ custom: settings.custom.filter((x) => x !== p) }));
    row.append(name, rm);
    list.append(row);
  }
}

function setMsg(text, bad) {
  const m = $('#customMsg');
  m.textContent = text || '';
  m.classList.toggle('bad', !!bad);
}

$('#customForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#customInput');
  // Admite que se pegue «?foo=bar» o «foo=bar»: se queda con el nombre.
  const name = input.value.trim().replace(/^[?&]+/, '').split('=')[0];
  const cur = await getSettings();
  if (!name) return;
  if (!validParamName(name)) return setMsg('Nombre no válido: sin espacios ni caracteres como = & # ? % +', true);
  if (catalog.standard.some((n) => caseVariants(n).has(name))) return setMsg(`«${name}» ya está cubierto por la lista estándar (también en mayúsculas).`, true);
  if (catalog.risk.some((r) => caseVariants(r.name).has(name))) return setMsg(`«${name}» está en el grupo de riesgo: actívalo ahí.`, true);
  if (cur.custom.includes(name)) return setMsg(`«${name}» ya está añadido.`, true);
  if (cur.custom.length >= MAX_CUSTOM) return setMsg(`Máximo ${MAX_CUSTOM} parámetros propios.`, true);
  await saveSettings({ custom: [...cur.custom, name] });
  input.value = '';
  setMsg(`«${name}» añadido.`);
});

/* ---------- grupo de riesgo ---------- */

let riskBuilt = false;
function renderRisk(settings) {
  const on = new Set(settings.risk);
  $('#riskCount').textContent = `(${on.size} de ${catalog.risk.length} activados)`;
  const list = $('#riskList');
  if (!riskBuilt) {
    // Se construye una sola vez; luego solo se sincronizan las casillas (no se pierde el foco).
    riskBuilt = true;
    for (const r of catalog.risk) {
      const label = el('label', 'risk');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.dataset.name = r.name;
      cb.addEventListener('change', async () => {
        const cur = new Set((await getSettings()).risk);
        cb.checked ? cur.add(r.name) : cur.delete(r.name);
        await saveSettings({ risk: [...cur] });
      });
      const text = el('span');
      text.append(el('b', 'mono', r.name), el('small', null, r.reason));
      label.append(cb, text);
      list.append(label);
    }
  }
  for (const cb of list.querySelectorAll('input')) cb.checked = on.has(cb.dataset.name);
}

/* ---------- estadísticas ---------- */

function topList(container, entries, valueOf, labelOf) {
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

function renderStats(stats) {
  const s = { ...EMPTY(), ...(stats || {}) };

  // Tarjetas
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
    [fmt(today.urls), 'URLs hoy'],
    [fmt(week), 'URLs 7 días'],
    [fmt(s.urls), 'URLs totales'],
    [fmt(s.params), 'Parámetros eliminados'],
    [avg, 'Parámetros por URL'],
    [fmt(Object.keys(s.byDomain).length), 'Dominios distintos'],
  ];
  const cardsEl = $('#cards');
  cardsEl.replaceChildren();
  for (const [v, l] of cards) {
    const c = el('div', 'card');
    c.append(el('b', null, v), el('span', null, l));
    cardsEl.append(c);
  }
  $('#since').textContent = s.since ? 'desde ' + new Date(s.since).toLocaleDateString('es-ES') : '';

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

  // Rankings
  topList(
    $('#topParams'),
    Object.entries(s.byParam).sort((a, b) => b[1] - a[1]).slice(0, 10),
    (e) => e[1],
    (e) => e[0]
  );
  topList(
    $('#topDomains'),
    Object.entries(s.byDomain).sort((a, b) => b[1].urls - a[1].urls).slice(0, 10),
    (e) => e[1].urls,
    (e) => e[0]
  );

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

async function load() {
  const { stats } = await chrome.storage.local.get('stats');
  renderStats(stats);
  catalog = await loadCatalog();
  renderSettings(await getSettings());
}

/* ---------- exportación ---------- */

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
  download(
    'strip-tracking-stats.csv',
    '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n'),
    'text/csv;charset=utf-8'
  );
});

/* ---------- acciones ---------- */

$('#enabled').addEventListener('change', (e) => saveSettings({ enabled: e.target.checked }));

$('#siteBtn').addEventListener('click', async () => {
  if (!siteHost) return;
  const { allow } = await getSettings();
  await saveSettings({
    allow: allow.includes(siteHost) ? allow.filter((d) => d !== siteHost) : [...allow, siteHost],
  });
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('¿Borrar todas las estadísticas? Esta acción no se puede deshacer.')) return;
  await chrome.storage.local.remove('stats');
  await load();
});

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.stats || c.settings)) load();
});

currentHost().then((h) => {
  siteHost = h;
  return load();
});
