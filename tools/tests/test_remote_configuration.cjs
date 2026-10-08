'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../client/multiplayer/remote-config.js'),'utf8');
const modulePromise=import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('游戏配置只采用受限HTTPS地址，忽略远程脚本和恶意协议',async()=>{
 const {cleanOnlineConfiguration}=await modulePromise;
 assert.deepEqual(cleanOnlineConfiguration({config:{oltitle:'https://gtav.2t.hk'},source:'remote',stale:false}),{oltitle:'https://gtav.2t.hk',source:'remote',stale:false});
 for(const value of ['javascript:alert(1)','http://example.com','https://user:pass@example.com','<img src=x>',null,'x'.repeat(300)])
  assert.equal(cleanOnlineConfiguration({config:{oltitle:value},source:'remote',stale:false}).oltitle,'-');
});
test('只接受当次有效远程响应，旧缓存和默认配置显示横线',async()=>{
 const {cleanOnlineConfiguration}=await modulePromise;
 const missing={oltitle:'-',source:'unavailable',stale:true};
 for(const source of ['cache','default','unavailable',undefined])
  assert.deepEqual(cleanOnlineConfiguration({config:{oltitle:'https://old.example.com'},source,stale:false}),missing);
 for(const stale of [true,undefined])
  assert.deepEqual(cleanOnlineConfiguration({config:{oltitle:'https://old.example.com'},source:'remote',stale}),missing);
 assert.deepEqual(cleanOnlineConfiguration(null),missing);
 assert.deepEqual(cleanOnlineConfiguration({config:{oltitle:'在线战局'},source:'remote',stale:false}),
  {oltitle:'在线战局',source:'remote',stale:false});
});
test('定时请求失败立即清除上次文案，恢复联网后重新读取',async()=>{
 const {watchOnlineConfiguration}=await modulePromise;
 const originals={fetch:global.fetch,setTimeout:global.setTimeout,clearTimeout:global.clearTimeout};
 const scheduled=new Map(),changes=[],requests=[];
 let nextId=0,stop;
 const responses=[
  {ok:true,json:async()=>({config:{oltitle:'https://first.example.com'},source:'remote',stale:false})},
  new Error('网络断开'),
  {ok:true,json:async()=>({config:{oltitle:'https://next.example.com'},source:'remote',stale:false})},
  {ok:false,json:async()=>{throw new Error('不应解析失败响应');}},
  {ok:true,json:async()=>{throw new SyntaxError('无效 JSON');}},
  {ok:true,json:async()=>({config:{oltitle:'https://old.example.com'},source:'cache',stale:true})}
 ];
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 try{
  global.fetch=async(url,options)=>{
   requests.push({url,options});
   const response=responses.shift();
   if(response instanceof Error) throw response;
   return response;
  };
  global.setTimeout=(callback,delay)=>{const id=++nextId;scheduled.set(id,{callback,delay});return id;};
  global.clearTimeout=id=>scheduled.delete(id);
  stop=watchOnlineConfiguration(value=>changes.push(value));
  await flush();
  assert.equal(changes[0].oltitle,'-');
  assert.equal(changes.at(-1).oltitle,'https://first.example.com');
  for(const expected of ['-','https://next.example.com','-','-','-']){
   const [id,item]=[...scheduled].find(([,item])=>item.delay===60000);
   scheduled.delete(id);await item.callback();await flush();
   assert.equal(changes.at(-1).oltitle,expected);
  }
  assert.equal(requests.length,6);
  assert.ok(requests.every(({url,options})=>url==='/api/remote-config' && options.cache==='no-store'));
  stop();assert.equal(scheduled.size,0);
 }finally{
  stop?.();Object.assign(global,originals);
 }
});
