'use strict';
// Pruebas del borrado de cookies: node test/cookies.test.js
const assert = require('assert');
const { makeEnv } = require('./harness');

const MIN = 60000;
const base = { enabled: true, allow: [], risk: [], custom: [] };
const names = (env) => env.cookies.map((c) => c.name).sort();
const sweepAlarm = (env) => env.fire('alarm', { name: 'cookie-sweep' });
const startupAlarm = (env) => env.fire('alarm', { name: 'cookie-startup' });

(async () => {
  // --- desactivado por defecto ---
  {
    const env = makeEnv();
    env.tabs = [{ id: 1, url: 'https://a.test/' }];
    env.fire('installed');
    await env.flush();
    env.cookie('.a.test', 'sess');
    env.fire('tabRemoved', 1);
    await env.flush();
    env.offset += 99 * MIN;
    sweepAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), ['sess'], 'con la función desactivada no se borra nada');
  }

  // --- al cerrar la pestaña ---
  {
    const env = makeEnv();
    env.tabs = [
      { id: 1, url: 'https://www.a.test/x' },
      { id: 2, url: 'https://b.test/' },
      { id: 3, url: 'https://keep.test/' },
    ];
    env.fire('installed');
    await env.flush();
    await env.setSettings({ ...base, cookies: { onClose: true, delayMin: 5, keepEdited: true, keep: ['keep.test'] } });

    env.cookie('.a.test', 'a_domain');
    env.cookie('www.a.test', 'a_hostonly');
    env.cookie('.b.test', 'b_other_site');
    env.cookie('.keep.test', 'kept');
    env.cookie('.tracker.test', 'third_party');

    env.tabs = env.tabs.filter((t) => t.id !== 1);
    env.fire('tabRemoved', 1);
    await env.flush();
    const sched = env.calls.alarms.filter((a) => a[0] === 'cookie-sweep').at(-1);
    assert(sched && sched[1].when >= Date.now() + 4 * MIN, 'debe programarse con margen');
    sweepAlarm(env);
    await env.flush();
    assert.equal(env.cookies.length, 5, 'antes del margen no se borra');

    env.offset += 6 * MIN;
    sweepAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), ['b_other_site', 'kept', 'third_party'], 'solo las del sitio cerrado');
    assert.equal(env.store.cookieStats.total, 2);
    assert.equal(env.store.cookieStats.byDomain['a.test'], 1);
    assert.equal(env.store.cookieStats.byDomain['www.a.test'], 1);
    assert(!JSON.stringify(env.store.cookieStats).includes('a_domain'), 'no se guardan nombres de cookies');
  }

  // --- otra pestaña del mismo dominio sigue usando la cookie ---
  {
    const env = makeEnv();
    env.tabs = [
      { id: 1, url: 'https://a.test/1' },
      { id: 2, url: 'https://shop.a.test/2' },
    ];
    env.fire('installed');
    await env.flush();
    await env.setSettings({ ...base, cookies: { onClose: true, delayMin: 1, keepEdited: true, keep: [] } });
    env.cookie('.a.test', 'shared');
    env.tabs = env.tabs.filter((t) => t.id !== 1);
    env.fire('tabRemoved', 1);
    await env.flush();
    env.offset += 2 * MIN;
    sweepAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), ['shared'], 'un subdominio abierto sigue usando la cookie del dominio');
  }

  // --- navegar a otro sitio en la misma pestaña ---
  {
    const env = makeEnv();
    env.tabs = [{ id: 1, url: 'https://a.test/' }];
    env.fire('installed');
    await env.flush();
    await env.setSettings({ ...base, cookies: { onClose: true, delayMin: 1, keepEdited: true, keep: [] } });
    env.cookie('.a.test', 'old');
    env.cookie('.b.test', 'new');
    env.tabs = [{ id: 1, url: 'https://b.test/' }];
    env.fire('tabUpdated', 1, { url: 'https://b.test/' }, { id: 1, incognito: false });
    await env.flush();
    env.offset += 2 * MIN;
    sweepAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), ['new'], 'se borra el sitio abandonado, no el actual');
  }

  // --- incógnito: no se sigue (cerrar una pestaña privada no debe borrar cookies del perfil normal) ---
  {
    const env = makeEnv();
    env.tabs = [{ id: 5, url: 'https://secret.test/', incognito: true }];
    env.fire('installed');
    await env.flush();
    await env.setSettings({ ...base, cookies: { onClose: true, delayMin: 1, keepEdited: true, keep: [] } });
    env.cookie('.secret.test', 'normal_profile');
    env.fire('tabUpdated', 5, { url: 'https://secret.test/' }, { id: 5, incognito: true });
    await env.flush();
    env.tabs = [];
    env.fire('tabRemoved', 5);
    await env.flush();
    env.offset += 2 * MIN;
    sweepAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), ['normal_profile'], 'una pestaña de incógnito no dispara borrados');
  }

  // --- pausa global: detiene los modos automáticos ---
  {
    const env = makeEnv();
    env.tabs = [{ id: 1, url: 'https://a.test/' }];
    env.fire('installed');
    await env.flush();
    await env.setSettings({ enabled: false, allow: [], risk: [], custom: [], cookies: { onClose: true, onStartup: true, delayMin: 1, keepEdited: true, keep: [] } });
    env.cookie('.a.test', 'sesion');
    env.cookie('.z.test', 'otra');
    env.tabs = [];
    env.fire('tabRemoved', 1);
    await env.flush();
    env.offset += 2 * MIN;
    sweepAlarm(env);
    await env.flush();
    assert.equal(env.cookies.length, 2, 'en pausa no se borra al cerrar sitios');
    env.fire('startup');
    await env.flush();
    assert(!env.calls.alarms.some((a) => a[0] === 'cookie-startup'), 'en pausa no se programa el barrido de inicio');
    startupAlarm(env);
    await env.flush();
    assert.equal(env.cookies.length, 2, 'en pausa no se borra al iniciar');
    // «Borrar ahora» es una acción explícita del usuario y sí funciona
    const res = await env.sendMessage({ type: 'cookies-sweep-now' });
    assert.equal(res.count, 2);
  }

  // --- se pausa DESPUÉS de programar un borrado: al vencer el margen tampoco se borra ---
  {
    const env = makeEnv();
    env.tabs = [{ id: 1, url: 'https://a.test/' }];
    env.fire('installed');
    await env.flush();
    const ck = { onClose: true, delayMin: 1, keepEdited: true, keep: [] };
    await env.setSettings({ ...base, cookies: ck });
    env.cookie('.a.test', 'sesion');
    env.tabs = [];
    env.fire('tabRemoved', 1); // se programa el borrado
    await env.flush();
    await env.setSettings({ ...base, enabled: false, cookies: ck }); // el usuario pausa antes de que venza
    env.offset += 2 * MIN;
    sweepAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), ['sesion'], 'un borrado ya programado no se ejecuta si se pausó la extensión');
  }

  // --- al iniciar el navegador: con retraso, y no al recargar la extensión ---
  {
    const env = makeEnv();
    env.tabs = [{ id: 1, url: 'https://open.test/' }];
    env.fire('installed');
    await env.flush();
    await env.setSettings({ ...base, cookies: { onStartup: true, keepEdited: true, keep: ['github.com'] } });
    env.cookie('.open.test', 'open');
    env.cookie('.github.com', 'gh');
    env.cookie('gist.github.com', 'gist');
    env.cookie('.old.test', 'old');
    env.cookie('.tracker.test', 'tracker');
    env.fire('installed');
    await env.flush();
    assert.equal(env.cookies.length, 5, 'recargar la extensión no borra');
    env.fire('startup');
    await env.flush();
    assert.equal(env.cookies.length, 5, 'al iniciar no se borra de inmediato: se espera a que se restauren las pestañas');
    const a = env.calls.alarms.find((x) => x[0] === 'cookie-startup');
    assert(a && a[1].delayInMinutes >= 1, 'se programa el barrido con retraso');
    // las pestañas se restauran durante la espera: ya no se borran sus cookies
    env.tabs.push({ id: 2, url: 'https://old.test/restored' });
    startupAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), ['gh', 'gist', 'old', 'open'], 'se respeta lo restaurado, la lista y las pestañas abiertas');
  }

  // --- vista previa (no borra), «Borrar ahora», almacenes separados y remitentes ajenos ---
  {
    const env = makeEnv();
    env.stores = [{ id: '0' }, { id: '1' }];
    env.tabs = [{ id: 1, url: 'https://a.test/' }];
    env.cookie('.a.test', 'normal', { storeId: '0' });
    env.cookie('.zzz.test', 'bye', { storeId: '0' });
    env.cookie('.zzz.test', 'bye2', { storeId: '0' });
    env.cookie('.zzz.test', 'bye_incog', { storeId: '1' });
    assert.equal(await env.sendMessage({ type: 'cookies-sweep-now' }, 'otra-extension'), 'ignored');
    assert.equal(await env.sendMessage({ type: 'cookies-preview' }, 'otra-extension'), 'ignored');
    assert.equal(env.cookies.length, 4, 'un mensaje de otra extensión no borra nada');
    const prev = await env.sendMessage({ type: 'cookies-preview' });
    assert.deepEqual(prev, { count: 3, sites: 1 });
    assert.equal(env.cookies.length, 4, 'la vista previa no borra');
    assert(!env.store.cookieStats, 'la vista previa no cuenta en las estadísticas');
    const res = await env.sendMessage({ type: 'cookies-sweep-now' });
    assert.equal(res.count, 3);
    assert.deepEqual(names(env), ['normal']);
  }

  // --- si el borrado falla, el popup recibe un error (no un «0» engañoso) ---
  {
    const env = makeEnv();
    env.tabs = [];
    env.chrome.cookies.getAllCookieStores = async () => {
      throw new Error('fallo simulado');
    };
    const res = await env.sendMessage({ type: 'cookies-sweep-now' });
    assert(res.error && /fallo simulado/.test(res.error), 'debe informar del error');
  }

  // --- lista blanca por defecto (neutra), la personal local y que la del usuario sustituye ---
  {
    const env = makeEnv();
    env.tabs = [{ id: 1, url: 'https://example.org/' }];
    env.fire('installed');
    await env.flush();
    await env.setSettings({ ...base, cookies: { onStartup: true } }); // sin editar la lista: valen las de por defecto
    env.cookie('.google.com', 'SID'); // protegida por accounts.google.com (dominio relacionado)
    env.cookie('accounts.google.com', 'acc');
    env.cookie('.github.com', 'gh');
    env.cookie('login.live.com', 'ms');
    env.cookie('.youtube.com', 'yt'); // ya no es por defecto: es de la lista personal local
    env.cookie('.random.test', 'random');
    env.cookie('.notgithub.com', 'lookalike'); // no es subdominio de github.com
    env.fire('startup');
    await env.flush();
    startupAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), ['SID', 'acc', 'gh', 'ms'], 'lista neutra por defecto');

    await env.setSettings({ ...base, cookies: { onStartup: true, keepEdited: true, keep: [] } }); // lista propia vacía
    startupAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), [], 'una lista propia vacía (editada) sustituye a la de por defecto');

    // Migración: una lista vacía guardada sin editarla (efecto de tocar otra opción) NO tapa los valores por defecto
    env.cookie('.github.com', 'gh');
    env.cookie('.random.test', 'random');
    await env.setSettings({ ...base, cookies: { onStartup: true, keep: [] } });
    startupAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), ['gh'], 'keep vacío sin editar = lista por defecto');
  }
  {
    const env = makeEnv({ localKeep: ['youtube.com', 'otro.test', 'Mal Dominio'] }); // lista personal local (local-defaults.json)
    env.tabs = [{ id: 1, url: 'https://example.org/' }];
    env.fire('installed');
    await env.flush();
    await env.setSettings({ ...base, cookies: { onStartup: true } });
    env.cookie('.youtube.com', 'yt');
    env.cookie('.github.com', 'gh'); // en la neutra, pero la local manda
    env.fire('startup');
    await env.flush();
    startupAlarm(env);
    await env.flush();
    assert.deepEqual(names(env), ['yt'], 'la lista personal local sustituye a la neutra');
  }

  console.log('COOKIES: OK');
})().catch((e) => {
  console.error('FALLO', e);
  process.exit(1);
});
