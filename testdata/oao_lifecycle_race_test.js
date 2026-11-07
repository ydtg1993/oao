// node testdata/oao_lifecycle_race_test.js static/oao.js
// Deferred requests and reentrant host callbacks exercise the production code.
const assert = require('node:assert/strict');
const {install, load, flush} = require('./event_dom');
const tests = [];
const test = (name, fn) => tests.push({name, fn});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
function setup(options = {}) {
    const dom = install();
    const columns = [{name:'id', label:'ID'}];
    const actions = options.actions || [{key:'save', label:'Save'}];
    const requests = [], posts = [];
    global.fetch = async (url, init) => {
        requests.push({url, init});
        if (init.method === 'POST') { const response = deferred(); posts.push(response); return response.promise; }
        return {ok:true, json:async () => url.endsWith('/tables')
            ? {tables:[{key:'task', label:'Tasks', columns, filters:[], actions}]}
            : {columns, filters:[], actions, rows:[{id:1}], size:20, page:1, total:1}};
    };
    return {...dom, Oao:load(process.argv[2]), requests, posts, root:() => dom.doc.body.appendChild(dom.create('div'))};
}

for (const transition of ['destroy-and-render', 'render-same-key', 'leave-and-return']) {
    test('late POST success is silent after ' + transition, async () => {
        const {Oao, root, doc, requests, posts} = setup();
        const host = root();
        let app, table = host;
        if (transition === 'leave-and-return') {
            app = await Oao.mount(host, {pages:[{key:'blank', render(){}}]});
            await app.open('task'); table = app.content();
        } else await Oao.render(table, 'task');
        table.querySelector('[data-action]').click(); await flush();
        assert.equal(posts.length, 1);
        if (transition === 'destroy-and-render') Oao.destroy(table);
        if (app) { await app.open('blank'); await app.open('task'); }
        else await Oao.render(table, 'task');
        const requestCount = requests.length;
        posts[0].resolve({ok:true}); await flush();
        assert.equal(requests.length, requestCount, 'old action must not refresh a replacement view');
        assert.equal(doc.querySelector('.oao-toast'), null, 'old action must not announce success in a new view');
        Oao.destroy(host);
    });
}

test('late POST error is silent after destroy', async () => {
    const {Oao, root, doc, posts} = setup(); const table = root();
    await Oao.render(table, 'task'); table.querySelector('[data-action]').click(); await flush();
    Oao.destroy(table); posts[0].resolve({ok:false, status:503, text:async () => 'offline'}); await flush();
    assert.equal(doc.querySelector('.oao-toast'), null);
});

test('a stale action does not retry POST after asynchronous credential recovery', async () => {
    const {Oao, root, posts, doc} = setup(); const table = root(), auth = deferred();
    Oao.init({onUnauthorized:() => auth.promise});
    await Oao.render(table, 'task'); table.querySelector('[data-action]').click(); await flush();
    posts[0].resolve({ok:false, status:401}); await flush();
    Oao.destroy(table); await Oao.render(table, 'task'); auth.resolve(true); await flush();
    assert.equal(posts.length, 1, 'a new POST cannot be sent on behalf of an invalidated view');
    assert.equal(doc.querySelector('.oao-toast'), null); Oao.destroy(table);
});

test('current POST still refreshes all live same-key views', async () => {
    const {Oao, root, doc, requests, posts} = setup(); const first = root(), second = root();
    await Oao.render(first, 'task'); await Oao.render(second, 'task');
    first.querySelector('[data-action]').click(); await flush(); const before = requests.length;
    posts[0].resolve({ok:true}); await flush();
    assert.equal(requests.length, before + 2); assert.match(doc.querySelector('.oao-toast').textContent, /成功/);
    Oao.destroy(first); Oao.destroy(second);
});

for (const callback of ['cleanup', 'abort']) {
    test(callback + ' navigation wins over the superseded outer navigation', async () => {
        const {Oao, root} = setup(); const events = []; let api, redirectedContext;
        const app = await Oao.mount(root(), {pages:[
            {key:'first', render(el, context) {
                const redirect = () => { events.push(callback); api.open('redirected'); };
                if (callback === 'abort') context.signal.addEventListener('abort', redirect, {once:true});
                return callback === 'cleanup' ? redirect : undefined;
            }},
            {key:'outer', render(){ events.push('outer'); }},
            {key:'redirected', render(el, context){ redirectedContext = context; events.push('redirected'); return () => events.push('clean-redirected'); }},
        ], onReady(value){ api = value; }});
        await app.open('outer');
        assert.equal(app.current(), 'redirected', 'newer reentrant navigation must not be overwritten');
        app.destroy();
        assert.equal(redirectedContext.signal.aborted, true);
        assert.deepEqual(events, [callback, 'redirected', 'clean-redirected']);
    });
}

