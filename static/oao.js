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
    var state = {};      // key -> { key, seq, meta, rows, query, el }

    /* ---------- 工具 ---------- */
    /** fmtNum 数字插值：契约上这些来自 Source，统一转一次保证是数字 */
    function fmtNum(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
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

    /**
     * request 所有请求的唯一出口。
     *
     * 鉴权交给宿主：authHeaders 每次请求都回调一次（token 轮换也跟得上）；
     * 收到 401 时先问 onUnauthorized，它返回 true 就带着新凭据重试一次 ——
     * 宿主可以在那里弹登录框、刷新 token。
     */
    async function request(url, opts) {
        opts = opts || {};
        var send = function () {
            var headers = authHeaders() || {};
            if (opts.body !== undefined) headers = Object.assign({ 'Content-Type': 'application/json' }, headers);
            return fetch(url, { method: opts.method || 'GET', headers: headers, body: opts.body });
        };

        var resp;
        try { resp = await send(); }
        catch (e) { throw new Error('连接失败'); }

        if (resp.status === 401 && onUnauthorized) {
            var retried = false;
            try { retried = (await onUnauthorized()) === true; } catch (e) { retried = false; }
            if (retried) {
                try { resp = await send(); }
                catch (e) { throw new Error('连接失败'); }
            }
        }
        if (resp.status === 401) throw new Error('未授权：请检查访问凭据');
        return resp;
    }

    async function api(path) {
        var resp = await request(base + path);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
    }
    /** 宿主可覆盖：把访问密钥等带上 */
    var authHeaders = function () { return {}; };
    /** 宿主可覆盖：401 时回调，返回 true 表示已换好凭据、可以重试一次 */
    var onUnauthorized = null;

    /** 提交操作；失败时抛出后端返回的提示语（业务用 oao.Fail 指定的） */
    async function postAction(table, key, payload) {
        var resp = await request(
            base + '/' + encodeURIComponent(table) + '/action/' + encodeURIComponent(key),
            { method: 'POST', body: JSON.stringify(payload || {}) });
        if (resp.status === 404) throw new Error('该操作不存在');
        if (!resp.ok) {
            var msg = (await resp.text()).trim();
            throw new Error(msg || ('HTTP ' + resp.status));
        }
        return true;
    }

    /* ---------- 弹窗与提示（组件自带，只吃设计 token，不依赖宿主） ---------- */
    var Dialog = (function () {
        var mask = null, elTitle = null, elBody = null, elActions = null, settle = null;

        function ensure() {
            if (mask) return;
            mask = document.createElement('div');
            mask.className = 'oao-mask';
            mask.innerHTML = '<div class="oao-dlg" role="dialog" aria-modal="true">'
                + '<h3></h3><div class="oao-dlg-body"></div><div class="oao-dlg-actions"></div></div>';
            mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(null); });
            document.body.appendChild(mask);
            elTitle = mask.querySelector('h3');
            elBody = mask.querySelector('.oao-dlg-body');
            elActions = mask.querySelector('.oao-dlg-actions');
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && mask.classList.contains('open')) close(null);
            });
        }
        function close(value) {
            if (!mask || !mask.classList.contains('open')) return;
            mask.classList.remove('open');
            var done = settle; settle = null;
            if (done) done(value);
        }
        /** 打开弹窗；bodyHTML 与 actions 由调用方组装（内容都要自己转义） */
        function open(opts) {
            ensure();
            // 已经开着就先关掉上一个：不然它的 Promise 永远不 resolve，
            // 调用方的 await 会一直挂着
            if (settle) close(null);
            mask.querySelector('.oao-dlg').classList.toggle('danger', !!opts.danger);
            elTitle.textContent = opts.title || '提示';
            elBody.innerHTML = opts.body || '';
            elActions.innerHTML = '';
            (opts.actions || [{ label: '知道了', value: true }]).forEach(function (a) {
                var b = document.createElement('button');
                b.className = 'oao-btn' + (a.tone === 'err' ? ' danger' : '');
                b.textContent = a.label;
                b.onclick = function () {
                    // onClick 返回 false 表示校验没过，弹窗不关
                    if (a.onClick && a.onClick() === false) return;
                    close(a.value);
                };
                elActions.appendChild(b);
            });
            mask.classList.add('open');
            if (opts.onOpen) opts.onOpen(elBody);
            var first = elBody.querySelector('input, select, textarea') || elActions.querySelector('.oao-btn');
            if (first) first.focus();
            return new Promise(function (resolve) { settle = resolve; });
        }
        return {
            open: open,
            /** 确认框：resolve 布尔 */
            confirm: function (opts) {
                return open({
                    title: opts.title || '请确认', body: opts.body || '', danger: opts.danger,
                    actions: [
                        { label: opts.cancelLabel || '取消', value: false },
                        { label: opts.okLabel || '确定', value: true, tone: opts.danger ? 'err' : '' }
                    ]
                }).then(function (v) { return v === true; });
            },
            close: function () { close(null); }
        };
    })();

    var Toast = (function () {
        var box = null;
        function ensure() {
            if (!box) { box = document.createElement('div'); box.className = 'oao-toasts'; document.body.appendChild(box); }
            return box;
        }
        return {
            show: function (msg, tone, ms) {
                var el = document.createElement('div');
                el.className = 'oao-toast ' + (tone || '');
                el.textContent = msg;
                ensure().appendChild(el);
                setTimeout(function () { el.remove(); }, ms || 3200);
            }
        };
    })();

    /* ---------- 表单 ---------- */
    function fieldHtml(f, row) {
        var id = 'oao-f-' + f.name;
        var head = '<label for="' + esc(id) + '">' + esc(f.label)
            + (f.required ? ' <b class="oao-req">*</b>' : '') + '</label>';
        var val = row && row[f.name] != null ? row[f.name] : '';
        var ctl;
        switch (f.widget) {
            case 'textarea':
                ctl = '<textarea class="oao-input" id="' + esc(id) + '" data-field="' + esc(f.name)
                    + '" rows="' + (f.rows || 3) + '">' + esc(val) + '</textarea>';
                break;
            case 'select':
                // 与筛选栏同一个 Select 组件
                ctl = '<button type="button" class="oao-select-trigger" id="' + esc(id)
                    + '" data-field="' + esc(f.name) + '" data-form-select="1">'
                    + '<span class="v"></span>' + CARET + '</button>'
                    + '<input type="hidden" data-field="' + esc(f.name) + '" value="' + esc(val) + '">';
                break;
            case 'switch':
                ctl = '<label class="oao-switch"><input type="checkbox" id="' + esc(id)
                    + '" data-field="' + esc(f.name) + '"'
                    + (val === true || val === 1 || val === '1' || val === 'true' ? ' checked' : '')
                    + '><span class="oao-switch-track"><i></i></span></label>';
                break;
            case 'number':
                ctl = '<input class="oao-input" type="number" id="' + esc(id) + '" data-field="' + esc(f.name)
                    + '" value="' + esc(val) + '">';
                break;
            case 'date':
                ctl = '<input class="oao-input" type="date" id="' + esc(id) + '" data-field="' + esc(f.name)
                    + '" value="' + esc(String(val).slice(0, 10)) + '">';
                break;
            default:
                ctl = '<input class="oao-input" id="' + esc(id) + '" data-field="' + esc(f.name)
                    + '" value="' + esc(val) + '">';
        }
        return '<div class="oao-field">' + head + ctl
            + (f.help ? '<span class="oao-help">' + esc(f.help) + '</span>' : '') + '</div>';
    }

    /** bindFormSelects 把表单里的下拉接上 Select 组件；值写进同名的 hidden input */
    function bindFormSelects(root, fields) {
        root.querySelectorAll('button[data-form-select]').forEach(function (btn) {
            var name = btn.getAttribute('data-field');
            var f = (fields || []).filter(function (x) { return x.name === name; })[0];
            if (!f) return;
            var hidden = root.querySelector('input[type="hidden"][data-field="' + name + '"]');
            Select.attach(btn, {
                options: Object.keys(f.options || {}).map(function (v) {
                    return { value: v, label: f.options[v] };
                }),
                value: hidden ? hidden.value : '',
                placeholder: f.placeholder || '请选择',
                onChange: function (v) { if (hidden) hidden.value = v; },
            });
        });
    }

    /**
     * formControl 取字段的「值载体」。
     * 下拉的触发器是个 <button data-field=...>，它 value 恒为空 —— 真正的值在同名隐藏 input 里。
     * 直接 querySelector('[data-field=x]') 会先命中按钮，把值读成空，所以统一走这里。
     */
    function formControl(root, name) {
        return root.querySelector('input[data-field="' + name + '"],'
            + 'textarea[data-field="' + name + '"],'
            + 'select[data-field="' + name + '"]');
    }

    /** 从表单 DOM 读回值（按 kind 转换类型；开关没勾也要提交 false） */
    function readForm(root, fields) {
        var values = {};
        fields.forEach(function (f) {
            var el = formControl(root, f.name);
            if (!el) return;
            if (f.widget === 'switch') { values[f.name] = el.checked; return; }
            var v = el.value;
            if (f.kind === 'number' && v !== '') values[f.name] = Number(v);
            else values[f.name] = v;
        });
        return values;
    }

    function validateForm(root, fields) {
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            if (!f.required) continue;
            var el = formControl(root, f.name);
            if (!el) continue;
            var empty = f.widget === 'switch' ? false : String(el.value).trim() === '';
            if (empty) return f.label + '不能为空';
        }
        return '';
    }

    /* ---------- 操作列 ---------- */
    // 超过这个数量的动作会收进「更多」，否则行内会被按钮淹掉
    var MAX_FLAT_ACTIONS = 3;

    function actionButton(a, rowIdx) {
        return '<button class="oao-btn oao-btn-sm ' + esc(a.tone || '') + '" data-action="' + esc(a.key)
            + '" data-row="' + rowIdx + '">' + esc(a.label) + '</button>';
    }

    function actionColumn(meta, rowIdx) {
        var acts = meta.actions || [];
        var head = '';
        if (acts.length > MAX_FLAT_ACTIONS) {
            // 前两个平铺，其余进「更多」——常用的还在手边，少用的不占地方
            head = '<button class="oao-btn oao-btn-sm" data-more="' + rowIdx + '">更多 ▾</button>';
            acts = acts.slice(0, 2);
        }
        return '<div class="oao-actions">'
            + acts.map(function (a) { return actionButton(a, rowIdx); }).join('')
            + head + '</div>';
    }

    /** 「更多」面板：列出被收起的动作，点一项走同一个 runAction */
    function openActionMenu(trigger, st, rowIdx) {
        var more = (st.meta.actions || []).slice(2);
        Popup.open({
            trigger: trigger,
            itemSel: '.oao-select-item',
            enterPicks: true,
            closeOnPick: true,
            render: function (panel, hl) {
                panel.innerHTML = more.map(function (a, i) {
                    return '<div class="oao-select-item' + (i === hl ? ' hl' : '') + '" role="menuitem" data-i="' + i + '">'
                        + '<span class="dot ' + esc(a.tone || '') + '"></span>'
                        + '<span>' + esc(a.label) + '</span></div>';
                }).join('');
            },
            onPick: function (i) {
                var a = more[i];
                if (!a) return;
                // 面板先收掉再跑：动作可能弹确认/表单框，别和它叠在一起
                Popup.close(false);
                runAction(st.meta, a, st.rows[rowIdx]);
            },
        });
    }

    /** 打开表单弹窗：resolve 表单值对象；取消 / Esc 返回 null */
    function openForm(title, fields, row) {
        var bodyEl = null;
        return Dialog.open({
            title: title,
            body: '<div class="oao-form">' + fields.map(function (f) { return fieldHtml(f, row); }).join('') + '</div>'
                + '<div class="oao-form-err"></div>',
            actions: [
                { label: '取消', value: null },
                {
                    label: '提交', value: true,
                    onClick: function () {
                        var err = validateForm(bodyEl, fields);
                        if (err) {
                            bodyEl.querySelector('.oao-form-err').textContent = err;
                            return false; // 校验没过，别关
                        }
                        return true;
                    }
                }
            ],
            onOpen: function (body) { bodyEl = body; bindFormSelects(body, fields); }
        }).then(function (ok) {
            // 弹窗关闭时不清空 body，所以这里还能读到值
            return ok === true ? readForm(bodyEl, fields) : null;
        });
    }

    /** 执行一个操作：可选确认框 → 可选表单 → 提交 → 反馈并刷新 */
    async function runAction(meta, action, row) {
        // 主键字段名由表声明（默认 id）；它必须是声明过的列，否则这一行里根本没有这个值
        var idField = (meta && meta.id_field) || 'id';
        var id = row && row[idField] != null ? String(row[idField]) : '';
        if (id === '') {
            Toast.show(action.label + '失败：这一行没有 ' + idField + ' 字段，无法定位目标行', 'err', 5000);
            return;
        }
        var payload = { id: id, row: row || {}, values: {} };

        if (action.confirm) {
            var ok = await Dialog.confirm({
                title: action.label, body: '<p>' + esc(action.confirm) + '</p>',
                danger: action.tone === 'err', okLabel: action.label
            });
            if (!ok) return;
        }
        if (action.form && action.form.length) {
            var values = await openForm(action.label, action.form, row);
            if (values === null) return;
            payload.values = values;
        }

        try {
            await postAction(meta.key, action.key, payload);
            Toast.show(action.label + '成功', 'ok');
            await load(meta.key);
        } catch (e) {
            Toast.show(action.label + '失败：' + e.message, 'err', 5000);
        }
    }

    /* ---------- 单元格渲染 ---------- */
    function cell(col, row) {
        var v = row[col.name];
        if (col.render === 'enum') {
            if (v === null || v === undefined || v === '') return '<span class="muted">-</span>';
            // bool 列先归一：MySQL 扫 tinyint 出来是 1/0，而 Enum 一般按 "true"/"false" 声明
            var key = col.kind === 'bool'
                ? ((v === true || v === 1 || v === '1' || v === 'true') ? 'true' : 'false')
                : String(v);
            var text = (col.enum && col.enum[key]) || String(v);
            var tone = (col.tone && col.tone[key]) || '';
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
                if (!href) return esc(v);
                // 新标签页打开时补 rel，避免 target=_blank 把 opener 交给外部站点
                var attrs = col.new_tab ? ' target="_blank" rel="noopener noreferrer"' : '';
                return '<a class="oao-link" href="' + esc(href) + '"' + attrs + '>' + esc(v) + '</a>';
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

    /* ---------- Select（按组件库规格：trigger / content / item） ----------
       单选、多选（多选是带 checkbox 的面板）都用它，不再用原生 <select>。 */

    var CARET = '<svg class="caret" viewBox="0 0 12 12" aria-hidden="true">'
        + '<path d="M2 4.5 L6 8.5 L10 4.5" fill="none" stroke="currentColor" stroke-width="2"/>'
        + '</svg>';

    /* ---------- 弹出面板（Select 与「更多」操作共用） ----------
       只负责面板本体：贴触发器定位、点外部/Esc 关闭、↑↓ 高亮、resize/scroll 重定位、
       以及条目的通用鼠标交互（mousedown 选中、hover 高亮）。
       具体渲染与语义由调用方给：{ trigger, itemSel, render(panel, hl), onPick(i), closeOnPick, enterPicks } */
    var Popup = (function () {
        var panel = null, cur = null, hl = -1;

        function ensure() {
            if (panel) return;
            panel = document.createElement('div');
            panel.className = 'oao-select-content';
            panel.setAttribute('role', 'listbox');
            panel.hidden = true;
            document.body.appendChild(panel);
            document.addEventListener('mousedown', function (e) {
                if (cur && !panel.contains(e.target) && !cur.trigger.contains(e.target)) close(false);
            });
            document.addEventListener('keydown', function (e) {
                if (!cur) return;
                if (e.key === 'Escape') { e.preventDefault(); close(true); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
                else if (e.key === 'Enter' && cur.enterPicks) { e.preventDefault(); pick(hl); }
            });
            window.addEventListener('resize', function () { if (cur) place(); });
            window.addEventListener('scroll', function () { if (cur) place(); }, true);
        }

        /** place 贴在触发器下方；下面放不下就往上翻 */
        function place() {
            if (!cur.trigger.isConnected) return; // 触发器已被重绘换掉，别再摆
            var r = cur.trigger.getBoundingClientRect();
            panel.style.minWidth = r.width + 'px';
            panel.style.left = Math.round(r.left) + 'px';
            panel.style.top = Math.round(r.bottom + 4) + 'px';
            var h = panel.offsetHeight;
            if (r.bottom + 4 + h > window.innerHeight && r.top - 4 - h > 0) {
                panel.style.top = Math.round(r.top - 4 - h) + 'px';
            }
        }

        function items() { return cur ? panel.querySelectorAll(cur.itemSel) : []; }

        /** render 重画面板内容，并给条目接上通用交互 */
        function render() {
            if (!cur) return;
            cur.render(panel, hl);
            items().forEach(function (el) {
                el.addEventListener('mousedown', function (e) {
                    e.preventDefault();  // 别让触发器失焦
                    // mousedown 后可能重建面板节点，若不拦住冒泡，
                    // document 上的"点外部关闭"会因 target 已脱离 DOM 而误判
                    e.stopPropagation();
                    pick(parseInt(el.getAttribute('data-i'), 10));
                });
                el.addEventListener('mouseenter', function () {
                    hl = parseInt(el.getAttribute('data-i'), 10);
                    items().forEach(function (x) { x.classList.remove('hl'); });
                    el.classList.add('hl');
                });
            });
        }

        function pick(i) {
            if (!cur) return;
            var state = cur;
            state.onPick(i);
            if (state.closeOnPick) close(true);
            else if (cur === state) render(); // 多选：原地重画，面板不关
        }

        function move(step) {
            var list = items();
            if (!list.length) return;
            hl = (hl + step + list.length) % list.length;
            list.forEach(function (el, i) { el.classList.toggle('hl', i === hl); });
            var hit = panel.querySelector('.hl');
            if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'nearest' });
        }

        function open(state) {
            ensure();
            if (cur) close(false);
            cur = state;
            hl = -1;
            panel.hidden = false;
            state.trigger.setAttribute('aria-expanded', 'true');
            render();
            place();
            if (state.trigger.focus) state.trigger.focus();
        }

        function close(refocus) {
            if (!cur) return;
            var trigger = cur.trigger;
            panel.hidden = true;
            cur = null;
            hl = -1;
            if (trigger) {
                trigger.setAttribute('aria-expanded', 'false');
                if (refocus && trigger.focus) trigger.focus();
            }
        }

        return {
            open: open,
            close: close,
            /** 面板开着时原地重画（多选改值后用） */
            refresh: function () { if (cur) { render(); place(); } },
            /** 判断某个触发器对应的面板是不是开着 */
            isOpen: function (trigger) { return !!cur && cur.trigger === trigger; },
        };
    })();

    var Select = (function () {
        function labelOf(o) {
            if (o.multiple) {
                var picked = o.options.filter(function (x) { return o.value.indexOf(String(x.value)) > -1; });
                if (picked.length === 0) return '';
                if (picked.length <= 2) return picked.map(function (x) { return x.label; }).join('、');
                return '已选 ' + picked.length + ' 项';
            }
            var hit = o.options.filter(function (x) { return String(x.value) === String(o.value); })[0];
            return hit ? hit.label : '';
        }

        function renderTrigger(state) {
            var v = state.trigger.querySelector('.v');
            state.trigger.setAttribute('aria-expanded', String(Popup.isOpen(state.trigger)));
            if (!v) return;
            var text = labelOf(state);
            v.textContent = text || state.placeholder || '全部';
            v.classList.toggle('placeholder', !text);
        }

        function isOn(state, opt) {
            return state.multiple
                ? state.value.indexOf(String(opt.value)) > -1
                : String(opt.value) === String(state.value);
        }

        function renderItems(state, panel, hl) {
            if (!state.options.length) {
                panel.innerHTML = '<div class="oao-select-empty">没有选项</div>';
                return;
            }
            panel.innerHTML = state.options.map(function (opt, i) {
                var on = isOn(state, opt);
                return '<div class="oao-select-item' + (on ? ' on' : '') + (i === hl ? ' hl' : '')
                    + '" role="option" data-i="' + i + '" aria-selected="' + on + '">'
                    + (state.multiple ? '<input type="checkbox" tabindex="-1"' + (on ? ' checked' : '') + '>' : '')
                    + '<span>' + esc(opt.label) + '</span></div>';
            }).join('');
        }

        return {
            /** attach 把触发器接成下拉；value 单选为字符串、多选为字符串数组 */
            attach: function (trigger, opts) {
                var state = {
                    trigger: trigger,
                    options: opts.options || [],
                    value: opts.multiple ? (opts.value || []).slice() : (opts.value || ''),
                    multiple: !!opts.multiple,
                    placeholder: opts.placeholder,
                    onChange: opts.onChange || function () {},
                    itemSel: '.oao-select-item',
                    enterPicks: !opts.multiple,   // 多选时 Enter 不用来选中
                    closeOnPick: !opts.multiple,
                    render: function (panel, hl) {
                        renderTrigger(state);
                        renderItems(state, panel, hl);
                    },
                    onPick: function (i) {
                        var opt = state.options[i];
                        if (!opt) return;
                        if (state.multiple) {
                            var v = state.value.slice();
                            var at = v.indexOf(String(opt.value));
                            if (at > -1) v.splice(at, 1); else v.push(String(opt.value));
                            state.value = v;
                            state.onChange(v);
                        } else {
                            state.value = String(opt.value);
                            state.onChange(state.value);
                        }
                    },
                };
                trigger.__oaoSelect = state; // 重绘后重新 attach 时复用它
                if (!trigger.__oaoBound) {
                    trigger.__oaoBound = true;
                    trigger.setAttribute('aria-haspopup', 'listbox');
                    trigger.setAttribute('aria-expanded', 'false');
                    trigger.addEventListener('click', function (e) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (Popup.isOpen(trigger)) Popup.close(true);
                        else Popup.open(state);
                    });
                    trigger.addEventListener('keydown', function (e) {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation(); // 否则 document 上的 Enter 分支会再选一次（此时 hl 还是 -1）
                            Popup.open(state);
                        }
                    });
                }
                renderTrigger(state);
            },
            close: function () { Popup.close(false); },
        };
    })();

    /* ---------- 筛选栏 ---------- */
    function filterBar(meta) {
        if (!meta.filters || meta.filters.length === 0) return '';
        var st = state[meta.key];
        return '<div class="oao-filters">' + meta.filters.map(function (f) {
            var val = st.query.filter[f.name] || '';
            var label = '<label>' + esc(f.label) + '</label>';
            var opts = f.options ? Object.keys(f.options) : [];

            // 有选项的下拉（含多选）统一走 Select 组件
            if (f.widget === 'select' && opts.length) {
                var multiple = f.op === 'in';
                var cur = multiple ? (val ? val.split(',') : []) : val;
                return '<div class="oao-field"><label>' + esc(f.label) + '</label>'
                    + '<button type="button" class="oao-select-trigger" data-filter="' + esc(f.name) + '"'
                    + (multiple ? ' data-multiple="1"' : '') + '>' + '<span class="v"></span>' + CARET + '</button>'
                    + '</div>';
            }
            if (f.widget === 'daterange') {
                var lo = '', hi = '';
                if (val.indexOf('..') > -1) { var p = val.split('..'); lo = p[0]; hi = p[1]; }
                return '<div class="oao-field range">' + label + '<div class="range">'
                    + '<input class="oao-input" type="date" data-filter="' + esc(f.name) + '" data-part="lo" value="' + esc(lo) + '">'
                    + '<i>~</i>'
                    + '<input class="oao-input" type="date" data-filter="' + esc(f.name) + '" data-part="hi" value="' + esc(hi) + '">'
                    + '</div></div>';
            }
            if (f.widget === 'date') {
                return '<div class="oao-field">' + label + '<input class="oao-input" type="date" data-filter="'
                    + esc(f.name) + '" value="' + esc(val) + '"></div>';
            }
            return '<div class="oao-field">' + label
                + '<input class="oao-input" data-filter="' + esc(f.name) + '" placeholder="筛选" value="'
                + esc(val) + '"></div>';
        }).join('') + '</div>';
    }

    /** bindSelects 把筛选栏里的下拉接上 Select 组件 */
    function bindSelects(st, root, key) {
        root.querySelectorAll('.oao-select-trigger[data-filter]').forEach(function (btn) {
            var name = btn.getAttribute('data-filter');
            var f = (st.meta.filters || []).filter(function (x) { return x.name === name; })[0];
            if (!f) return;
            var multiple = btn.getAttribute('data-multiple') === '1';
            var options = Object.keys(f.options || {}).map(function (v) {
                return { value: v, label: f.options[v] };
            });
            var raw = st.query.filter[name] || '';
            Select.attach(btn, {
                options: options,
                multiple: multiple,
                value: multiple ? (raw ? raw.split(',') : []) : raw,
                onChange: function (v) {
                    st.query.filter[name] = multiple ? (v || []).join(',') : v;
                    st.query.page = 1;
                    load(key);
                },
            });
        });
    }

    /* ---------- 排序 ---------- */
    function sortParts(sort) {
        return (sort || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    /** sortIndexOf 该列当前排在第几位（0 起）与方向；没排过返回 -1 */
    function sortIndexOf(sort, col) {
        var parts = sortParts(sort);
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === col || parts[i] === '-' + col) {
                return { index: i, desc: parts[i].charAt(0) === '-', total: parts.length };
            }
        }
        return { index: -1, total: parts.length };
    }
    /**
     * toggleSort 点表头：
     *   普通点击   → 只按这一列排（升 → 降 → 升）
     *   Shift+点击 → 追加/切换，保留其它列，按点击先后定优先级
     */
    function toggleSort(sort, col, append) {
        var parts = sortParts(sort);
        var cur = sortIndexOf(sort, col);
        var next = cur.index >= 0 ? (cur.desc ? col : '-' + col) : col;
        if (!append) return next;
        if (cur.index >= 0) parts[cur.index] = next;
        else parts.push(next);
        return parts.join(',');
    }

    /* ---------- 表格 / 分页 ---------- */
    function table(meta, rows, sort) {
        if (!rows.length) return '<div class="oao-loading">没有数据</div>';
        var cols = meta.columns.filter(function (c) { return !c.hidden; });
        var hasActions = meta.actions && meta.actions.length > 0;
        var head = cols.map(function (c) {
            var width = c.width ? ' style="width:' + esc(c.width) + '"' : '';
            if (!c.sortable) {
                return '<th' + width + ' scope="col">' + esc(c.label) + '</th>';
            }
            var s = sortIndexOf(sort, c.name);
            var arrow = '';
            var aria = 'none';
            if (s.index >= 0) {
                // 多字段排序时标上优先级序号
                arrow = (s.desc ? ' ▼' : ' ▲') + (s.total > 1 ? String(s.index + 1) : '');
                aria = s.desc ? 'descending' : 'ascending';
            }
            return '<th class="sortable" scope="col" aria-sort="' + aria + '"' + width
                + ' data-sort="' + esc(c.name) + '" title="点击排序，Shift+点击多字段排序">'
                + esc(c.label) + arrow + '</th>';
        }).join('') + (hasActions ? '<th scope="col">操作</th>' : '');
        var body = rows.map(function (r, i) {
            return '<tr>' + cols.map(function (c) { return '<td>' + cell(c, r) + '</td>'; }).join('')
                + (hasActions ? '<td>' + actionColumn(meta, i) + '</td>' : '') + '</tr>';
        }).join('');
        // tabindex/role/aria-label：溢出时键盘也能滚到内容（组件库 Table 规格的建议）
        return '<div class="table-wrap" tabindex="0" role="region" aria-label="'
            + esc(meta.label || meta.key) + ' 数据表"><table><thead><tr>' + head + '</tr></thead>'
            + '<tbody>' + body + '</tbody></table></div>';
    }

    function pager(meta, data) {
        var last = Math.max(1, Math.ceil(data.total / data.size));
        return '<div class="oao-pager">'
            + '<span>共 ' + data.total + ' 条</span>'
            + '<button type="button" class="oao-select-trigger oao-pagesize" data-pagesize><span class="v"></span>' + CARET + '</button>'
            + '<button class="pg" data-go="' + (data.page - 1) + '"' + (data.page <= 1 ? ' disabled' : '') + '>上一页</button>'
            + '<span>第 ' + data.page + ' / ' + last + ' 页</span>'
            + '<button class="pg" data-go="' + (data.page + 1) + '"' + (data.page >= last ? ' disabled' : '') + '>下一页</button>'
            + '</div>';
    }

    /* ---------- 状态与取数 ---------- */
    function stateOf(key) {
        if (!state[key]) {
            state[key] = { key: key, seq: 0, meta: null, rows: [], query: { page: 1, size: 0, search: '', sort: '', filter: {} }, el: null };
        }
        return state[key];
    }

    function queryString(q) {
        var out = 'page=' + q.page + (q.size ? '&size=' + q.size : '');
        if (q.search) out += '&search=' + encodeURIComponent(q.search);
        if (q.sort) out += '&sort=' + encodeURIComponent(q.sort);
        for (var k in q.filter) {
            var v = q.filter[k];
            if (v === '' || v == null) continue;
            // 区间只填了一半不发出去，等另一半填完再查
            if (typeof v === 'string' && v.indexOf('..') > -1 && incompleteRange(v)) continue;
            out += '&filter[' + encodeURIComponent(k) + ']=' + encodeURIComponent(v);
        }
        return out;
    }

    function incompleteRange(v) {
        var p = v.split('..');
        return !p[0] || !p[1];
    }

    /** 从 DOM 读回筛选值（多选拼逗号串，区间拼 a..b） */
    function readFilter(st, root) {
        // 以现有条件为基底：Select 的值只存在 st.query.filter 里、DOM 中没有对应控件，
        // 从空对象重建会把下拉选择静默抹掉
        var filter = Object.assign({}, st.query.filter);
        root.querySelectorAll('[data-filter]:not(.oao-select-trigger)').forEach(function (el) {
            var name = el.getAttribute('data-filter');
            if (el.getAttribute('data-part')) {
                // 区间两半都塞进同一个值；只填一半也先留着，
                // 否则重绘会把用户刚选的日期抹掉
                var parts = (filter[name] || '..').split('..');
                if (el.getAttribute('data-part') === 'lo') parts[0] = el.value; else parts[1] = el.value;
                filter[name] = parts.join('..');
                return;
            }
            filter[name] = el.value.trim();
        });
        st.query.filter = filter;
    }

    /**
     * elOwner 记录"某块容器当前归哪张表"。
     * 切表时后发先至的慢响应，如果还往旧容器里画，就会把新表盖掉 —— 用它挡。
     */
    var elOwner = new WeakMap();

    async function load(key) {
        var st = stateOf(key);
        if (!st.el) return;
        st.key = key;

        // 双重守卫：seq 挡住同一张表的连续查询，elOwner 挡住"容器已被别的表接管"
        var seq = ++st.seq;
        var el = st.el;
        elOwner.set(el, key);
        var stale = function () { return st.seq !== seq || elOwner.get(el) !== key; };

        try {
            if (!st.meta) {
                var metasResp = await api('/tables');
                if (stale()) return;
                st.meta = metasResp.tables.filter(function (t) { return t.key === key; })[0];
                // 用默认排序初始化，让表头一开始就显示出排序方向
                if (st.meta && st.meta.default_sort) st.query.sort = st.meta.default_sort;
            }
            if (!st.meta) throw new Error('未知表格：' + key);

            Select.close(); // 面板挂在 body 上，重绘清不掉它
            st.el.innerHTML = '<div class="oao-loading">加载中...</div>';
            var data = await api('/' + encodeURIComponent(key) + '?' + queryString(st.query));
            if (stale()) return;

            st.meta.columns = data.columns;
            st.meta.filters = data.filters;
            if (data.actions) st.meta.actions = data.actions;
            st.rows = data.rows || [];
            st.lastSize = data.size;

            st.el.innerHTML = '<div class="oao-view">'
                + filterBar(st.meta) + table(st.meta, st.rows, st.query.sort) + pager(st.meta, data)
                + '</div>';
            bind(st, st.el.querySelector('.oao-view'), key);
        } catch (e) {
            if (stale()) return;
            // 不能让失败把表格永久留在"加载中"——给个能重试的提示
            renderLoadError(st, e);
        }
    }

    /** renderLoadError 加载失败的兜底：说清原因，并且点一下就能重来 */
    function renderLoadError(st, err) {
        if (!st.el) return;
        var msg = (err && err.message) || String(err);
        st.el.innerHTML = '<div class="oao-view"><div class="oao-error">'
            + '加载失败：' + esc(msg)
            + '<button class="oao-btn oao-btn-sm" data-retry>重试</button>'
            + '</div></div>';
        var btn = st.el.querySelector('[data-retry]');
        if (btn) btn.onclick = function () { load(st.key); };
    }

    function bind(st, root, key) {
        root.querySelectorAll('th[data-sort]').forEach(function (th) {
            th.onclick = function (e) {
                st.query.sort = toggleSort(st.query.sort, th.getAttribute('data-sort'), e.shiftKey);
                st.query.page = 1;
                load(key);
            };
        });
        root.querySelectorAll('[data-action]').forEach(function (b) {
            b.onclick = function () {
                var key2 = b.getAttribute('data-action');
                var action = (st.meta.actions || []).filter(function (a) { return a.key === key2; })[0];
                if (!action) return;
                runAction(st.meta, action, st.rows[parseInt(b.getAttribute('data-row'), 10)]);
            };
        });
        root.querySelectorAll('[data-more]').forEach(function (b) {
            b.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                openActionMenu(b, st, parseInt(b.getAttribute('data-more'), 10));
            };
        });
        root.querySelectorAll('[data-go]').forEach(function (b) {
            b.onclick = function () { st.query.page = parseInt(b.getAttribute('data-go'), 10); load(key); };
        });
        var ps = root.querySelector('[data-pagesize]');
        if (ps) {
            Select.attach(ps, {
                options: (st.meta.page_sizes || [20, 50, 100]).map(function (n) {
                    return { value: String(n), label: n + ' 条/页' };
                }),
                value: String(st.lastSize || st.meta.page_size),
                onChange: function (v) { st.query.size = parseInt(v, 10); st.query.page = 1; load(key); },
            });
        }
        bindSelects(st, root, key);
        root.querySelectorAll('[data-filter]:not(.oao-select-trigger)').forEach(function (el) {
            var ev = el.type === 'date' ? 'change' : 'keydown';
            el.addEventListener(ev, function (e) {
                if (ev === 'keydown' && e.key !== 'Enter') return;
                readFilter(st, root);
                var name = el.getAttribute('data-filter');
                var v = st.query.filter[name];
                if (typeof v === 'string' && v.indexOf('..') > -1) {
                    var parts = v.split('..');
                    if (!parts[0] && !parts[1]) {
                        // 两半都清空了：撤掉这个条件，恢复全部
                        delete st.query.filter[name];
                    } else if (!parts[0] || !parts[1]) {
                        // 只填了一半：等另一半，先别查，避免半截条件来回刷新
                        return;
                    }
                }
                if (ev === 'keydown') st.query.search = '';
                st.query.page = 1;
                load(key);
            });
        });
    }

    /* ---------- 表格清单（带缓存） ---------- */
    var metas = null;
    async function loadTables(force) {
        if (!metas || force) metas = (await api('/tables')).tables || [];
        return metas;
    }

    /* ---------- 布局（可选） ---------- */
    /**
     * mount 在容器里搭一套完整的后台外壳：侧边栏菜单 + 内容区。
     * 不需要外壳的宿主（自己已有页面框架）继续只用 render() 即可。
     *
     *   Oao.mount(document.getElementById('app'), {
     *     title: 'PAPA MONITOR',
     *     headerRight: '<span class="me">ydtg</span>',   // 右上角插槽
     *     sidebarFooter: '<button>深色</button>',        // 侧边栏底部插槽
     *     pages: [                                        // 宿主自己的页面
     *       { key: 'dashboard', label: 'Dashboard', group: '概览',
     *         render: function (el, api) { el.innerHTML = '...'; } },
     *     ],
     *   });
     *
     * 页面 render 收到 (容器元素, api)。api 提供 reload()/open(key)/setTitle()。
     * headerRight / sidebarFooter 可以是 HTML 字符串，也可以是 (el, api) => void。
     */
    async function mount(el, opts) {
        opts = opts || {};
        var tables = [];
        try { tables = await loadTables(true); } catch (e) { tables = []; }

        var hostPages = (opts.pages || []).slice();
        var menu = buildMenu(hostPages, tables);

        // 容器由 mount 接管布局：flex:1 撑满、min-width:0 允许被压窄。
        // 少了它，宽表格会把容器顶开、整页出横向滚动条，右上角插槽也被挤出可视区。
        el.classList.add('oao-host');

        el.innerHTML = ''
            + '<div class="oao-shell">'
            + '  <aside class="oao-side">'
            + '    <div class="oao-brand">' + esc(opts.title || 'OAO') + '</div>'
            + '    <nav class="oao-nav">' + menu.html + '</nav>'
            + '    <div class="oao-side-foot"></div>'
            + '  </aside>'
            + '  <main class="oao-main">'
            + '    <header class="oao-top"><h1></h1><div class="oao-top-right"></div></header>'
            + '    <div class="oao-content"></div>'
            + '  </main>'
            + '</div>';

        var sideFoot = el.querySelector('.oao-side-foot');
        var topRight = el.querySelector('.oao-top-right');
        var titleEl = el.querySelector('.oao-top h1');
        var content = el.querySelector('.oao-content');

        var current = null;
        // api 给本实例用：每个 mount 各有一份，多实例不会串
        var apiObj = {
            /** 重新加载当前页 */
            reload: function () { if (current) select(current); },
            /** 切到某个页面或表格（按 key） */
            select: function (key) { select(key); },
            /** 改标题（页面渲染里调） */
            setTitle: function (t) { titleEl.textContent = t; },
            /** 当前页面 key */
            current: function () { return current; },
            /** 页面容器，宿主页面想自己往里面塞东西时用 */
            content: function () { return content; },
        };

        if (opts.sidebarFooter) fillSlot(sideFoot, opts.sidebarFooter, apiObj);
        if (opts.headerRight) fillSlot(topRight, opts.headerRight, apiObj);
        async function select(key) {
            var item = menu.byKey[key];
            if (!item) return;
            // 内容区只有一个：把其它表的在途请求作废，避免慢响应回来盖住新表
            Object.keys(state).forEach(function (k) {
                if (k !== key) state[k].seq++;
            });
            current = key;
            el.querySelectorAll('.oao-nav-item').forEach(function (b) {
                b.classList.toggle('active', b.getAttribute('data-oao-key') === key);
            });
            titleEl.textContent = item.label;
            Select.close(); // 切页时把浮在外面的下拉面板收掉
            content.innerHTML = '';
            if (item.table) {
                var st = stateOf(item.table);
                st.el = content;
                st.query.page = 1;
                await load(item.table);
            } else {
                // 宿主页面单独包一层：它自己滚，不挤占表格页的布局
                var page = document.createElement('div');
                page.className = 'oao-page';
                content.appendChild(page);
                try {
                    item.render(page, apiObj);
                } catch (e) {
                    page.innerHTML = '<div class="oao-error">页面渲染失败：' + esc(e.message) + '</div>';
                }
            }
        }
        apiObj.open = function (key) { select(key); };

        el.querySelectorAll('.oao-nav-item').forEach(function (b) {
            b.onclick = function () { select(b.getAttribute('data-oao-key')); };
        });

        if (menu.order.length) select(menu.order[0]);
        if (opts.onReady) opts.onReady(apiObj);
        return apiObj;
    }

    /** buildMenu 把宿主页面与 oao 表格按 group 合成菜单，group 顺序取首次出现的顺序 */
    function buildMenu(hostPages, tables) {
        var items = [];
        hostPages.forEach(function (p) {
            items.push({ key: p.key, label: p.label || p.key, group: p.group || 'General', render: p.render });
        });
        tables.forEach(function (t) {
            items.push({ key: t.key, label: t.label, group: t.group || 'General', table: t.key });
        });

        var groups = [];
        items.forEach(function (it) {
            if (groups.indexOf(it.group) === -1) groups.push(it.group);
        });

        var byKey = {}, order = [];
        var html = groups.map(function (g) {
            return '<div class="nav-section">' + esc(g) + '</div>'
                + items.filter(function (it) { return it.group === g; }).map(function (it) {
                    byKey[it.key] = it;
                    order.push(it.key);
                    return '<button class="oao-nav-item" data-oao-key="' + esc(it.key) + '">'
                        + esc(it.label) + '</button>';
                }).join('');
        }).join('');
        return { html: html, byKey: byKey, order: order };
    }

    /** fillSlot 插槽内容：字符串直接当 HTML，函数则以 (元素, api) 为参数回调 */
    function fillSlot(el, slot, api) {
        if (typeof slot === 'function') slot(el, api);
        else el.innerHTML = slot;
    }

    /* ---------- 对外 API ---------- */
    return {
        /** 初始化：base 为 API 前缀；headers 回调用于带鉴权信息 */
        init: function (opts) {
            opts = opts || {};
            if (opts.base) base = opts.base;
            if (opts.headers) authHeaders = opts.headers;
            if (opts.onUnauthorized) onUnauthorized = opts.onUnauthorized;
        },
        /** 搭一套完整外壳（可选 —— 自己已有页面框架的宿主不需要） */
        mount: mount,
        /** 表格清单（渲染菜单用）；force=true 时强制重取 */
        list: loadTables,
        /** 把某张表渲染进容器（不带外壳） */
        render: async function (container, key) {
            var st = stateOf(key);
            st.el = container;
            st.query.page = 1;
            await load(key);
        },
        /** 重新加载某张表（外部操作后刷新用） */
        refresh: function (key) { return load(key); }
    };
})();
