'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../client/multiplayer/remote-config.js'),'utf8');
const modulePromise=import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('游戏配置只采用受限HTTPS地址，忽略远程脚本和恶意协议',async()=>{
 const {cleanOnlineConfiguration}=await modulePromise;
 assert.deepEqual(cleanOnlineConfiguration({config:{oltitle:'https://gtav.2t.hk'},source:'remote',stale:false}),{oltitle:'https://gtav.2t.hk',source:'remote',stale:false});
 for(const value of ['javascript:alert(1)','http://example.com','https://user:pass@example.com','<img src=x>',null,'x'.repeat(300)])
  assert.equal(cleanOnlineConfiguration({config:{oltitle:value},source:'remote',stale:false}).oltitle,'https://gtav.2t.hk');
});
