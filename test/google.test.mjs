import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

function backend() {
  const properties=new Map([['ADMIN_PASSWORD','test-google-password-123']]),cache=new Map(),sent=[];
  const context=vm.createContext({
    Utilities:{getUuid:randomUUID,DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,text)=>[...createHash('sha256').update(text).digest()]},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k),setProperty:(k,v)=>properties.set(k,v)})},
    CacheService:{getScriptCache:()=>({get:k=>cache.get(k),put:(k,v)=>cache.set(k,v),remove:k=>cache.delete(k)})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
    MailApp:{getRemainingDailyQuota:()=>100,sendEmail:msg=>sent.push(msg)},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})}
  });
  vm.runInContext(readFileSync(new URL('../google-apps-script/Code.js',import.meta.url),'utf8'),context);
  const call=input=>JSON.parse(context.doPost({postData:{contents:JSON.stringify(input)}}).text);
  return {context,properties,sent,call};
}
test('Google backend validates participants, protects organizer and sends six balanced assignments',()=>{
  const b=backend();
  assert.equal(b.call({action:'admin'}).status,401);
  assert.equal(b.call({action:'join',name:'A',email:'bad'}).status,400);
  const token=b.call({action:'login',password:'test-google-password-123'}).data.token;
  assert.equal(b.call({action:'admin/draw',token}).status,409);
  for(let i=0;i<6;i++) assert.equal(b.call({action:'join',name:`Santa ${i}`,email:`santa${i}@example.com`}).ok,true);
  assert.equal(b.call({action:'join',name:'Seven',email:'seven@example.com'}).status,409);
  const result=b.call({action:'admin/draw',token});
  assert.equal(result.ok,true);assert.equal(b.sent.length,6);
  const state=JSON.parse(b.properties.get('SANTA_STATE'));
  const received=Object.fromEntries(state.people.map(p=>[p.id,0]));
  for(const person of state.people) {
    const ids=state.draw.assignments[person.id];
    assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);assert.ok(!ids.includes(person.id));
    ids.forEach(id=>received[id]++);
    const mail=b.sent.find(m=>m.to===person.email);
    ids.forEach(id=>assert.ok(mail.body.includes(state.people.find(p=>p.id===id).name)));
  }
  assert.deepEqual(Object.values(received),[2,2,2,2,2,2]);
  assert.ok(!JSON.stringify(result).includes('assignments'));
  assert.equal(b.call({action:'admin/draw',token}).status,409);
  b.call({action:'admin/retry',token});assert.equal(b.sent.length,6);
  assert.deepEqual(b.call({action:'status'}).data,{count:6,drawn:true});
  b.call({action:'admin/logout',token});assert.equal(b.call({action:'admin',token}).status,401);
});
test('Google backend preserves uncertain sends and only resumes unattempted messages',()=>{
  const b=backend(); const token=b.call({action:'login',password:'test-google-password-123'}).data.token;
  for(let i=0;i<6;i++)b.call({action:'join',name:`Santa ${i}`,email:`santa${i}@example.com`});
  let calls=0;
  b.context.MailApp.sendEmail=()=>{calls++;throw new Error('Uncertain provider outcome');};
  const result=b.call({action:'admin/draw',token});
  assert.ok(result.data.people.every(p=>p.status==='review'));
  b.call({action:'admin/retry',token});assert.equal(calls,6);
  const saved=b.properties.get('SANTA_STATE');
  assert.equal(b.call({action:'admin/remove',token,id:result.data.people[0].id}).status,409);
  assert.equal(b.properties.get('SANTA_STATE'),saved);
});
test('Google backend checks sending quota before committing any draw',()=>{
  const b=backend();const token=b.call({action:'login',password:'test-google-password-123'}).data.token;
  for(let i=0;i<6;i++)b.call({action:'join',name:`Santa ${i}`,email:`santa${i}@example.com`});
  b.context.MailApp.getRemainingDailyQuota=()=>5;
  assert.equal(b.call({action:'admin/draw',token}).status,503);
  assert.equal(JSON.parse(b.properties.get('SANTA_STATE')).draw,null);
  assert.equal(b.sent.length,0);
});
test('removed participants can rejoin with corrected email details',()=>{
  const b=backend();const token=b.call({action:'login',password:'test-google-password-123'}).data.token;
  const signup=b.call({action:'join',name:'Santa',email:'typo@example.com'}).data;
  assert.equal(b.call({action:'receipt',receipt:signup.receipt}).data.joined,true);
  const person=b.call({action:'admin',token}).data.people[0];
  b.call({action:'admin/remove',token,id:person.id});
  assert.equal(b.call({action:'receipt',receipt:signup.receipt}).data.joined,false);
  assert.equal(b.call({action:'join',name:'Santa',email:'correct@example.com'}).ok,true);
});
test('organizer login accepts a ten-character password',()=>{
  const b=backend();b.properties.set('ADMIN_PASSWORD','samplepass');
  assert.equal(b.call({action:'login',password:'samplepass'}).ok,true);
  assert.equal(b.call({action:'login',password:'incorrect'}).status,401);
  b.properties.set('ADMIN_PASSWORD','short');
  assert.equal(b.call({action:'login',password:'short'}).status,503);
});
