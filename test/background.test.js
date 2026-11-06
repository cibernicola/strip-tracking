const fs=require('fs'),vm=require('vm'),assert=require('assert');
const root=require('path').join(__dirname,'..')+'/';
const cat=JSON.parse(fs.readFileSync(root+'params.json','utf8'));
assert.equal(new Set(cat.standard).size,cat.standard.length,'duplicados estándar');
assert(!cat.risk.some(r=>cat.standard.includes(r.name)),'solape estándar/riesgo');
assert(cat.risk.every(r=>r.name&&r.reason.length>20),'riesgo sin motivo');
const man=JSON.parse(fs.readFileSync(root+'manifest.json','utf8'));
for(const p of Object.values(man.icons))assert(fs.existsSync(root+p),p);
assert(!man.declarative_net_request);
console.log('estándar',cat.standard.length,'riesgo',cat.risk.length);
const store={},L={},calls={dyn:[],alarms:[],badge:[]};let dyn=[];
const chrome={
 runtime:{getURL:p=>root+p,onStartup:{addListener:f=>L.startup=f},onInstalled:{addListener:f=>L.installed=f}},
 storage:{local:{async get(k){return k in store?{[k]:JSON.parse(JSON.stringify(store[k]))}:{}},
  async set(o){const ch={};for(const[k,v]of Object.entries(o)){store[k]=JSON.parse(JSON.stringify(v));ch[k]={newValue:v}}L.changed(ch,'local')}},
  onChanged:{addListener:f=>L.changed=f}},
 webNavigation:{onBeforeNavigate:{addListener:f=>L.nav=f}},
 alarms:{create:(n,o)=>calls.alarms.push([n,o]),onAlarm:{addListener:f=>L.alarm=f}},
 action:{setBadgeText:async o=>calls.badge.push(o.text),setBadgeBackgroundColor:async()=>{}},
 declarativeNetRequest:{getDynamicRules:async()=>dyn,updateDynamicRules:async o=>{calls.dyn.push(o);dyn=o.addRules}}};
const ctx={chrome,console,URL,Date,Promise,Set,Object,Array,Number,JSON,setTimeout,
 fetch:async u=>({json:async()=>JSON.parse(fs.readFileSync(u,'utf8'))}),
 importScripts:f=>vm.runInContext(fs.readFileSync(root+f,'utf8'),ctx)};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(root+'background.js','utf8'),ctx);
const nav=url=>L.nav({url,frameId:0}),flush=()=>new Promise(r=>setTimeout(r,60));
const rule=()=>dyn.find(r=>r.id===1), rp=()=>rule()?.action.redirect.transform.queryTransform.removeParams||[];
const set=async s=>{await chrome.storage.local.set({settings:s});await flush()};
(async()=>{
 L.installed();await flush();
 assert.equal(rp().length,cat.standard.length,'inicial = solo estándar');
 assert(!rp().includes('referrer'),'riesgo no debe estar activo por defecto');
 assert.deepEqual(rule().condition.requestMethods,['get']);
 // estadísticas: riesgo desactivado no cuenta
 await nav('https://www.example.com/a?utm_source=x&id=5&fbclid=abc&referrer=/home');await flush();
 assert.equal(store.stats.params,2,'referrer (riesgo) no debe contar');
 assert(!JSON.stringify(store.stats).includes('abc'));
 // activar riesgo
 await set({enabled:true,allow:[],risk:['referrer','psc','noexiste'],custom:[]});
 assert(rp().includes('referrer')&&rp().includes('psc')&&!rp().includes('noexiste')&&!rp().includes('feature'));
 await nav('https://b.test/?referrer=/x');await flush();
 assert.equal(store.stats.byParam.referrer,1);
 // propios (válidos, inválidos y duplicado de estándar)
 await set({enabled:true,allow:[],risk:[],custom:['mi_param','utm_source','a b','x=1','','mi_param']});
 assert(rp().includes('mi_param')&&!rp().includes('a b')&&!rp().includes('x=1'));
 assert.equal(rp().filter(x=>x==='mi_param').length,1);
 assert.equal(rp().length,cat.standard.length+1,'utm_source no se duplica');
 assert(!rp().includes('referrer'),'riesgo desactivado vuelve a quitarse');
 await nav('https://c.test/?mi_param=1');await flush();
 assert.equal(store.stats.byParam.mi_param,1);
 // excepciones por sitio
 await set({enabled:true,allow:['example.com'],risk:[],custom:[]});
 assert(dyn.some(r=>r.action.type==='allow'&&r.condition.requestDomains[0]==='example.com'));
 const before=store.stats.urls;await nav('https://sub.example.com/?utm_source=1');await flush();
 assert.equal(store.stats.urls,before);
 // pausa: sin reglas y sin contar
 await set({enabled:false,allow:['example.com'],risk:[],custom:[]});
 assert.equal(dyn.length,0);assert.equal(calls.badge.at(-1),'OFF');
 await nav('https://new.test/?utm_source=1');await flush();assert.equal(store.stats.urls,before);
 await set({enabled:true,allow:[],risk:[],custom:[]});assert.equal(dyn.length,1);
 // ajustes corruptos
 await set('basura');assert.equal(rp().length,cat.standard.length);
 // poda
 const big={};for(let i=0;i<2100;i++)big['d'+i+'.test']={urls:1,params:1,last:i};
 store.stats={...store.stats,byDomain:big};await nav('https://brandnew.test/?utm_source=1');await flush();
 assert.equal(Object.keys(store.stats.byDomain).length,2000);assert(store.stats.byDomain['brandnew.test']);
 store.stats={urls:'x'};await nav('https://z.test/?gclid=1');await flush();assert.equal(store.stats.urls,1);
 assert(calls.alarms.length&&calls.alarms[0][1].when>Date.now());
 console.log('TODAS LAS PRUEBAS OK');
})().catch(e=>{console.error('FALLO',e);process.exit(1)});
