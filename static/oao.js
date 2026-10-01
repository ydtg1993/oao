/**
 * Oao — 表格渲染器
 *
 * 宿主页面与独立 demo 都用它渲染表格。
 * 只负责"按后端给的元数据把表格画出来"，不做任何数据或业务判断。
 *
 * 用法：
 *   Oao.init({ base: '/api/oao' });
 *   Oao.render(document.getElementById('app'), 'order');
 */
window.Oao = (function () {
    'use strict';

    var base = '/api/oao';
    var state = {};      // key -> { meta, query, el }
    var metas = null;    // 表格清单缓存

    /* ---------- 工具 ---------- */
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function tip(text) {
        var s = text == null ? '' : String(text);
        return s ? ' data-tip="' + esc(s) + '"' : '';
    }
    function fmtTime(v, onlyDate) {
        if (!v) return '-';
        var d = new Date(v);
        if (isNaN(d.getTime())) return String(v);
        var p = function (n) { return String(n).padStart(2, '0'); };
        var ymd = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
        return onlyDate ? ymd : ymd + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    async function api(path) {
        var resp;
        try { resp = await fetch(base + path, { headers: authHeaders() }); }
        catch (e) { throw new Error('连接失败'); }
        if (resp.status === 401) throw new Error('未授权');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
    }
    /** 宿主可覆盖：把访问密钥等带上 */
    var authHeaders = function () { return {}; };

    /* ---------- 单元格渲染 ---------- */
    function cell(col, row) {
        var v = row[col.name];
        if (col.render === 'enum') {
            if (v === null || v === undefined || v === '') return '<span class="muted">-</span>';
            var text = (col.enum && col.enum[String(v)]) || String(v);
            var tone = (col.tone && col.tone[String(v)]) || '';
            return '<span class="badge ' + esc(tone) + '">' + esc(text) + '</span>';
        }
        if (v === null || v === undefined || v === '') return '<span class="muted">-</span>';

        switch (col.render) {
            case 'time':
                return esc(fmtTime(v, col.format === 'date'));
            case 'image':
                return '<img class="oao-img" src="' + esc(v) + '" width="' + (col.size || 64)
                    + '" height="' + (col.size || 64) + '" alt="" loading="lazy" onerror="this.style.opacity=.25">';
            case 'link':
                var href = String(col.href || '').replace(/\{([a-z0-9_]+)\}/gi, function (_, k) {
                    return encodeURIComponent(row[k] == null ? '' : row[k]);
                });
                return href ? '<a class="oao-link" href="' + esc(href) + '">' + esc(v) + '</a>' : esc(v);
            case 'input':
                return '<input class="oao-input" readonly value="' + esc(v) + '" style="width:'
                    + (col.max_len || 24) + 'ch">';
            case 'json':
                return '<details class="oao-json"><summary>' + esc(String(v).slice(0, 60)) + '</summary>'
                    + esc(typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '</details>';
            case 'custom':
                return col.html || '';
            default:
                var s = String(v);
                return '<span class="oao-ellipsis"' + tip(s) + '>' + esc(s) + '</span>';
        }
    }

    /* ---------- 筛选栏 ---------- */
    function filterBar(meta) {
        if (!meta.filters || meta.filters.length === 0) return '';
        var st = state[meta.key];
        return '<div class="oao-filters">' + meta.filters.map(function (f) {
            var val = st.query.filter[f.name] || '';
            var head = '<span>' + esc(f.label) + '</span>';
            if (f.widget === 'select' && f.options && Object.keys(f.options).length) {
                var opts = Object.keys(f.options);
                // 多选对应 OpIn，选项多时也是多选（筛选栏更直观）
                if (f.op === 'in') {
                    var chosen = val ? val.split(',') : [];
                    return '<div class="f"><span>' + esc(f.label) + '</span><div class="multi">'
                        + opts.map(function (o) {
                            return '<label><input type="checkbox" data-filter="' + esc(f.name) + '" value="'
                                + esc(o) + '"' + (chosen.indexOf(o) > -1 ? ' checked' : '') + '>'
                                + esc(f.options[o]) + '</label>';
                        }).join('') + '</div></div>';
                }
                return '<div class="f">' + head + '<select data-filter="' + esc(f.name) + '">'
                    + '<option value="">全部</option>'
                    + opts.map(function (o) {
                        return '<option value="' + esc(o) + '"' + (val === o ? ' selected' : '') + '>'
                            + esc(f.options[o]) + '</option>';
                    }).join('') + '</select></div>';
            }
            if (f.widget === 'daterange') {
                var lo = '', hi = '';
                if (val.indexOf('..') > -1) { var p = val.split('..'); lo = p[0]; hi = p[1]; }
                return '<div class="f">' + head + '<div class="range">'
                    + '<input type="date" data-filter="' + esc(f.name) + '" data-part="lo" value="' + esc(lo) + '">'
                    + '<i>~</i>'
                    + '<input type="date" data-filter="' + esc(f.name) + '" data-part="hi" value="' + esc(hi) + '">'
                    + '</div></div>';
            }
            if (f.widget === 'date') {
                return '<div class="f">' + head + '<input type="date" data-filter="' + esc(f.name)
                    + '" value="' + esc(val) + '"></div>';
            }
            return '<div class="f">' + head + '<input data-filter="' + esc(f.name) + '" placeholder="筛选" value="'
                + esc(val) + '"></div>';
        }).join('') + '</div>';
    }

    /* ---------- 表格 / 分页 ---------- */
    function table(cols, rows, sort) {
        if (!rows.length) return '<div class="oao-loading">没有数据</div>';
        var head = cols.map(function (c) {
            var arrow = sort === c.name ? ' ▲' : (sort === '-' + c.name ? ' ▼' : '');
            return c.sortable
                ? '<th class="sortable" data-sort="' + esc(c.name) + '">' + esc(c.label) + arrow + '</th>'
                : '<th>' + esc(c.label) + '</th>';
        }).join('');
        var body = rows.map(function (r) {
            return '<tr>' + cols.map(function (c) { return '<td>' + cell(c, r) + '</td>'; }).join('') + '</tr>';
        }).join('');
        return '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead>'
            + '<tbody>' + body + '</tbody></table></div>';
    }

    function pager(meta, data) {
        var last = Math.max(1, Math.ceil(data.total / data.size));
        return '<div class="oao-pager">'
            + '<span>共 ' + data.total + ' 条</span>'
            + '<select data-pagesize>' + (meta.page_sizes || [20, 50, 100]).map(function (s) {
                return '<option value="' + s + '"' + (s === data.size ? ' selected' : '') + '>' + s + ' 条/页</option>';
            }).join('') + '</select>'
            + '<button class="pg" data-go="' + (data.page - 1) + '"' + (data.page <= 1 ? ' disabled' : '') + '>上一页</button>'
            + '<span>第 ' + data.page + ' / ' + last + ' 页</span>'
            + '<button class="pg" data-go="' + (data.page + 1) + '"' + (data.page >= last ? ' disabled' : '') + '>下一页</button>'
            + '</div>';
    }

    /* ---------- 状态与取数 ---------- */
    function stateOf(key) {
        if (!state[key]) {
            state[key] = { meta: null, query: { page: 1, size: 0, search: '', sort: '', filter: {} }, el: null };
        }
        return state[key];
    }

    function queryString(q) {
        var out = 'page=' + q.page + (q.size ? '&size=' + q.size : '');
        if (q.search) out += '&search=' + encodeURIComponent(q.search);
        if (q.sort) out += '&sort=' + encodeURIComponent(q.sort);
        for (var k in q.filter) {
            if (q.filter[k] !== '' && q.filter[k] != null) {
                out += '&filter[' + encodeURIComponent(k) + ']=' + encodeURIComponent(q.filter[k]);
            }
        }
        return out;
    }

    /** 从 DOM 读回筛选值（多选拼逗号串，区间拼 a..b） */
    function readFilter(st, root) {
        var filter = {};
        root.querySelectorAll('[data-filter]').forEach(function (el) {
            var name = el.getAttribute('data-filter');
            if (el.type === 'checkbox') {
                if (el.checked) filter[name] = filter[name] ? filter[name] + ',' + el.value : el.value;
                else if (!(name in filter)) filter[name] = '';
                return;
            }
            if (el.getAttribute('data-part')) {
                var parts = (filter[name] || '..').split('..');
                if (el.getAttribute('data-part') === 'lo') parts[0] = el.value; else parts[1] = el.value;
                filter[name] = parts.join('..');
                return;
            }
            filter[name] = el.value.trim();
        });
        // 区间只填了一半就不提交
        Object.keys(filter).forEach(function (k) {
            var v = filter[k];
            if (typeof v === 'string' && v.indexOf('..') > -1) {
                var p = v.split('..');
                if (!p[0] || !p[1]) delete filter[k];
                else filter[k] = p[0] + '..' + p[1];
            }
        });
        st.query.filter = filter;
    }

    async function load(key) {
        var st = stateOf(key);
        if (!st.el) return;
        if (!st.meta) {
            st.meta = (await api('/tables')).tables.filter(function (t) { return t.key === key; })[0];
            // 用默认排序初始化，让表头一开始就显示出排序方向
            if (st.meta && st.meta.default_sort) st.query.sort = st.meta.default_sort;
        }
        if (!st.meta) throw new Error('未知表格：' + key);

        st.el.innerHTML = '<div class="oao-loading">加载中...</div>';
        var data = await api('/' + encodeURIComponent(key) + '?' + queryString(st.query));
        st.meta.columns = data.columns;
        st.meta.filters = data.filters;

        st.el.innerHTML = filterBar(st.meta) + table(data.columns, data.rows, st.query.sort) + pager(st.meta, data);
        bind(st, st.el, key);
    }

    function bind(st, root, key) {
        root.querySelectorAll('th[data-sort]').forEach(function (th) {
            th.onclick = function () {
                var col = th.getAttribute('data-sort');
                st.query.sort = st.query.sort === col ? '-' + col : col;
                st.query.page = 1;
                load(key);
            };
        });
        root.querySelectorAll('[data-go]').forEach(function (b) {
            b.onclick = function () { st.query.page = parseInt(b.getAttribute('data-go'), 10); load(key); };
        });
        root.querySelectorAll('[data-pagesize]').forEach(function (s) {
            s.onchange = function () { st.query.size = parseInt(s.value, 10); st.query.page = 1; load(key); };
        });
        root.querySelectorAll('[data-filter]').forEach(function (el) {
            var ev = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'date') ? 'change' : 'keydown';
            el.addEventListener(ev, function (e) {
                if (ev === 'keydown' && e.key !== 'Enter') return;
                if (ev === 'keydown') st.query.search = '';
                readFilter(st, root);
                st.query.page = 1;
                load(key);
            });
        });
    }

    /* ---------- 对外 API ---------- */
    return {
        /** 初始化：base 为 API 前缀；headers 回调用于带鉴权信息 */
        init: function (opts) {
            opts = opts || {};
            if (opts.base) base = opts.base;
            if (opts.headers) authHeaders = opts.headers;
        },
        /** 表格清单（渲染菜单用）；force=true 时强制重取 */
        list: async function (force) {
            if (!metas || force) metas = (await api('/tables')).tables;
            return metas;
        },
        /** 把某张表渲染进容器 */
        render: async function (container, key) {
            var st = stateOf(key);
            st.el = container;
            st.query.page = 1;
            await load(key);
        },
        /** 重新加载当前表（外部操作后刷新用） */
        refresh: function (key) { return load(key); }
    };
})();
