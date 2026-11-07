// node testdata/oao_lifecycle_test.js static/oao.js
const assert = require('node:assert/strict');
const {install,load,flush} = require('./event_dom');
const {doc,create} = install();
const columns = [{name:'id',label:'ID',sortable:true}];
const tables = [{key:'task',label:'Tasks',columns,filters:[{name:'site',label:'Site',op:'eq'}],actions:[]}];
const calls = []; let pending = null; let pendingTables = null; let failSite = '';
global.fetch = async (url, init) => {
    const u = new URL(url,'http://local');
    if (u.pathname.endsWith('/tables')) {
        if (pendingTables) { pendingTables.signal=init.signal; await new Promise(resolve=>{pendingTables.resolve=resolve;}); }
        return {ok:true,json:async()=>({tables})};
    }
    const site = u.searchParams.get('filter[site]'); calls.push({site,signal:init.signal});
    if (pending && pending.site === site) await new Promise(resolve => { pending.resolve = resolve; });
    if (site === failSite) return {ok:false,status:503};
    return {ok:true,json:async()=>({columns,filters:tables[0].filters,actions:[],rows:[{id:site}],size:20,page:1,total:1})};
};
const Oao = load(process.argv[2]);
const root = () => doc.body.appendChild(create('div'));
(async () => {
    const a=root(), b=root();
    await Oao.render(a,'task',{filter:{site:'a'}});
    await Oao.render(b,'task',{filter:{site:'b'}});
    calls.length=0;
    const refreshed = await Oao.refresh('task');
    assert.deepEqual(calls.map(x=>x.site).sort(),['a','b'],'refresh(key) must refresh both independently');
    assert.equal(refreshed.length,2);
    assert.match(a.innerHTML,/>a</); assert.match(b.innerHTML,/>b</);
    calls.length=0;
    await Oao.refreshInstance(a);
    assert.deepEqual(calls.map(x=>x.site),['a']);
    failSite='a';
    const partial=await Oao.refresh('task');
    assert.equal(partial.length,2); assert.match(a.innerHTML,/HTTP 503/); assert.match(b.innerHTML,/>b</);
    assert.deepEqual(partial.map(x=>x.status),['rejected','fulfilled'],'settled results report failures separately');
    failSite='';
    pending={site:'a'};
    const late=Oao.refreshInstance(a); await flush();
    assert.ok(pending.resolve);
    Oao.destroy(a); Oao.destroy(a);
    assert.equal(calls.at(-1).signal.aborted,true,'destroy aborts in-flight GET');
    const empty=a.innerHTML; pending.resolve(); await late; pending=null;
    assert.equal(a.innerHTML,empty,'late response cannot remount destroyed view');
    calls.length=0; await Oao.refresh('task');
    assert.deepEqual(calls.map(x=>x.site),['b']);
    await Oao.render(a,'task',{filter:{site:'again'}});
    assert.match(a.innerHTML,/>again</,'explicit render can start a fresh lifetime');
    const c=root();pending={site:'old'};
    const old=Oao.render(c,'task',{filter:{site:'old'}});await flush();
    const oldSignal=calls.at(-1).signal;
    await Oao.render(c,'task',{filter:{site:'new'}});
    assert.equal(oldSignal.aborted,true);
    pending.resolve();await old;pending=null;
    assert.match(c.innerHTML,/>new</,'late same-container result cannot replace the new query');

    const host=root(), events=[], contexts=[];
    const app=await Oao.mount(host,{pages:[
        {key:'one',render(el,ctx){contexts.push(ctx);events.push('one');return()=>{assert.equal(ctx.signal.aborted,true);events.push('clean-one');};}},
        {key:'two',render(el,ctx){contexts.push(ctx);events.push('two');return{destroy(){assert.equal(ctx.signal.aborted,true);events.push('clean-two');}};}},
    ]});
    await app.open('two');
    assert.equal(contexts[0].signal.aborted,true);assert.equal(contexts[1].signal.aborted,false);
    assert.notEqual(contexts[0].signal,contexts[1].signal);
    app.destroy();app.destroy();Oao.destroy(host);
    assert.deepEqual(events,['one','clean-one','two','clean-two']);
    await app.open('one');assert.deepEqual(events,['one','clean-one','two','clean-two'],'destroyed mount cannot navigate');

    const left=await Oao.mount(root(),{pages:[{key:'blank',render(){}}]});
    const right=await Oao.mount(root(),{pages:[{key:'blank',render(){}}]});
    pending={site:'left'};const loading=left.open('task',{filter:{site:'left'}});await flush();
    const leftSignal=calls.at(-1).signal;
    await right.open('task',{filter:{site:'right'}});
    assert.equal(leftSignal.aborted,false,'another mount cannot invalidate this mount');
    pending.resolve();await loading;pending=null;
    assert.match(left.content().innerHTML,/>left</);assert.match(right.content().innerHTML,/>right</);
    await left.open('blank');await left.open('task');assert.match(left.content().innerHTML,/>left</,'container-local query survives navigation');
    left.destroy();right.destroy();

    let lateRenderer, unexpectedCleanup=false;
    const promises=await Oao.mount(root(),{pages:[
        {key:'promise',render(){return new Promise(resolve=>{lateRenderer=resolve;});}},
        {key:'blank',render(){}},
    ]});
    await promises.open('blank');lateRenderer(()=>{unexpectedCleanup=true;});await flush();promises.destroy();
    assert.equal(unexpectedCleanup,false,'a Promise result is never used as a lifecycle disposer');
    const reentrant=[];
    const nested=await Oao.mount(root(),{pages:[
        {key:'first',render(el,ctx){ctx.open('second');return()=>{assert.equal(ctx.signal.aborted,true);reentrant.push('late-cleanup');};}},
        {key:'second',render(){reentrant.push('second');}},
    ]});
    nested.destroy();assert.deepEqual(reentrant,['second','late-cleanup'],'reentrant navigation disposes a late returned cleanup exactly once');
    const mountingRoot=root();pendingTables={};
    const mounting=Oao.mount(mountingRoot,{pages:[{key:'late',render(){throw new Error('destroyed mount must not render');}}]});await flush();
    Oao.destroy(mountingRoot);assert.equal(pendingTables.signal.aborted,true,'destroy aborts initial metadata request too');
    pendingTables.resolve();await mounting;pendingTables=null;
    assert.equal(mountingRoot.innerHTML,'');
    console.log('PASS independent table instances, aggregate refresh, abort/late responses, and mount page cleanup');
})().catch(e=>{console.error(e);process.exitCode=1;});
