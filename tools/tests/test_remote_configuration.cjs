'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const i18nUrl='data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path.resolve(__dirname,'../../client/i18n.js'),'utf8')).toString('base64');
const i18nPromise=import(i18nUrl);
const source=fs.readFileSync(path.resolve(__dirname,'../../client/multiplayer/remote-config.js'),'utf8').replace("'../i18n.js'",JSON.stringify(i18nUrl));
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
  assert.ok(requests.every(({url,options})=>url==='/api/remote-config?refresh=1' && options.cache==='no-store'));
  stop();assert.equal(scheduled.size,0);
 }finally{
  stop?.();Object.assign(global,originals);
 }
});


test('远程在线标题按当前语言选择受限本地化配置，不采纳不安全翻译地址',async()=>{
 const {cleanOnlineConfiguration}=await modulePromise;
 const snapshot={source:'remote',stale:false,config:{oltitle:'https://base.example',i18n:{en:{oltitle:'Online Session'},'zh-CN':{oltitle:'公共战局'}}}};
 assert.equal(cleanOnlineConfiguration(snapshot,'en').oltitle,'Online Session');
 assert.equal(cleanOnlineConfiguration(snapshot,'zh-CN').oltitle,'公共战局');
 snapshot.config.i18n.en.oltitle='javascript:alert(1)';
 assert.equal(cleanOnlineConfiguration(snapshot,'en').oltitle,'-');
});

test('已打开的远程标题切换语言复用有效快照，不额外请求远程接口',async()=>{
 const [{watchOnlineConfiguration},i18n]=await Promise.all([modulePromise,i18nPromise]);
 const originals={fetch:global.fetch,setTimeout:global.setTimeout,clearTimeout:global.clearTimeout};
 const changes=[],timers=new Map();let timerId=0,requests=0,stop;
 try{
  i18n.setLanguage('zh-CN');
  global.setTimeout=(callback,delay)=>{timers.set(++timerId,{callback,delay});return timerId;};
  global.clearTimeout=id=>timers.delete(id);
  global.fetch=async()=>{requests++;return {ok:true,json:async()=>({source:'remote',stale:false,config:{oltitle:'Default',i18n:{'zh-CN':{oltitle:'公共战局'},en:{oltitle:'Online Session'}}}})};};
  stop=watchOnlineConfiguration(value=>changes.push(value.oltitle));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(changes.at(-1),'公共战局');i18n.setLanguage('en');
  assert.equal(changes.at(-1),'Online Session');assert.equal(requests,1);
  stop();const count=changes.length;i18n.setLanguage('zh-CN');assert.equal(changes.length,count);
 }finally{stop?.();Object.assign(global,originals);}
});