test('cleanup can destroy the mount while navigation is leaving a page', async () => {
    const {Oao, root} = setup(); const host = root(); let app, newPage = false;
    app = await Oao.mount(host, {pages:[
        {key:'first', render(){ return () => app.destroy(); }},
        {key:'second', render(){ newPage = true; }},
    ]});
    await app.open('second');
    assert.equal(newPage, false); assert.equal(app.current(), null); assert.equal(host.innerHTML, '');
});

test('a mount started by cleanup retains ownership after the old mount is destroyed', async () => {
    const {Oao, root} = setup(); const host = root(); let replacement, replacementCleanup = 0;
    const app = await Oao.mount(host, {pages:[{key:'old', render(){ return () => {
        replacement = Oao.mount(host, {pages:[{key:'new', render(){ return () => replacementCleanup++; }}]});
    }; }}]});
    app.destroy(); await replacement;
    Oao.destroy(host);
    assert.equal(replacementCleanup, 1, 'destroy must still find the replacement mount');
});

test('stale page navigation methods retain their Promise contract', async () => {
    const {Oao, root} = setup(); let previous;
    const app = await Oao.mount(root(), {pages:[{key:'first', render(el, context){ previous = context; }}, {key:'second', render(){}}]});
    await app.open('second');
    for (const method of ['open', 'select', 'reload']) {
        const pending = previous[method]('first');
        assert.ok(pending && typeof pending.then === 'function', method + ' must remain awaitable/thenable when invalidated');
        await pending;
    }
    assert.equal(app.current(), 'second'); app.destroy();
});

for (const failure of ['throw', 'reject']) {
    test('renderer ' + failure + ' aborts its failed page lifetime', async () => {
        const {Oao, root} = setup(); let context; const failed = deferred();
        const app = await Oao.mount(root(), {pages:[{key:'broken', render(el, page) {
            context = page;
            if (failure === 'throw') throw new Error('render broke');
            return failed.promise;
        }}, {key:'healthy', render(){}}]});
        if (failure === 'reject') { failed.reject(new Error('render broke')); await flush(); }
        assert.match(app.content().querySelector('.oao-error').textContent, /render broke/);
        assert.equal(context.signal.aborted, true, 'work started by the failed renderer must be cancelled');
        await app.open('healthy'); app.destroy();
    });
}

test('a rejected renderer with no Error value shows a recoverable failure', async () => {
    const {Oao, root} = setup(); const failed = deferred(), unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    const app = await Oao.mount(root(), {pages:[{key:'broken', render(){ return failed.promise; }}]});
    failed.reject(null); await flush(); await flush();
    process.removeListener('unhandledRejection', onUnhandled);
    assert.equal(unhandled.length, 0, 'failure reporting must not throw another rejection');
    assert.ok(app.content().querySelector('.oao-error')); app.destroy();
});

test('submitted form values survive a dialog opened during focus restoration', async () => {
    const form = [{name:'name', label:'Name'}];
    const {Oao, root, doc, requests, posts} = setup({actions:[{key:'save', label:'Save', form}, {key:'other', label:'Other', form}]});
    const table = root(); await Oao.render(table, 'task');
    const first = table.querySelector('[data-action="save"]'), other = table.querySelector('[data-action="other"]');
    first.focus(); first.click(); await flush();
    const dialog = doc.querySelector('[role="dialog"]'); dialog.querySelector('input[data-field="name"]').value = 'original value';
    let redirect = true;
    first.addEventListener('focusin', () => { if (redirect) { redirect = false; other.click(); } });
    dialog.querySelector('.oao-dlg-actions').querySelectorAll('button')[1].click(); await flush();
    const post = requests.find(call => call.init.method === 'POST');
    assert.equal(JSON.parse(post.init.body).values.name, 'original value', 'submission must use the form that was confirmed');
    Oao.destroy(table); posts[0].resolve({ok:true}); await flush();
});

(async () => {
    let failures = 0;
    for (const {name, fn} of tests) {
        try { await fn(); console.log('PASS ' + name); }
        catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
    }
    if (failures) process.exitCode = 1;
})();
