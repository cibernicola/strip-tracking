'use strict';
// Entorno de pruebas: carga background.js (y sus importScripts) con un `chrome` simulado.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..') + '/';
const RealDate = Date;

function makeEnv({ localKeep = null } = {}) {
  const store = {};
  const session = {};
  const L = {}; // listeners registrados
  const msgListeners = [];
  const env = { root, store, session, L, offset: 0, calls: { alarms: [], badge: [], removed: [] }, dyn: [], failRules: false, incognitoIds: new Set(), tabs: [], stores: [{ id: '0', tabIds: [] }], cookies: [] };

  const area = (obj, onChange) => ({
    async get(k) {
      const keys = Array.isArray(k) ? k : [k];
      const out = {};
      for (const key of keys) if (key in obj) out[key] = JSON.parse(JSON.stringify(obj[key]));
      return out;
    },
    async set(o) {
      const ch = {};
      for (const [k, v] of Object.entries(o)) {
        obj[k] = JSON.parse(JSON.stringify(v));
        ch[k] = { newValue: v };
      }
      onChange?.(ch);
    },
    async remove(k) {
      const ch = {};
      for (const key of Array.isArray(k) ? k : [k]) {
        delete obj[key];
        ch[key] = {};
      }
      onChange?.(ch);
    },
  });

  const chrome = {
    runtime: {
      id: 'test-ext',
      getURL: (p) => root + p,
      onStartup: { addListener: (f) => (L.startup = [...(L.startup || []), f]) },
      onInstalled: { addListener: (f) => (L.installed = [...(L.installed || []), f]) },
      onMessage: { addListener: (f) => msgListeners.push(f) },
    },
    storage: {
      local: area(store, (ch) => L.changed?.(ch, 'local')),
      session: area(session),
      onChanged: { addListener: (f) => (L.changed = f) },
    },
    webNavigation: { onBeforeNavigate: { addListener: (f) => (L.nav = f) } },
    alarms: {
      create: (n, o) => env.calls.alarms.push([n, o]),
      onAlarm: { addListener: (f) => (L.alarm = [...(L.alarm || []), f]) },
    },
    action: {
      setBadgeText: async (o) => env.calls.badge.push(o.text),
      setBadgeBackgroundColor: async () => {},
    },
    declarativeNetRequest: {
      getDynamicRules: async () => env.dyn,
      updateDynamicRules: async (o) => {
        if (env.failRules) throw new Error('regla inválida (simulado)');
        env.dyn = o.addRules;
      },
    },
    tabs: {
      query: async () => env.tabs.map((t) => ({ ...t })),
      get: async (id) => {
        const t = env.tabs.find((x) => x.id === id);
        return t ? { ...t } : { id, incognito: env.incognitoIds.has(id) };
      },
      onUpdated: { addListener: (f) => (L.tabUpdated = f) },
      onRemoved: { addListener: (f) => (L.tabRemoved = f) },
      onReplaced: { addListener: (f) => (L.tabReplaced = f) },
    },
    cookies: {
      getAllCookieStores: async () => env.stores.map((s) => ({ ...s, tabIds: env.tabs.map((t) => t.id) })),
      getAll: async ({ storeId }) => env.cookies.filter((c) => (c.storeId || '0') === storeId).map((c) => ({ ...c })),
      remove: async ({ url, name, storeId }) => {
        const u = new URL(url);
        const i = env.cookies.findIndex(
          (c) =>
            c.name === name &&
            (c.storeId || '0') === storeId &&
            c.domain.replace(/^\./, '') === u.hostname &&
            c.path === u.pathname &&
            !!c.secure === (u.protocol === 'https:')
        );
        if (i < 0) return null;
        env.cookies.splice(i, 1);
        env.calls.removed.push(name);
        return { url, name, storeId };
      },
    },
  };

  // Date con reloj desplazable para simular el paso del tiempo.
  class FakeDate extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [RealDate.now() + env.offset]));
    }
    static now() {
      return RealDate.now() + env.offset;
    }
  }

  const ctx = {
    chrome,
    console,
    URL,
    Date: FakeDate,
    Promise,
    Set,
    Map,
    Object,
    Array,
    Number,
    JSON,
    Math,
    setTimeout,
    fetch: async (u) => {
      if (String(u).endsWith('local-defaults.json')) {
        if (!localKeep) throw new Error('net::ERR_FILE_NOT_FOUND (simulado)');
        return { ok: true, json: async () => ({ cookieKeep: localKeep }) };
      }
      return { ok: true, json: async () => JSON.parse(fs.readFileSync(u, 'utf8')) };
    },
    importScripts: (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(root + f, 'utf8'), ctx)),
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(root + 'background.js', 'utf8'), ctx);

  env.chrome = chrome;
  env.flush = () => new Promise((r) => setTimeout(r, 60));
  env.setSettings = async (s) => {
    await chrome.storage.local.set({ settings: s });
    await env.flush();
  };
  env.nav = (url, tabId = 1, frameId = 0) => L.nav({ url, frameId, tabId });
  env.fire = (name, ...args) => (Array.isArray(L[name]) ? L[name].forEach((f) => f(...args)) : L[name]?.(...args));
  // Devuelve la respuesta del listener, o 'ignored' si ninguno la atiende (p. ej. mensaje de otra extensión).
  env.sendMessage = (msg, senderId = 'test-ext') =>
    new Promise((resolve) => {
      let handled = false;
      for (const f of msgListeners) if (f(msg, { id: senderId }, resolve) === true) handled = true;
      if (!handled) resolve('ignored');
    });
  env.cookie = (domain, name, extra = {}) => env.cookies.push({ domain, name, path: '/', secure: true, ...extra });
  return env;
}

module.exports = { makeEnv, root };
