// node testdata/oao_pager_test.js static/oao.js
const assert = require('node:assert/strict');
const { makeEl, installDom, loadOao } = require('./fake_dom.js');
installDom();
// Toast 的定时清理无需拖延测试退出。
const realTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => { const t = realTimeout(fn, ms); t.unref(); return t; };
let total = 250;
const calls = [];
const columns = [{ name: 'id', label: 'ID' }];
global.fetch = async (url) => {
    const u = new URL(url, 'http://test');
    const data = u.pathname.endsWith('/tables')
        ? { tables: [{ key: 'task', columns, filters: [], default_sort: '-id' }] }
        : { columns, filters: [], rows: [], total, page: Number(u.searchParams.get('page')), size: Number(u.searchParams.get('size')) || 50 };
    if (!u.pathname.endsWith('/tables')) calls.push(u.searchParams);
    return { ok: true, json: async () => data };
};
const Oao = loadOao(process.argv[2]);
const root = { _html: '' };
const input = makeEl('input');
const button = makeEl('button');
const pageSize = makeEl('button');
const view = makeEl('div');
view.querySelector = (sel) => ({ '[data-page-input]': input, '[data-page-jump]': button, '[data-pagesize]': pageSize }[sel] || null);
root.querySelector = () => view;
Object.defineProperty(root, 'innerHTML', {
    get() { return this._html; },
    set(html) {
        this._html = html;
        const match = html.match(/data-last="(\d+)"/);
        if (match) input.setAttribute('data-last', match[1]);
    },
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const jump = async (value, enter) => {
    input.value = value;
    if (enter) input.onkeydown({ key: 'Enter', preventDefault() {} });
    else button.onclick();
    await flush();
};
(async () => {
    Oao.init({ base: '/api/oao' });
    await Oao.render(root, 'task', { filter: { site: 'huangguo' } });
    assert.match(root.innerHTML, /data-page-input/, '应渲染页码输入框');
    assert.match(root.innerHTML, /data-page-jump/, '应渲染跳转按钮');
    // 选择每页条数后跳页，确认状态始终保留。
    pageSize.__oaoSelect.onChange('50');
    await flush();
    await jump('3', false);
    await jump('5', true);
    for (const [i, page] of [[calls.length - 2, '3'], [calls.length - 1, '5']]) {
        assert.equal(calls[i].get('page'), page);
        assert.equal(calls[i].get('size'), '50');
        assert.equal(calls[i].get('sort'), '-id');
        assert.equal(calls[i].get('filter[site]'), 'huangguo');
    }
    for (const value of ['', ' ', 'abc', '2.5', '1e0', '-1', '0', '6', '9007199254740993']) {
        const count = calls.length;
        const toasts = document.body.children.find(el => el.className === 'oao-toasts');
        const before = toasts ? toasts.children.length : 0;
        await jump(value, true);
        assert.equal(calls.length, count, '非法页码不能发请求：' + value);
        const after = document.body.children.find(el => el.className === 'oao-toasts');
        assert.ok(after && after.children.length > before, '非法页码应提示：' + value);
    }
    total = 0;
    await Oao.render(root, 'task');
    await jump('1', false);
    assert.equal(calls.at(-1).get('page'), '1');
    const count = calls.length;
    await jump('2', false);
    assert.equal(calls.length, count);
    console.log('PASS 页码跳转、查询条件保留、非法输入提示与空表边界');
})().catch(err => { console.error(err); process.exitCode = 1; });
