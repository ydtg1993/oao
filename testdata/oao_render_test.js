/**
 * oao.js 的渲染测试：**预置筛选**（`Oao.render` 的第三个参数 `opts.filter`）。
 *
 * 假 DOM 与假后端在同目录的 `fake_dom.js`（几个 JS 测试共用一份）。
 * 跑法：
 *     node testdata/oao_render_test.js static/oao.js
 *
 * 它钉三件事：
 *   ① 预置的筛选真的进了列表请求（`filter[site]=huangguo`）；
 *   ② 筛选栏里看得见它 —— 是"帮你填好"而不是"偷偷锁上"，用户能改能清；
 *   ③ 不带 opts 再渲染一次时条件保持不变（不会被清掉，与加这个参数之前的行为一致）。
 */
const { makeEl, installDom, loadOao, installFetch } = require('./fake_dom.js');

const SRC = process.argv[2];
if (!SRC) {
    console.error('用法: node testdata/oao_render_test.js <oao.js 路径>');
    process.exit(2);
}

installDom();
// 任务表声明了「站点」筛选（papa 的后台任务表就是这样），行里也带这一列
const rec = installFetch({
    filters: [{ name: 'site', label: '站点', op: 'eq' }],
    rows: [{ id: 1, site: 'huangguo' }],
});
const Oao = loadOao(SRC);

const container = makeEl('div');
container.querySelector = (sel) => (sel === '.oao-view' ? makeEl('div') : null);

// 列表请求 = 除 /tables 之外的那些 GET
const listCalls = () => rec.gets.filter((u) => u.indexOf('/tables') < 0);

(async () => {
    const fail = [];
    Oao.init({ base: '/api/oao' });

    // ① + ② 带着站点打开任务表
    await Oao.render(container, 'task', { filter: { site: 'huangguo' } });
    const first = listCalls().pop() || '';
    if (first.indexOf('filter%5Bsite%5D=huangguo') < 0 && first.indexOf('filter[site]=huangguo') < 0) {
        fail.push(`预置筛选没进列表请求：${first}`);
    }
    if (container.innerHTML.indexOf('value="huangguo"') < 0) {
        fail.push('筛选栏里看不见预置值（应当能改能清，而不是藏起来）：' + container.innerHTML.slice(0, 200));
    }

    // ③ 不带 opts 重渲染：保持上一次的条件
    await Oao.render(container, 'task');
    const second = listCalls().pop() || '';
    if (second.indexOf('filter%5Bsite%5D=huangguo') < 0 && second.indexOf('filter[site]=huangguo') < 0) {
        fail.push(`不带 opts 重渲染时不该丢掉上一次的条件：${second}`);
    }

    if (fail.length) {
        console.error('FAIL\n  ' + fail.join('\n  '));
        process.exit(1);
    }
    console.log('PASS  预置筛选进了请求、筛选栏里看得见，且不带 opts 重渲染时保持');
})();
