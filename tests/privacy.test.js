import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('Supabase migration enforces authorization, invitation rules and household isolation', async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  // Model Supabase's role and validated request-JWT context at the database boundary.
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb not null);
    create function auth.jwt() returns jsonb language sql stable as
      $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as
      $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to authenticated;
    create publication supabase_realtime;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/20261124000000_homehub.sql',import.meta.url),'utf8'));
  const [alice,bob,carol,rateTester] = Array.from({length:4},()=>crypto.randomUUID());
  for (const [uid,name] of [[alice,'Alice'],[bob,'Bob'],[carol,'Carol'],[rateTester,'Rate tester']]) {
    await db.query('insert into auth.users values ($1,$2)',[uid,JSON.stringify({full_name:name})]);
  }
  async function as(uid,callback) {
    await db.exec(`set role ${uid ? 'authenticated':'anon'}`);
    try {
      await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:uid,role:uid?'authenticated':'anon'})]);
      return await callback();
    } finally {
      await db.exec('reset role');
    }
  }
  async function rpc(uid,operation,household=null,record=null,body={},status) {
    const {rows} = await as(uid,()=>db.query('select public.homehub($1,$2,$3,$4) as result',[operation,household,record,JSON.stringify(body)]));
    const payload = rows[0].result;
    assert.equal(payload.status,status,JSON.stringify({operation,payload}));
    return payload;
  }
  await assert.rejects(rpc(null,'list'),/permission denied/);
  await assert.rejects(as(alice,()=>db.query('select * from homehub_private.households')),/permission denied/);
  await assert.rejects(as(alice,()=>db.query('insert into public.homehub_events(uid) values ($1)',[alice])),/permission denied/);
  const {id:a} = await rpc(alice,'create',null,null,{name:'Maple House'});
  const {id:b} = await rpc(bob,'create',null,null,{name:'Cedar House'});
  assert.deepEqual((await rpc(alice,'list')).households.map(h=>h.id),[a]);
  assert.deepEqual((await rpc(bob,'list')).households.map(h=>h.id),[b]);
  const fresh = await rpc(alice,'get',a);
  assert.deepEqual([fresh.items,fresh.contacts,fresh.tasks],[[],[],[]]);
  assert.equal(fresh.members[0].role,'admin');
  const triggers = await as(alice,()=>db.query('select uid from public.homehub_events'));
  assert.deepEqual(triggers.rows.map(row=>row.uid),[alice]);

  await rpc(bob,'item_add',b,null,{name:'Secret Cereal',quantity:9});
  await rpc(bob,'contact_add',b,null,{name:'Private plumber',phone:'+1 555 0100'});
  const cedar = await rpc(bob,'get',b);
  await rpc(bob,'task_add',b,null,{description:'Private maintenance',contact:cedar.contacts[0].id,status:'Scheduled'});
  const cedarFull = await rpc(bob,'get',b);
  const batch = await rpc(bob,'order',b,null,{ids:[cedar.items[0].id]});
  for (const [uid,other] of [[alice,b],[bob,a]]) {
    for (const operation of ['get','invite','item_add','settings','role','remove']) await rpc(uid,operation,other,null,{},404);
  }
  await rpc(alice,'order',a,null,{ids:[cedar.items[0].id]},404);
  await rpc(alice,'undo',a,batch.batch,{},404);
  await rpc(alice,'contact_delete',a,cedar.contacts[0].id,{},404);
  await rpc(alice,'task_delete',a,cedarFull.tasks[0].id,{},404);
  await rpc(alice,'task_add',a,null,{description:'Invalid local task',contact:cedar.contacts[0].id,status:'Scheduled'},400);
  await rpc(alice,'settings',a,null,{name:'Maple House',day:'Friday',buyer:bob},400);

  let invite = await rpc(alice,'invite',a);
  assert.match(invite.code,/^[a-f0-9]{32}$/);
  await rpc(alice,'revoke',a);
  await rpc(carol,'join',null,null,{code:invite.code},404);
  invite = await rpc(alice,'invite',a);
  await db.query("update homehub_private.invitations set expires=now()-interval '1 second' where household=$1",[a]);
  await rpc(carol,'join',null,null,{code:invite.code},404);
  invite = await rpc(alice,'invite',a);
  assert.equal((await rpc(carol,'join',null,null,{code:invite.code})).id,a);
  await rpc(carol,'invite',a,null,{},403);
  for (let i=0;i<8;i++) await rpc(rateTester,'join',null,null,{code:'bad'},404);
  await rpc(rateTester,'join',null,null,{code:invite.code},429);
  const cedarInvite = await rpc(bob,'invite',b);
  await rpc(carol,'join',null,null,{code:cedarInvite.code});
  assert.equal((await rpc(carol,'list')).households.length,2);

  await rpc(alice,'item_add',a,null,{name:'  Toothpaste ',quantity:1});
  await rpc(carol,'item_add',a,null,{name:'tOOthpaste',quantity:1});
  await rpc(carol,'item_add',a,null,{name:' hand    soap ',quantity:3});
  let maple = await rpc(alice,'get',a);
  const tooth = maple.items.filter(item=>item.item_key==='toothpaste');
  assert.equal(tooth.reduce((sum,item)=>sum+item.quantity,0),2);
  assert.deepEqual(new Set(tooth.map(item=>item.uid)),new Set([alice,carol]));
  assert.ok(maple.items.some(item=>item.item_key==='hand soap'));
  const carolItem = tooth.find(item=>item.uid===carol);
  await rpc(alice,'item_edit',a,carolItem.id,{name:'Toothpaste',quantity:3},404);
  await rpc(carol,'item_edit',a,carolItem.id,{name:'Toothpaste',quantity:2});
  await rpc(carol,'item_delete',a,maple.items.find(item=>item.item_key==='hand soap').id);
  await rpc(carol,'item_add',a,null,{name:'Toothpaste',quantity:4});
  const order = await rpc(alice,'order',a,null,{ids:tooth.map(item=>item.id)});
  maple = await rpc(alice,'get',a);
  assert.equal(maple.items.filter(item=>item.batch===order.batch).length,2);
  assert.equal(maple.items.find(item=>!item.batch).quantity,4);
  await rpc(alice,'undo',a,order.batch);
  assert.equal((await rpc(alice,'get',a)).items.filter(item=>!item.batch).length,3);

  await rpc(alice,'contact_add',a,null,{name:'AC technician',phone:'+91 9999999999',notes:'Weekdays'});
  const contact = (await rpc(alice,'get',a)).contacts[0];
  await rpc(carol,'task_add',a,null,{description:'Service AC',assignee:carol,contact:contact.id,due:'2026-12-02',status:'Scheduled'});
  const task = (await rpc(carol,'get',a)).tasks[0];
  await rpc(alice,'task_edit',a,task.id,{...task,status:'Completed'});
  await rpc(alice,'rotate',a);
  assert.equal((await rpc(alice,'get',a)).household.buyer,carol);
  await rpc(alice,'contact_delete',a,contact.id);
  assert.equal((await rpc(alice,'get',a)).tasks[0].contact,null);
  await rpc(alice,'role',a,carol,{role:'admin'});
  await rpc(carol,'settings',a,null,{name:'Maple House',day:'Friday',buyer:carol});
  await rpc(alice,'remove',a,carol);
  await rpc(carol,'get',a,null,{},404);
  await rpc(carol,'join',null,null,{code:invite.code},404);
  const remaining = await rpc(alice,'get',a);
  assert.equal(remaining.tasks[0].assignee,null);
  assert.equal(remaining.tasks[0].status,'Completed');
  assert.equal(remaining.household.buyer,null);
  assert.equal(remaining.household.day,'Friday');
  assert.equal((await rpc(bob,'get',b)).items[0].batch,batch.batch);
});
