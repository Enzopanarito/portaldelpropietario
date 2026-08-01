'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function storage(seed={}){const values=new Map(Object.entries(seed));return{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),has:key=>values.has(key)}}
function classList(initial=[]){const values=new Set(initial);return{add:value=>values.add(value),remove:value=>values.delete(value),contains:value=>values.has(value)}}

test('redirige inmediatamente al login cuando una API protegida devuelve 401',async()=>{
 const local=storage(),session=storage({'vla-admin-token':'expired-token','vla-admin-auth':'true'}),assigned=[];
 const document={readyState:'complete',documentElement:{dataset:{}},getElementById:()=>null,addEventListener:()=>{}};
 const location={origin:'https://villa.test',pathname:'/admin.html',search:'',replace:url=>assigned.push(['replace',url]),assign:url=>assigned.push(['assign',url])};
 const window={fetch:async()=>({status:401}),addEventListener:()=>{},showApp:()=>{}};window.window=window;
 const context={window,document,location,history:{replaceState:()=>{}},localStorage:local,sessionStorage:session,URL,URLSearchParams,setTimeout:fn=>{fn();return 1},setInterval:()=>1,clearInterval:()=>{},console};
 vm.runInNewContext(fs.readFileSync('admin-session-bridge.js','utf8'),context,{filename:'admin-session-bridge.js'});
 await window.fetch('/api/vla/monthly-close',{headers:{Authorization:'Bearer expired-token'}});
 assert.deepEqual(assigned,[['replace','/admin.html?session=expired']]);
 assert.equal(session.has('vla-admin-token'),false);assert.equal(session.has('vla-admin-auth'),false);
});

test('un error de contraseña en login no crea un bucle de redirección',async()=>{
 const local=storage(),session=storage(),assigned=[];
 const context={document:{readyState:'complete',documentElement:{dataset:{}},getElementById:()=>null,addEventListener:()=>{}},location:{origin:'https://villa.test',pathname:'/admin.html',search:'',replace:url=>assigned.push(url),assign:url=>assigned.push(url)},history:{replaceState:()=>{}},localStorage:local,sessionStorage:session,URL,URLSearchParams,setTimeout:fn=>{fn();return 1},setInterval:()=>1,clearInterval:()=>{},console};
 context.window={fetch:async()=>({status:401}),addEventListener:()=>{},showApp:()=>{}};context.window.window=context.window;
 vm.runInNewContext(fs.readFileSync('admin-session-bridge.js','utf8'),context,{filename:'admin-session-bridge.js'});
 await context.window.fetch('/.netlify/functions/login',{method:'POST'});
 assert.deepEqual(assigned,[]);
});
