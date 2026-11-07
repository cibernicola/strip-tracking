'use strict';

/*
 * Código común al service worker (importScripts) y al popup (<script>).
 * Solo define constantes y funciones puras; no toca el estado de la extensión.
 */

const MAX_ALLOW = 500;
const MAX_CUSTOM = 200;
const MAX_KEEP = 500;
const COOKIE_DELAYS = [1, 5, 15, 60]; // minutos de espera antes de borrar

// Cookies que se mantienen mientras el usuario no edite la lista (después manda la suya, aunque quede vacía).
// Lista neutra: solo proveedores de inicio de sesión muy extendidos. accounts.google.com protege también las
// cookies de .google.com, de las que dependen YouTube, Gmail, etc.
// Una lista personal por defecto puede ir en local-defaults.json (excluido de git; ver local-defaults.example.json).
const DEFAULT_COOKIE_KEEP = Object.freeze([
  'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'github.com',
]);

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // hora local

// Nombre de parámetro válido: sin espacios ni caracteres con significado en una URL.
const PARAM_RE = /^[^\s=&#?%+]{1,100}$/;
const validParamName = (s) => typeof s === 'string' && PARAM_RE.test(s);

const isAllowed = (host, allow) => allow.some((d) => host === d || host.endsWith('.' + d));

// Reglas de dominio de las cookies (RFC 6265): una cookie de «domain» se envía a «host» si host es domain o un subdominio.
const domainMatch = (host, domain) => host === domain || host.endsWith('.' + domain);
const related = (a, b) => domainMatch(a, b) || domainMatch(b, a);

// Acepta «example.com», «https://www.example.com/ruta»… y devuelve el hostname limpio (sin www.), o null.
function parseHostInput(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'https://' + t);
    const h = u.hostname.replace(/^www\./, '').replace(/\.$/, '').toLowerCase();
    return /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/.test(h) && !h.includes('..') ? h : null;
  } catch {
    return null;
  }
}

/*
 * catalog = { standard: [nombres], risk: [{ name, reason }] }  (params.json)
 * Ajustes guardados: { enabled, allow: [dominios], risk: [nombres activados], custom: [nombres],
 *   cookies: { onClose, onStartup, delayMin, keep: [dominios] } }
 */
function normalizeSettings(raw, catalog) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const c = s.cookies && typeof s.cookies === 'object' ? s.cookies : {};
  const known = catalog ? new Set(catalog.risk.map((r) => r.name)) : null;
  const uniq = (list, ok) => [...new Set((Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && ok(x)))];
  return {
    enabled: s.enabled !== false,
    // Se validan como hostnames: un valor inválido haría fallar la actualización completa de reglas.
    allow: uniq(s.allow, (d) => parseHostInput(d) === d).slice(0, MAX_ALLOW),
    risk: uniq(s.risk, (n) => !known || known.has(n)),
    custom: uniq(s.custom, validParamName).slice(0, MAX_CUSTOM),
    cookies: {
      onClose: c.onClose === true, // desactivado por defecto: puede cerrar sesiones
      onStartup: c.onStartup === true,
      delayMin: COOKIE_DELAYS.includes(c.delayMin) ? c.delayMin : 5,
      // Solo cuenta la lista guardada si el usuario la editó de verdad (keepEdited). Así una lista vacía
      // guardada como efecto secundario de tocar otra opción no tapa los valores por defecto.
      keepEdited: c.keepEdited === true,
      keep:
        c.keepEdited === true && Array.isArray(c.keep)
          ? uniq(c.keep, (d) => parseHostInput(d) === d).slice(0, MAX_KEEP)
          : [...(catalog?.defaultKeep ?? DEFAULT_COOKIE_KEEP)],
    },
  };
}

/*
 * Chrome distingue mayúsculas en removeParams (comprobado: «UTM_SOURCE» sobrevive a «utm_source»),
 * pero en la práctica aparecen variantes como UTM_SOURCE, Utm_Source o Utm_source.
 * Para cada nombre del catálogo se generan esas variantes.
 */
function caseVariants(name) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return new Set([
    name,
    name.toUpperCase(),
    cap(name),
    name.replace(/[A-Za-z]+/g, cap), // Utm_Social-Type
  ]);
}

/*
 * Parámetros que se eliminan realmente: estándar + riesgo activado (con sus variantes de
 * mayúsculas) + propios (exactamente como se escribieron).
 * Devuelve un Map variante → nombre canónico (el canónico es el que se usa en las estadísticas).
 */
function buildMatcher(catalog, settings) {
  const map = new Map();
  for (const n of [...catalog.standard, ...settings.risk]) {
    for (const v of caseVariants(n)) if (!map.has(v)) map.set(v, n);
  }
  for (const n of settings.custom) if (!map.has(n)) map.set(n, n);
  return map;
}

// Lista de «mantener» personal opcional (local-defaults.json, no se publica). Si no existe, se usa la neutra.
async function loadLocalKeep() {
  try {
    const r = await fetch(chrome.runtime.getURL('local-defaults.json'));
    if (!r.ok) return null;
    const j = await r.json();
    const keep = (Array.isArray(j?.cookieKeep) ? j.cookieKeep : []).filter((d) => parseHostInput(d) === d);
    return keep.length ? [...new Set(keep)] : null;
  } catch {
    return null;
  }
}

let catalogPromise = null;
function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = Promise.all([fetch(chrome.runtime.getURL('params.json')).then((r) => r.json()), loadLocalKeep()])
      .then(([c, localKeep]) => ({
        standard: Array.isArray(c.standard) ? c.standard : [],
        risk: Array.isArray(c.risk) ? c.risk : [],
        defaultKeep: localKeep ?? [...DEFAULT_COOKIE_KEEP],
      }))
      .catch((e) => {
        catalogPromise = null; // permitir reintento; no cachear un fallo
        throw e;
      });
  }
  return catalogPromise;
}

async function getSettings() {
  const [{ settings }, catalog] = await Promise.all([chrome.storage.local.get('settings'), loadCatalog()]);
  return normalizeSettings(settings, catalog);
}
