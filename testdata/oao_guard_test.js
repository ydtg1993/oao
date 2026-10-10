/**
 * oao.js 的守卫测试：用假 DOM 驱动**真实的** static/oao.js，验证动作的防重复提交。
 *
 * 假 DOM 与假后端在同目录的 `fake_dom.js`（几个 JS 测试共用一份，别各写各的）。
 *
 * 跑法：
 *     node testdata/oao_guard_test.js static/oao.js
 *
 * 它钉的行为：同一「表 + 动作 + 行主键」在上一请求结束前重复触发只发一次；
 * 上一轮结束后放行下一次（不能永久锁死）。故意给动作不带 confirm/form，
 * 让点击直接打到 fetch，测的就是守卫本身而不是弹窗流程。
 */
const { makeEl, installDom, loadOao, installFetch, sleep } = require('./fake_dom.js');

const SRC = process.argv[2];
if (!SRC) {
    console.error('用法: node testdata/oao_guard_test.js <oao.js 路径>');
    process.exit(2);
}

installDom();
const rec = installFetch(); // 默认那张 task 表：两列、无筛选、一个不带 confirm/form 的动作
const Oao = loadOao(SRC);

// 容器：load() 里 innerHTML 随便设，querySelector('.oao-view') 返回我们的假 root，
// root.querySelectorAll('[data-action]') 返回那个按钮 —— 这样就能拿到 oao 绑上的 onclick。
const btn = makeEl('button');
btn.attrs['data-action'] = 'approve';
btn.attrs['data-row'] = '0';
const root = makeEl('div');
root.querySelectorAll = (sel) => (sel === '[data-action]' ? [btn] : []);
const container = makeEl('div');
container.querySelector = (sel) => (sel === '.oao-view' ? root : null);

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
    if (rec.posts.length !== 1) fail.push(`连点 3 次应只发 1 个 POST，实际 ${rec.posts.length}`);

    // 2) 上一轮结束后要放行 —— 守卫不能把动作永久锁死
    btn.onclick();
    await sleep(200);
    if (rec.posts.length !== 2) fail.push(`上一轮结束后应能再次触发（共 2 个 POST），实际 ${rec.posts.length}`);

    if (fail.length) {
        console.error('FAIL\n  ' + fail.join('\n  '));
        process.exit(1);
    }
    console.log('PASS  连点 3 次只发 1 次请求，且上一轮结束后放行下一次');
})();
