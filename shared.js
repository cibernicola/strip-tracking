'use strict';

/*
 * Código común al service worker (importScripts) y al popup (<script>).
 * Solo define constantes y funciones puras; no toca el estado de la extensión.
 */

const MAX_ALLOW = 500;
const MAX_CUSTOM = 200;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // hora local

// Nombre de parámetro válido: sin espacios ni caracteres con significado en una URL.
const PARAM_RE = /^[^\s=&#?%+]{1,100}$/;
const validParamName = (s) => typeof s === 'string' && PARAM_RE.test(s);

const isAllowed = (host, allow) => allow.some((d) => host === d || host.endsWith('.' + d));

/*
 * catalog = { standard: [nombres], risk: [{ name, reason }] }  (params.json)
 * Ajustes guardados: { enabled, allow: [dominios], risk: [nombres activados], custom: [nombres] }
 */
function normalizeSettings(raw, catalog) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const known = catalog ? new Set(catalog.risk.map((r) => r.name)) : null;
  const uniq = (list, ok) => [...new Set((Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && ok(x)))];
  return {
    enabled: s.enabled !== false,
    allow: uniq(s.allow, (d) => d).slice(0, MAX_ALLOW),
    risk: uniq(s.risk, (n) => !known || known.has(n)),
    custom: uniq(s.custom, validParamName).slice(0, MAX_CUSTOM),
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

let catalogPromise = null;
function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch(chrome.runtime.getURL('params.json'))
      .then((r) => r.json())
      .then((c) => ({
        standard: Array.isArray(c.standard) ? c.standard : [],
        risk: Array.isArray(c.risk) ? c.risk : [],
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
