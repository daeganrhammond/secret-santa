import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const password = 'test-only-organizer-password';
const origin = 'http://localhost:3000';
async function setup(t, options={}) {
  const app=createApp({password,origin,dbPath:':memory:',...options});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  t.after(()=>app.close());
  const url=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='';
  async function request(path,data,overrides={}) {
    const response=await fetch(url+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...overrides},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};
  }
  async function login() { const result=await request('/api/login',{password});cookie=result.cookie.split(';')[0]; }
  async function enroll(n=6) {for(let i=0;i<n;i++) assert.equal((await request('/api/join',{name:`Santa ${i}`,email:`santa${i}@example.com`})).status,201);}
  return {...app,request,login,enroll};
}
test('enforces organizer authorization, origin, unique signup and six-person limit',async t=>{
  const app=await setup(t,{sendEmail:async()=> 'receipt'});
  assert.equal((await app.request('/api/admin')).status,401);
  assert.equal((await app.request('/api/admin/draw',{})).status,401);
  assert.equal((await app.request('/api/join',{name:'A',email:'a@example.com'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await app.request('/api/join',{name:'A',email:'bad'})).status,400);
  await app.enroll(1);
  assert.equal((await app.request('/api/join',{name:'Other',email:'SANTA0@example.com'})).status,409);
  assert.equal((await app.request('/api/join',{name:'santa 0',email:'other@example.com'})).status,409);
  await app.login();
  assert.equal((await app.request('/api/admin/draw',{})).status,409);
  for(let i=1;i<6;i++) await app.request('/api/join',{name:`Santa ${i}`,email:`santa${i}@example.com`});
  assert.equal((await app.request('/api/join',{name:'Seventh',email:'extra@example.com'})).status,409);
  assert.deepEqual((await app.request('/api/status')).body,{count:6,drawn:false});
});
test('locks the draw, sends private emails and retries only definite failures',async t=>{
  const sent=[];let fail=true;
  const app=await setup(t,{sendEmail:async msg=>{sent.push(msg);if(fail&&msg.email==='santa2@example.com'){const e=new Error('Rejected');e.definiteFailure=true;throw e;}return 'provider-id';}});
  await app.enroll();await app.login();
  const result=await app.request('/api/admin/draw',{});
  assert.equal(result.status,200);assert.equal(sent.length,6);
  assert.equal(result.body.people.filter(p=>p.status==='failed').length,1);
  for(const msg of sent) {assert.equal(msg.recipients.length,2);assert.ok(!msg.recipients.includes(msg.name));}
  const original=app.db.prepare('SELECT assignments FROM draw').get().assignments;
  assert.equal((await app.request('/api/admin/draw',{})).status,409);
  fail=false;
  const retry=await app.request('/api/admin/retry',{});
  assert.equal(retry.status,200);assert.equal(sent.length,7);assert.equal(sent[6].email,'santa2@example.com');
  assert.deepEqual(sent[6],sent[2]);
  assert.ok(retry.body.people.every(p=>p.status==='sent'));
  assert.equal(app.db.prepare('SELECT assignments FROM draw').get().assignments,original);
  await app.request('/api/admin/retry',{});assert.equal(sent.length,7);
  assert.equal((await app.request('/api/admin/remove',{id:retry.body.people[0].id})).status,409);
  assert.ok(!JSON.stringify((await app.request('/api/status')).body).includes('email'));
  assert.ok(!JSON.stringify(result.body).includes('assignments'));
});
test('an uncertain send is held for review and not automatically replayed',async t=>{
  let calls=0;
  const app=await setup(t,{sendEmail:async()=>{calls++;throw new Error('Timeout');}});
  await app.enroll();await app.login();
  const result=await app.request('/api/admin/draw',{});
  assert.ok(result.body.people.every(p=>p.status==='review'));
  await app.request('/api/admin/retry',{});assert.equal(calls,6);
});
test('a sender is required before committing a draw',async t=>{
  const oldKey=process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;
  t.after(()=>{if(oldKey!==undefined)process.env.RESEND_API_KEY=oldKey;});
  const app=await setup(t);await app.enroll();await app.login();
  assert.equal((await app.request('/api/admin/draw',{})).status,503);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM draw').get().n,0);
});
test('saved signups and assignments survive a process restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'santa-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const dbPath=join(dir,'santa.sqlite');
  const first=createApp({password,origin,dbPath});
  first.db.prepare('INSERT INTO participants VALUES (?,?,?,?)').run('one','One','one@example.com','receipt');
  first.db.prepare('INSERT INTO draw VALUES (1,?,?)').run('{"one":["two","three"]}',new Date().toISOString());
  first.db.prepare("INSERT INTO deliveries(participant_id,status) VALUES ('one','sending')").run();
  first.db.close();
  const second=createApp({password,origin,dbPath});
  assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM participants').get().n,1);
  assert.equal(second.db.prepare('SELECT assignments FROM draw').get().assignments,'{"one":["two","three"]}');
  assert.equal(second.db.prepare('SELECT status FROM deliveries').get().status,'review');
  second.db.close();
});
