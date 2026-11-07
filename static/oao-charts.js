/**
 * Oao SVG charts. Load after oao.js (or use independently).
 * Oao.charts.create(element, options) -> { update(options), resize(), destroy() }
 * update is a complete replacement; this module never fetches or stores business data.
 * See README for limits, numeric/time axes and keyboard interaction.
 */
(function (global) {
    'use strict';
    var NS = 'http://www.w3.org/2000/svg';
    var instances = new WeakMap();
    var nextID = 0;
    var fallbackColors = ['#946600', '#2875ba', '#c44e44', '#44834c', '#8862b2', '#ab572c', '#377f83', '#935c7b'];

    function text(value) { return value == null ? '' : String(value); }
    function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
    function requireThat(test, message) { if (!test) throw new Error(message); }
    function key(value, seen, kind) {
        requireThat(typeof value === 'string' && value.trim().length > 0, kind + '必须提供非空字符串 key');
        requireThat(!seen.has(value), kind + ' key 重复：' + value);
        seen.add(value); return value;
    }
    function color(value, index) {
        if (value == null || value === '') return 'var(--oao-chart-color-' + index + ', ' + fallbackColors[index % fallbackColors.length] + ')';
        requireThat(typeof value === 'string' && /^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/]+\)|var\(--[a-z0-9_-]+\))$/i.test(value), '颜色必须是 CSS 颜色或单个 CSS token');
        if (global.CSS && typeof global.CSS.supports === 'function') {
            requireThat(global.CSS.supports('color', value), '颜色必须是 CSS 颜色或单个 CSS token');
        }
        return value;
    }
    function normalize(raw) {
        var o = raw || {};
        var result = { type: text(o.type), title: text(o.title), unit: text(o.unit), description: text(o.description), emptyText: text(o.emptyText) || '暂无可用数据', error: text(o.error), horizontal: !!o.horizontal, xType: o.xType || 'number', series: [], data: [] };
        if (result.error) return result;
        try {
            requireThat(['line', 'bar', 'donut', 'sparkline'].indexOf(result.type) !== -1, '图表类型须为 line、bar、donut 或 sparkline');
            requireThat(result.xType === 'number' || result.xType === 'time', 'xType 须为 number 或 time');
            var seen = new Set();
            if (result.type === 'line' || result.type === 'sparkline') {
                var series = o.series === undefined ? [] : o.series;
                requireThat(Array.isArray(series), 'series 必须是数组');
                requireThat(series.length <= 8, '每张图最多 8 个系列');
                result.series = Array.from(series).map(function (s, i) {
                    requireThat(s && typeof s === 'object', '系列必须是对象');
                    var id = key(s.key, seen, '系列');
                    requireThat(Array.isArray(s.points), '系列 ' + id + ' 的 points 必须是数组');
                    requireThat(s.points.length <= 300, '每个系列最多 300 个点：' + id);
                    var prior = -Infinity;
                    var points = Array.from(s.points).map(function (p) {
                        requireThat(p && finite(p.x), '系列 ' + id + ' 的 x 必须是有限数字');
                        requireThat(p.x > prior, '系列 ' + id + ' 的 x 必须严格递增，不允许重复或乱序');
                        requireThat(result.xType !== 'time' || Math.abs(p.x) <= 8640000000000000, '时间 x 必须是有效的毫秒时间戳');
                        requireThat(p.y === null || finite(p.y), '系列 ' + id + ' 的 y 必须是有限数字或 null');
                        prior = p.x; return { x: p.x, y: p.y };
                    });
                    return { key: id, label: text(s.label) || id, color: color(s.color, i), points: points };
                });
            } else {
                var data = o.data === undefined ? [] : o.data;
                var limit = result.type === 'donut' ? 12 : 50;
                requireThat(Array.isArray(data), 'data 必须是数组');
                requireThat(data.length <= limit, '此图最多 ' + limit + ' 个分类');
                result.data = Array.from(data).map(function (d, i) {
                    requireThat(d && typeof d === 'object', '分类必须是对象');
                    var id = key(d.key, seen, '分类');
                    requireThat(finite(d.value), '分类 ' + id + ' 的 value 必须是有限数字');
                    requireThat(result.type !== 'donut' || d.value >= 0, '环形图不允许负数：' + id);
                    return { key: id, label: text(d.label) || id, value: d.value, color: color(null, result.type === 'bar' ? 0 : i) };
                });
                if (result.type === 'donut') {
                    result.total = result.data.reduce(function (sum, item) { return sum + item.value; }, 0);
                    requireThat(Number.isFinite(result.total), '环形图总和超出有限数值范围');
                }
            }
        } catch (err) {
            result.error = err.message; result.series = []; result.data = [];
        }
        return result;
    }
    function number(value) {
        if (value === null) return '无观测';
        if (value === 0) return '0';
        var abs = Math.abs(value);
        if (abs >= 1e9 || abs < 0.001) return value.toExponential(2);
        return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
    }
    function exactNumber(value) { return value === null ? '无观测' : String(value); }
    function xLabel(value, options, compact) {
        if (options.xType !== 'time') return exactNumber(value);
        var date = new Date(value);
        if (compact) return date.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return date.toLocaleString(undefined, { hour12: false }) + (date.getMilliseconds() ? '.' + ('00' + date.getMilliseconds()).slice(-3) : '');
    }
    // Preserve small differences on large origins; normalize only when the span overflows.
    function scale(min, max, start, end) {
        if (min === max) return function () { return (start + end) / 2; };
        var span = max - min;
        if (Number.isFinite(span)) return function (value) { return start + ((value - min) / span) * (end - start); };
        var magnitude = Math.max(Math.abs(min), Math.abs(max)) || 1;
        var lo = min / magnitude, hi = max / magnitude;
        return function (value) { return start + ((value / magnitude - lo) / (hi - lo)) * (end - start); };
    }
    function interpolate(min, max, ratio) { return min * (1 - ratio) + max * ratio; }
    function shortLabel(value, length) { var chars = Array.from(value); return chars.length > length ? chars.slice(0, length - 1).join('') + '…' : value; }
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

    function create(container, options) {
        if (!container || typeof container.appendChild !== 'function') throw new TypeError('Oao.charts.create 需要 DOM 容器');
        var previous = instances.get(container);
        if (previous) previous.destroy();
        var doc = container.ownerDocument || global.document;
        var id = 'oao-chart-' + (++nextID);
        var destroyed = false, resizeFrame = 0, animationFrame = 0, observer = null;
        var current = null, signature = '', dataSignature = '', width = 640;
        var marks = [], markByToken = new Map(), plot = null, tooltip = null, details = null, summary = null, tableOpen = false;
        var tableScroll = null, tableScrollTop = 0, tableScrollLeft = 0;
        var root = element('section', 'oao-chart');
        root.setAttribute('role', 'group');
        container.appendChild(root);

        function element(tag, className, value, parent) {
            var el = doc.createElement(tag);
            if (className) el.className = className;
            if (value !== undefined) el.textContent = value;
            if (parent) parent.appendChild(el);
            return el;
        }
        function svgElement(tag, attrs, parent, value) {
            var el = doc.createElementNS(NS, tag);
            Object.keys(attrs || {}).forEach(function (name) { el.setAttribute(name, attrs[name]); });
            if (value !== undefined) el.textContent = value;
            if (parent) parent.appendChild(el);
            return el;
        }
        function appendMark(el, token, label, missing) {
            el.setAttribute('data-oao-point', token);
            el.setAttribute('tabindex', '-1');
            el.setAttribute('role', 'img');
            el.setAttribute('aria-label', label);
            if (missing) el.classList.add('is-missing');
            svgElement('title', {}, el, label);
            marks.push(el); markByToken.set(token, el);
        }
        function valueLabel(value) { return exactNumber(value) + (value !== null && current.unit ? ' ' + current.unit : ''); }
        function isEmpty() {
            if (current.type === 'line' || current.type === 'sparkline') return !current.series.some(function (s) { return s.points.some(function (p) { return p.y !== null; }); });
            return !current.data.length || (current.type === 'donut' && current.total === 0);
        }
        function readWidth() {
            var measured = container.getBoundingClientRect().width;
            if (finite(measured) && measured > 0) width = Math.max(240, Math.round(measured));
        }
        function axisLine(svg, x1, y1, x2, y2, zero) {
            return svgElement('line', { x1: x1, y1: y1, x2: x2, y2: y2, 'class': zero ? 'oao-chart-zero' : 'oao-chart-grid' }, svg);
        }
        function axisText(svg, x, y, value, anchor, full) {
            var label = svgElement('text', { x: x, y: y, 'text-anchor': anchor || 'middle', 'class': 'oao-chart-axis' }, svg, value);
            if (full && full !== value) svgElement('title', {}, label, full);
            return label;
        }
        function yAxis(svg, domain, sx, sy, x0, x1, y0, y1) {
            for (var i = 0; i <= 4; i++) {
                var value = interpolate(domain[0], domain[1], i / 4);
                var y = sy(value);
                axisLine(svg, x0, y, x1, y, false);
                axisText(svg, x0 - 9, y + 4, number(value), 'end');
            }
            axisLine(svg, x0, sy(0), x1, sy(0), true);
        }
        function drawLine(svg, height) {
            var spark = current.type === 'sparkline';
            var x0 = spark ? 9 : 68, x1 = width - (spark ? 9 : 20);
            var y0 = spark ? 12 : 20, y1 = height - (spark ? 12 : 44);
            var xs = [], ys = [0];
            current.series.forEach(function (s) { s.points.forEach(function (p) { xs.push(p.x); if (p.y !== null) ys.push(p.y); }); });
            var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
            var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
            if (ymin === ymax) { ymin = -1; ymax = 1; }
            var sx = scale(xmin, xmax, x0, x1), sy = scale(ymin, ymax, y1, y0);
            if (!spark) {
                yAxis(svg, [ymin, ymax], sx, sy, x0, x1, y0, y1);
                var tickCount = width < 420 ? 2 : 3;
                for (var t = 0; t < (xmin === xmax ? 1 : tickCount); t++) {
                    var x = xmin === xmax ? xmin : interpolate(xmin, xmax, t / (tickCount - 1));
                    var compact = current.xType === 'time' && xmax - xmin < 86400000;
                    var full = current.xType === 'time' ? xLabel(x, current, compact) : number(x);
                    axisText(svg, sx(x), y1 + 23, shortLabel(full, width < 420 ? 12 : 22), xmin === xmax ? 'middle' : t === 0 ? 'start' : t === tickCount - 1 ? 'end' : 'middle', full);
                }
            } else axisLine(svg, x0, sy(0), x1, sy(0), true);
            current.series.forEach(function (s, seriesIndex) {
                var group = svgElement('g', {}, svg); group.style.setProperty('color', s.color);
                var d = '', connected = false;
                s.points.forEach(function (p) {
                    if (p.y === null) { connected = false; return; }
                    d += (connected ? ' L ' : ' M ') + sx(p.x) + ' ' + sy(p.y);
                    connected = true;
                });
                var path = svgElement('path', { d: d.trim(), 'class': 'oao-chart-line', fill: 'none', stroke: 'currentColor' }, group);
                // Color is supplemented by line patterns; the table also names every series.
                if (seriesIndex) path.setAttribute('stroke-dasharray', ['6 3', '2 3', '8 3 2 3'][((seriesIndex - 1) % 3)]);
                s.points.forEach(function (p) {
                    var point = svgElement('circle', { cx: sx(p.x), cy: p.y === null ? y1 : sy(p.y), r: spark ? 2.5 : 3.5, 'class': 'oao-chart-point', fill: 'currentColor' }, group);
                    appendMark(point, JSON.stringify(['series', s.key, p.x]), s.label + '，' + xLabel(p.x, current) + '，' + valueLabel(p.y), p.y === null);
                });
            });
        }
        function drawBar(svg, height) {
            var horizontal = current.horizontal;
            var values = current.data.map(function (d) { return d.value; }).concat([0]);
            var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
            if (min === max) { min = -1; max = 1; }
            var x0 = horizontal ? Math.min(150, width * 0.35) : 68, x1 = width - 20;
            var y0 = 20, y1 = height - 44;
            var numeric = horizontal ? scale(min, max, x0, x1) : scale(min, max, y1, y0);
            var slot = ((horizontal ? y1 - y0 : x1 - x0) / current.data.length);
            var thick = Math.max(1, Math.min(36, slot * 0.64));
            if (horizontal) {
                for (var t = 0; t <= 2; t++) {
                    var value = interpolate(min, max, t / 2), x = numeric(value);
                    axisLine(svg, x, y0, x, y1, false); axisText(svg, x, y1 + 22, number(value), t === 0 ? 'start' : t === 2 ? 'end' : 'middle');
                }
                axisLine(svg, numeric(0), y0, numeric(0), y1, true);
            } else yAxis(svg, [min, max], null, numeric, x0, x1, y0, y1);
            current.data.forEach(function (d, i) {
                var center = (horizontal ? y0 : x0) + slot * (i + 0.5), zero = numeric(0), end = numeric(d.value);
                var attrs = horizontal ? { x: Math.min(zero, end), y: center - thick / 2, width: Math.abs(end - zero), height: thick } : { x: center - thick / 2, y: Math.min(zero, end), width: thick, height: Math.abs(end - zero) };
                // A zero is drawn as a baseline tick, never a fabricated non-zero bar.
                if (d.value === 0) {
                    if (horizontal) { attrs.x = zero - 0.5; attrs.width = 1; }
                    else { attrs.y = zero - 0.5; attrs.height = 1; }
                }
                attrs['class'] = 'oao-chart-bar'; attrs.fill = 'currentColor';
                var rect = svgElement('rect', attrs, svg); rect.style.setProperty('color', d.color);
                appendMark(rect, JSON.stringify(['data', d.key]), d.label + '，' + valueLabel(d.value));
                if (horizontal) axisText(svg, x0 - 9, center + 4, shortLabel(d.label, Math.max(4, Math.floor((x0 - 15) / 9))), 'end', d.label);
                else {
                    var every = Math.max(1, Math.ceil(64 / slot));
                    if (i % every === 0) axisText(svg, center, y1 + 23, shortLabel(d.label, Math.max(3, Math.floor(slot * every / 9))), 'middle', d.label);
                }
            });
        }
        function drawDonut(svg, height) {
            var cx = width / 2, cy = height / 2, radius = Math.min(width * 0.3, height * 0.33), stroke = Math.max(18, radius * 0.33);
            var circumference = 2 * Math.PI * radius, offset = 0;
            current.data.forEach(function (d) {
                var fraction = d.value / current.total;
                var circle = svgElement('circle', { cx: cx, cy: cy, r: radius, fill: 'none', stroke: 'currentColor', 'stroke-width': stroke, 'stroke-dasharray': (fraction * circumference) + ' ' + circumference, 'stroke-dashoffset': -offset * circumference, transform: 'rotate(-90 ' + cx + ' ' + cy + ')', 'class': 'oao-chart-slice' }, svg);
                circle.style.setProperty('color', d.color);
                if (!d.value) circle.classList.add('is-zero');
                appendMark(circle, JSON.stringify(['data', d.key]), d.label + '，' + valueLabel(d.value) + '，' + number(fraction * 100) + '%');
                offset += fraction;
            });
            svgElement('text', { x: cx, y: cy - 4, 'text-anchor': 'middle', 'class': 'oao-chart-total' }, svg, number(current.total));
            axisText(svg, cx, cy + 21, '合计' + (current.unit ? ' · ' + current.unit : ''));
        }
        function legend() {
            var items = current.series.length ? current.series : current.type === 'bar' ? [{ label: current.unit || '数值', color: color(null, 0) }] : current.data;
            if (!items.length) return;
            var list = element('ul', 'oao-chart-legend', undefined, root); list.setAttribute('aria-label', '图例');
            items.forEach(function (item, i) {
                var row = element('li', '', undefined, list);
                var swatch = element('span', 'oao-chart-swatch', undefined, row); swatch.style.setProperty('color', item.color); swatch.setAttribute('aria-hidden', 'true');
                if (current.series.length && i) swatch.style.setProperty('border-top-style', i % 2 ? 'dashed' : 'dotted');
                var label = element('span', 'oao-chart-legend-label', item.label, row); label.setAttribute('title', item.label);
                if (current.type === 'donut') element('span', 'oao-chart-legend-value', number(item.value), row);
            });
        }
        function table(open) {
            details = element('details', 'oao-chart-data', undefined, root); details.open = open;
            summary = element('summary', '', '查看数据表', details);
            var scroll = tableScroll = element('div', 'oao-chart-table-scroll', undefined, details);
            var tab = element('table', '', undefined, scroll);
            element('caption', 'oao-chart-sr', (current.title || '图表') + '数据', tab);
            var head = element('thead', '', undefined, tab), tr = element('tr', '', undefined, head);
            var line = current.type === 'line' || current.type === 'sparkline';
            (line ? ['系列', current.xType === 'time' ? '采样时间' : 'x', '数值' + (current.unit ? '（' + current.unit + '）' : '')] : ['分类', '数值' + (current.unit ? '（' + current.unit + '）' : '')]).forEach(function (label) { var th = element('th', '', label, tr); th.setAttribute('scope', 'col'); });
            var body = element('tbody', '', undefined, tab), rows = 0;
            function row(cells) { var rowEl = element('tr', '', undefined, body); cells.forEach(function (cell, i) { var cellEl = element(i ? 'td' : 'th', '', cell, rowEl); if (!i) cellEl.setAttribute('scope', 'row'); }); rows++; }
            if (line) current.series.forEach(function (s) { s.points.forEach(function (p) { row([s.label, current.xType === 'time' ? xLabel(p.x, current) : exactNumber(p.x), exactNumber(p.y)]); }); });
            else current.data.forEach(function (d) { row([d.label, exactNumber(d.value)]); });
            if (!rows) { var emptyRow = element('tr', '', undefined, body); var cell = element('td', '', current.emptyText, emptyRow); cell.setAttribute('colspan', line ? '3' : '2'); }
            scroll.scrollTop = tableScrollTop; scroll.scrollLeft = tableScrollLeft;
        }
        function cancelAnimation() {
            if (animationFrame) global.cancelAnimationFrame(animationFrame);
            animationFrame = 0; root.classList.remove('oao-chart-changed');
            if (plot && global.Oao.motion && typeof global.Oao.motion.cancel === 'function') global.Oao.motion.cancel(plot);
            if (root.getAnimations) root.getAnimations().forEach(function (animation) { animation.cancel(); });
        }
        function animate(changed) {
            cancelAnimation();
            if (!changed || doc.hidden || (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
            if (global.Oao.motion && typeof global.Oao.motion.animate === 'function') { global.Oao.motion.animate(plot); return; }
            if (!global.requestAnimationFrame) return;
            animationFrame = global.requestAnimationFrame(function () { animationFrame = 0; if (!destroyed && !doc.hidden) root.classList.add('oao-chart-changed'); });
        }
        function render(changed) {
            if (destroyed) return;
            var active = doc.activeElement, inside = root.contains(active);
            var token = inside && active.getAttribute ? active.getAttribute('data-oao-point') : null;
            var wasSummary = active === summary, wasTableScroll = active === tableScroll, opened = details ? details.open : tableOpen;
            tableOpen = opened;
            if (tableScroll) { tableScrollTop = tableScroll.scrollTop; tableScrollLeft = tableScroll.scrollLeft; }
            cancelAnimation();
            clear(root); marks = []; markByToken.clear(); details = null; summary = null; tableScroll = null;
            root.setAttribute('data-chart-type', current.type);
            root.setAttribute('aria-labelledby', id + '-title');
            var header = element('div', 'oao-chart-header', undefined, root);
            var heading = element('h3', 'oao-chart-title', current.title || '图表', header); heading.setAttribute('id', id + '-title');
            if (current.unit) element('span', 'oao-chart-unit', current.unit, header);
            if (current.description) element('p', 'oao-chart-description', current.description, root);
            plot = element('div', 'oao-chart-plot', undefined, root); plot.setAttribute('tabindex', '0'); plot.setAttribute('role', 'group');
            plot.setAttribute('aria-label', (current.title || '图表') + '。方向键逐个查看数值，Home 和 End 查看首尾，Escape 返回图表入口。');
            if (current.error) {
                element('p', 'oao-chart-error', '无法显示图表：' + current.error, plot);
                tooltip = null; cancelAnimation();
            } else {
                if (isEmpty()) element('p', 'oao-chart-empty', current.emptyText, plot);
                else {
                    var height = current.type === 'sparkline' ? 96 : current.type === 'bar' && current.horizontal ? Math.max(240, current.data.length * 29 + 64) : 260;
                    var svg = svgElement('svg', { viewBox: '0 0 ' + width + ' ' + height, width: width, height: height, 'class': 'oao-chart-svg', role: 'group', 'aria-label': current.title || '图表数值' }, plot);
                    if (current.type === 'line' || current.type === 'sparkline') drawLine(svg, height);
                    else if (current.type === 'bar') drawBar(svg, height);
                    else drawDonut(svg, height);
                }
                tooltip = element('div', 'oao-chart-tooltip', undefined, plot); tooltip.hidden = true; tooltip.setAttribute('aria-hidden', 'true');
                legend(); table(opened); animate(changed && !isEmpty());
            }
            if (inside) {
                var restore = token && markByToken.get(token) || (wasSummary && summary) || (wasTableScroll && tableScroll) || plot;
                restore.focus({ preventScroll: true });
                // A smaller replacement table may no longer be browser-focusable as a scroll region.
                if (doc.activeElement !== restore) plot.focus({ preventScroll: true });
            }
        }
        function findMark(target) {
            if (!target || typeof target.closest !== 'function') return null;
            var found = target.closest('[data-oao-point]');
            return found && root.contains(found) ? found : null;
        }
        function showMark(mark) {
            if (!tooltip || !mark) return;
            tooltip.textContent = mark.getAttribute('aria-label'); tooltip.hidden = false;
        }
        function over(event) { showMark(findMark(event.target)); }
        function out(event) {
            if (!tooltip || findMark(event.relatedTarget)) return;
            var focused = findMark(doc.activeElement);
            if (focused) showMark(focused); else tooltip.hidden = true;
        }
        function keydown(event) {
            if (!plot || !plot.contains(event.target)) return;
            var idx = marks.indexOf(findMark(event.target)), next;
            if (event.key === 'Escape') { event.preventDefault(); plot.focus({ preventScroll: true }); if (tooltip) tooltip.hidden = true; return; }
            if (!marks.length) return;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(marks.length - 1, idx + 1);
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = idx < 0 ? marks.length - 1 : Math.max(0, idx - 1);
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = marks.length - 1;
            else return;
            event.preventDefault(); marks[next].focus({ preventScroll: true }); showMark(marks[next]);
        }
        function visibility() { if (doc.hidden) cancelAnimation(); else resize(); }
        function resize() {
            if (destroyed || resizeFrame) return;
            function run() { resizeFrame = 0; if (destroyed) return; var before = width; readWidth(); if (width !== before) render(false); }
            if (global.requestAnimationFrame) resizeFrame = global.requestAnimationFrame(run); else run();
        }
        function update(opts) {
            if (destroyed) return;
            var normalized = normalize(opts), nextSignature = JSON.stringify(normalized);
            if (nextSignature === signature) return;
            var nextData = JSON.stringify({ type: normalized.type, series: normalized.series, data: normalized.data, horizontal: normalized.horizontal, xType: normalized.xType, error: normalized.error });
            var changed = nextData !== dataSignature;
            signature = nextSignature; dataSignature = nextData; current = normalized; readWidth(); render(changed);
        }
        var listeners = [['pointerover', over], ['pointerout', out], ['focusin', over], ['focusout', out], ['keydown', keydown]];
        listeners.forEach(function (pair) { root.addEventListener(pair[0], pair[1]); });
        doc.addEventListener('visibilitychange', visibility);
        if (global.ResizeObserver) { observer = new global.ResizeObserver(resize); observer.observe(container); }
        else global.addEventListener('resize', resize);
        var api = {
            update: update,
            resize: resize,
            destroy: function () {
                if (destroyed) return;
                destroyed = true; cancelAnimation();
                if (resizeFrame) global.cancelAnimationFrame(resizeFrame);
                resizeFrame = 0;
                if (observer) observer.disconnect(); else global.removeEventListener('resize', resize);
                doc.removeEventListener('visibilitychange', visibility);
                listeners.forEach(function (pair) { root.removeEventListener(pair[0], pair[1]); });
                if (root.parentNode) root.parentNode.removeChild(root);
                clear(root); signature = ''; dataSignature = '';
                marks = []; markByToken.clear(); current = null; plot = null; tooltip = null; details = null; summary = null; tableScroll = null;
                if (instances.get(container) === api) instances.delete(container);
            }
        };
        instances.set(container, api); update(options); return api;
    }
    global.Oao = global.Oao || {};
    global.Oao.charts = { create: create };
})(window);
