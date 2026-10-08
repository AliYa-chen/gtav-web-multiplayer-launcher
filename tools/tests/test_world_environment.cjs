'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('client/multiplayer/world-environment.js','utf8');
function harness(){
 const memory={buffer:new ArrayBuffer(1024)},calls=[],messages=[];const self={};let wanted=0;
 const ex={mpAlloc:()=>128n,mpPlayerId:()=>0,mpWantedLevel:()=>wanted,
  mpSetClockTime:(...args)=>calls.push(['clock',...args]),mpPauseClock:(...args)=>calls.push(['pause',...args]),
  mpWeatherPersist:(pointer)=>{const bytes=new Uint8Array(memory.buffer,Number(pointer),32);calls.push(['weather',new TextDecoder().decode(bytes.slice(0,bytes.indexOf(0)))]);},
  mpClearOverrideWeather:()=>calls.push(['clear-weather']),mpRain:rain=>calls.push(['rain',rain]),mpWind:wind=>calls.push(['wind',wind]),
  mpDispatchService:(...args)=>calls.push(['dispatch',...args]),mpRandomCops:(...args)=>calls.push(['cops',...args]),
  mpRandomCopsNotScenarios:()=>{},mpRandomCopsScenarios:()=>{},mpSuppressWitnesses:()=>calls.push(['witnesses']),
  mpClearWanted:()=>{wanted=0;calls.push(['wanted',0]);},mpSetWantedLevel:(_id,value)=>{wanted=value;calls.push(['wanted',value]);},mpSetWantedNow:()=>{}};
 vm.runInNewContext(source,{self,TextEncoder,Uint8Array,BigInt});
 return{bridge:self.createWorldEnvironmentBridge({ex,memory,post:value=>messages.push(value)}),calls,messages};
}
const packet=()=>({connected:true,client_id:'LOCAL',world:{ready:true,world_epoch:'A',world_tick:100000,
 environment_received_at:1000,environment_server_tick:100000,environment:{revision:1,
 clock:{hour:23,minute:59,second:59,paused:false,rate:30,anchor_tick:100000},weather:{type:'CLEAR',rain:0,wind:.2,transition_ms:30000,anchor_tick:100000}},
 law:{players:[{player_id:'LOCAL',stars:2}]}}});
test('服务端时间经过午夜及本机经过时长保持统一，不使用当地时间',()=>{
 const h=harness(),p=packet();h.bridge.update(p,1000);h.bridge.update(p,2000);
 assert.deepEqual(h.calls.filter(c=>c[0]==='clock'),[['clock',23,59,59],['clock',0,0,29]]);
 p.world.world_tick=110000;h.bridge.update(p,2250);
 assert.deepEqual(h.calls.filter(c=>c[0]==='clock').at(-1),['clock',0,0,36],'实体增量不能额外推进世界时钟');
});
test('在线环境就绪后抑制本地警察调度，只采用服务器通缉；未就绪单机不改',()=>{
 const h=harness(),p=packet();p.world.ready=false;assert.equal(h.bridge.update(p,1000),false);assert.equal(h.calls.length,0);
 p.world.ready=true;h.bridge.update(p,1000);assert.equal(h.calls.filter(c=>c[0]==='dispatch').length,15);
 assert.ok(h.calls.filter(c=>c[0]==='dispatch').every(c=>c[2]===0));assert.ok(h.calls.some(c=>c[0]==='wanted'&&c[1]===2));
 p.world.law.players=[];h.bridge.update(p,1500);assert.ok(h.calls.some(c=>c[0]==='wanted'&&c[1]===0));
});
test('旧环境版本不能覆盖新天气，切换world epoch后新版本可应用',()=>{
 const h=harness(),p=packet();h.bridge.update(p,1000);p.world.environment.revision=0;p.world.environment.weather.type='RAIN';
 assert.equal(h.bridge.update(p,1500),false);assert.equal(h.calls.filter(c=>c[0]==='weather').length,1);
 p.world.world_epoch='B';p.world.environment.revision=1;h.bridge.update(p,2000);assert.equal(h.calls.filter(c=>c[0]==='weather').at(-1)[1],'RAIN');
});
