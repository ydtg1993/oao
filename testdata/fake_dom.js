/**
 * oao.js 的 JS 测试**共用假件**：一块最小 DOM + 可编程的假 fetch。
 *
 * 为什么不用真浏览器：这个仓库没有 JS 测试设施，而 oao.js 只需要很小一块 DOM 表面
 * （见 `makeEl`）就能跑到"渲染"与"动作"这两条路。零依赖，`node` 直接跑。
 *
 * 为什么放 `testdata/`：`oao.go` 是 `//go:embed static` —— 测试文件放进 `static/`
 * 会被打进二进制、还挂在 `/static/oao/` 上对外提供。`testdata/` 是 Go 工具链默认忽略
 * 的目录，也不在 embed 范围里。
 *
 * 用法见同目录两个脚本（各自的头部写了它钉什么行为）：
 *
 *     const { installDom, loadOao, installFetch, makeEl, sleep } = require('./fake_dom.js');
 *     installDom();
 *     const rec = installFetch({ ... });   // rec.gets / rec.posts 是记录下来的请求 URL
 *     const Oao = loadOao(process.argv[2]);
 */
const fs = require('fs');

/** makeEl 造一个属性齐全的空元素；`innerHTML` 只是个可读写字符串（不做真解析）。 */
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

/** installDom 把 window / document / navigator 挂到 global（每个测试脚本开头调一次）。 */
function installDom() {
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
}

/** loadOao 读源码 eval 进来（IIFE 会把组件挂到 `window.Oao`），返回那个对象。 */
function loadOao(srcPath) {
    eval(fs.readFileSync(srcPath, 'utf8'));
    const Oao = global.window.Oao;
    if (!Oao) throw new Error('window.Oao 没挂上');
    return Oao;
}

/**
 * installFetch 装一个假后端，返回记录器 `{ gets, posts }`（元素是请求 URL 的原文）。
 *
 * - `tables` / `columns` / `filters` / `rows` / `actions` 决定 `/tables` 与列表接口回什么；
 *   都不传就是"一张 task 表、两列、无筛选、一行数据、一个不带 confirm/form 的动作"。
 * - `postDelayMs` 让 POST 停在"请求在途"状态（防重复提交那条用例要它），默认 30ms。
 */
function installFetch(opts) {
    opts = opts || {};
    const rec = { gets: [], posts: [] };
    const actions = opts.actions === undefined ? [{ key: 'approve', label: '通过' }] : opts.actions;
    const columns = opts.columns || [{ name: 'id', label: 'ID' }, { name: 'name', label: '名字' }];
    const filters = opts.filters || [];
    const rows = opts.rows || [{ id: 1, name: 'x' }];
    const tables = opts.tables || [{
        key: 'task', label: '任务', id_field: 'id',
        columns: columns, filters: filters, actions: actions,
    }];
    const delay = opts.postDelayMs === undefined ? 30 : opts.postDelayMs;

    global.fetch = async (url, init) => {
        const u = String(url);
        const jsonResp = (obj) => ({
            ok: true, status: 200,
            json: async () => obj, text: async () => JSON.stringify(obj),
        });
        if ((((init && init.method) || 'GET')).toUpperCase() === 'POST') {
            rec.posts.push(u);
            await new Promise((r) => setTimeout(r, delay)); // 模拟请求在途
            return jsonResp({ status: 'ok' });
        }
        rec.gets.push(u);
        if (u.indexOf('/tables') > -1) return jsonResp({ tables: tables });
        return jsonResp({
            rows: rows, total: rows.length, page: 1, size: 20,
            columns: columns, filters: filters, actions: actions,
        });
    };
    return rec;
}

/** sleep 等一小会儿（假后端是异步的，断言前得让它跑完）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { makeEl, installDom, loadOao, installFetch, sleep };
