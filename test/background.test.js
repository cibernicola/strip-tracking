'use strict';
// Pruebas de reglas, ajustes y estadísticas (sin dependencias): node test/background.test.js
const fs = require('fs');
const assert = require('assert');
const { makeEnv, root } = require('./harness');

const cat = JSON.parse(fs.readFileSync(root + 'params.json', 'utf8'));
assert.equal(new Set(cat.standard).size, cat.standard.length, 'duplicados estándar');
assert(!cat.risk.some((r) => cat.standard.includes(r.name)), 'solape estándar/riesgo');
assert(cat.risk.every((r) => r.name && r.reason.length > 20), 'riesgo sin motivo');
const man = JSON.parse(fs.readFileSync(root + 'manifest.json', 'utf8'));
for (const p of Object.values(man.icons)) assert(fs.existsSync(root + p), p);
assert(!man.declarative_net_request);
assert(man.permissions.includes('cookies'));
console.log('estándar', cat.standard.length, 'riesgo', cat.risk.length);

(async () => {
  const env = makeEnv();
  const { store, flush, nav, setSettings } = env;
  const rule = () => env.dyn.find((r) => r.id === 1);
  const rp = () => rule()?.action.redirect.transform.queryTransform.removeParams || [];
  const base = { enabled: true, allow: [], risk: [], custom: [] };

  env.fire('installed');
  await flush();
  const BASE = rp().length;
  assert(cat.standard.every((n) => rp().includes(n)), 'faltan parámetros estándar');
  assert(['UTM_SOURCE', 'Utm_Source', 'Utm_Medium', 'Utm_Social-Type'].every((v) => rp().includes(v)), 'faltan variantes de mayúsculas');
  assert.equal(new Set(rp()).size, BASE, 'variantes duplicadas');
  assert(!rp().includes('referrer'), 'riesgo no debe estar activo por defecto');
  assert.deepEqual(rule().condition.requestMethods, ['get']);

  // estadísticas: el riesgo desactivado no cuenta; las variantes se agrupan por nombre canónico
  await nav('https://www.example.com/a?utm_source=x&id=5&fbclid=abc&referrer=/home&UTM_MEDIUM=y');
  await flush();
  assert.equal(store.stats.params, 3, 'referrer (riesgo) no debe contar; UTM_MEDIUM sí');
  assert.equal(store.stats.byParam.utm_medium, 1);
  assert(!store.stats.byParam.UTM_MEDIUM);
  assert(!JSON.stringify(store.stats).includes('abc'), 'se filtró un valor');

  // grupo de riesgo
  await setSettings({ ...base, risk: ['referrer', 'psc', 'noexiste'] });
  assert(rp().includes('referrer') && rp().includes('REFERRER') && rp().includes('psc') && !rp().includes('noexiste') && !rp().includes('feature'));
  await nav('https://b.test/?referrer=/x');
  await flush();
  assert.equal(store.stats.byParam.referrer, 1);

  // propios: válidos, inválidos y duplicados
  await setSettings({ ...base, custom: ['mi_param', 'utm_source', 'a b', 'x=1', '', 'mi_param'] });
  assert(rp().includes('mi_param') && !rp().includes('a b') && !rp().includes('x=1'));
  assert.equal(rp().filter((x) => x === 'mi_param').length, 1);
  assert.equal(rp().length, BASE + 1, 'utm_source no se duplica');
  assert(!rp().includes('MI_PARAM'), 'los propios no llevan variantes');
  assert(!rp().includes('referrer'), 'riesgo desactivado vuelve a quitarse');
  await nav('https://c.test/?mi_param=1');
  await flush();
  assert.equal(store.stats.byParam.mi_param, 1);

  // excepciones por sitio
  await setSettings({ ...base, allow: ['example.com'] });
  assert(env.dyn.some((r) => r.action.type === 'allow' && r.condition.requestDomains[0] === 'example.com'));
  const before = store.stats.urls;
  await nav('https://sub.example.com/?utm_source=1');
  await flush();
  assert.equal(store.stats.urls, before);

  // pausa
  await setSettings({ ...base, enabled: false, allow: ['example.com'] });
  assert.equal(env.dyn.length, 0);
  assert.equal(env.calls.badge.at(-1), 'OFF');
  await nav('https://new.test/?utm_source=1');
  await flush();
  assert.equal(store.stats.urls, before);
  await setSettings(base);
  assert.equal(env.dyn.length, 1);

  // ajustes corruptos
  await setSettings('basura');
  assert.equal(rp().length, BASE);

  // poda de dominios: el nuevo no debe ser expulsado
  const big = {};
  for (let i = 0; i < 2100; i++) big['d' + i + '.test'] = { urls: 1, params: 1, last: i };
  store.stats = { ...store.stats, byDomain: big };
  await nav('https://brandnew.test/?utm_source=1');
  await flush();
  assert.equal(Object.keys(store.stats.byDomain).length, 2000);
  assert(store.stats.byDomain['brandnew.test']);

  // estadísticas corruptas
  store.stats = { urls: 'x' };
  await nav('https://z.test/?gclid=1');
  await flush();
  assert.equal(store.stats.urls, 1);

  // el recuento ignora marcos incrustados, incógnito y pestañas desconocidas
  store.stats = undefined;
  delete store.stats;
  await nav('https://ads.test/?utm_source=x', 1, 7); // subframe
  env.incognitoIds.add(9);
  await nav('https://private.test/?utm_source=x', 9); // pestaña de incógnito
  env.chrome.tabs.get = async () => {
    throw new Error('No tab with id');
  };
  await nav('https://ghost.test/?utm_source=x', 77); // no se puede saber → no se registra
  await flush();
  assert(!store.stats, 'subframes, incógnito y pestañas desconocidas no se registran');

  // las excepciones se validan: una entrada inválida no tumba la actualización de reglas
  await setSettings({ ...base, allow: ['Mal Host!', 'ok.test', 'https://www.otro.test/x'] });
  const allows = env.dyn.filter((r) => r.action.type === 'allow').map((r) => r.condition.requestDomains[0]);
  assert.deepEqual(allows, ['ok.test'], 'solo se aceptan hostnames limpios; el resto se descarta');

  // si la actualización de reglas falla, la insignia lo muestra y se recupera después
  env.failRules = true;
  await setSettings({ ...base, custom: ['x_param'] });
  assert.equal(env.calls.badge.at(-1), 'ERR');
  env.failRules = false;
  await setSettings({ ...base, custom: ['x_param'], allow: [] });
  assert.notEqual(env.calls.badge.at(-1), 'ERR');

  assert(env.calls.alarms.length && env.calls.alarms[0][1].when > Date.now());
  console.log('REGLAS Y ESTADÍSTICAS: OK');
})().catch((e) => {
  console.error('FALLO', e);
  process.exit(1);
});
