/**
 * oao.js 的守卫测试：用假 DOM 驱动**真实的** static/oao.js，验证动作的防重复提交。
 *
 * 为什么不在 static/ 里：oao.go 是 //go:embed static，放那儿会被打进二进制、
 * 还挂在 /static/oao/ 上对外提供。testdata/ 是 Go 工具链默认忽略的目录，也不在 embed 范围。
 *
 * 为什么用假 DOM 而不是真浏览器：这个仓库没有 JS 测试设施，但 osao.js 只需要很小一块
 * DOM 表面就能跑到 runAction（见下面的 stub）。零依赖，`node` 直接跑。
 *
 * 跑法：
 *     node testdata/oao_guard_test.js static/oao.js
 *
 * 它钉的行为：同一「表 + 动作 + 行主键」在上一请求结束前重复触发只发一次；
 * 上一轮结束后放行下一次（不能永久锁死）。故意给动作不带 confirm/form，
 * 让点击直接打到 fetch，测的就是守卫本身而不是弹窗流程。
 */
const fs = require('fs');

const SRC = process.argv[2];
if (!SRC) {
    console.error('用法: node testdata/oao_guard_test.js <oao.js 路径>');
    process.exit(2);
}

/* ---------- 最小假 DOM ---------- */

function makeEl(tag) {
    const el = {
        tagName: tag, className: '', textContent: '', style: {}, dataset: {}, attrs: {}, children: [],
        _html: '',
        appendChild(c) { this.children.push(c); return c; },
        removeChild() {}, remove() {}, focus() {}, blur() {},
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
        hasAttribute(k) { return k in this.attrs; },
        addEventListener() {}, removeEventListener() {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        contains() { return false; },
    };
    Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; } });
    return el;
}

global.window = {
    addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ getPropertyValue: () => '' }), scrollX: 0, scrollY: 0,
};
global.document = {
    body: makeEl('body'),
    documentElement: makeEl('html'),
    createElement: makeEl,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
};
global.navigator = { userAgent: 'node' };

/* ---------- 假后端 ---------- */

const posts = [];
global.fetch = async (url, init) => {
    const method = ((init && init.method) || 'GET').toUpperCase();
    const u = String(url);
    const jsonResp = (obj) => ({
        ok: true, status: 200,
        json: async () => obj, text: async () => JSON.stringify(obj),
    });
    if (method === 'POST') {
        posts.push(u);
        await new Promise((r) => setTimeout(r, 30)); // 模拟请求在途
        return jsonResp({ status: 'ok' });
    }
    const action = { key: 'approve', label: '通过' };
    const cols = [{ name: 'id', label: 'ID' }, { name: 'name', label: '名字' }];
    if (u.endsWith('/tables')) {
        return jsonResp({ tables: [{ key: 'task', label: '任务', id_field: 'id', columns: cols, filters: [], actions: [action] }] });
    }
    return jsonResp({ rows: [{ id: 1, name: 'x' }], total: 1, page: 1, size: 20, columns: cols, filters: [], actions: [action] });
};

/* ---------- 驱动真实组件 ---------- */

eval(fs.readFileSync(SRC, 'utf8')); // IIFE 会把组件挂到 window.Oao
const Oao = global.window.Oao;
if (!Oao) throw new Error('window.Oao 没挂上');

// 容器：load() 里 innerHTML 随便设，querySelector('.oao-view') 返回我们的假 root，
// root.querySelectorAll('[data-action]') 返回那个按钮 —— 这样就能拿到 oao 绑上的 onclick。
const btn = makeEl('button');
btn.attrs['data-action'] = 'approve';
btn.attrs['data-row'] = '0';
const root = makeEl('div');
root.querySelectorAll = (sel) => (sel === '[data-action]' ? [btn] : []);
const container = makeEl('div');
container.querySelector = (sel) => (sel === '.oao-view' ? root : null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    Oao.init({ base: '/api/oao' });
    await Oao.render(container, 'task');
    if (typeof btn.onclick !== 'function') throw new Error('没拿到绑定后的 onclick');

    const fail = [];

    // 1) 连点：第一次请求还在途，后两次必须被吞掉
    btn.onclick();
    btn.onclick();
    btn.onclick();
    await sleep(200);
    if (posts.length !== 1) fail.push(`连点 3 次应只发 1 个 POST，实际 ${posts.length}`);

    // 2) 上一轮结束后要放行 —— 守卫不能把动作永久锁死
    btn.onclick();
    await sleep(200);
    if (posts.length !== 2) fail.push(`上一轮结束后应能再次触发（共 2 个 POST），实际 ${posts.length}`);

    if (fail.length) {
        console.error('FAIL\n  ' + fail.join('\n  '));
        process.exit(1);
    }
    console.log('PASS  连点 3 次只发 1 次请求，且上一轮结束后放行下一次');
})();
