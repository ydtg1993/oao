// Exercises the shipped browser module, without dependencies or a chart reimplementation.
// node testdata/oao_charts_test.js [static/oao-charts.js]
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
    constructor(tag, doc) {
        this.tagName = tag.toLowerCase(); this.ownerDocument = doc; this.children = [];
        this.parentNode = null; this.attrs = {}; this.listeners = new Map(); this._text = '';
        this.open = false; this.hidden = false; this.width = 640; this.scrollTop = 0; this.scrollLeft = 0;
        this.style = { setProperty(k, v) { this[k] = String(v); } };
        this.classList = {
            add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' '); },
            remove: (...names) => { this.className = this.className.split(/\s+/).filter(x => !names.includes(x)).join(' '); },
            contains: name => this.className.split(/\s+/).includes(name),
        };
    }
    get className() { return this.attrs.class || ''; }
    set className(v) { this.attrs.class = String(v); }
    get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
    set textContent(v) { this.replaceChildren(); this._text = String(v); }
    get firstChild() { return this.children[0] || null; }
    set innerHTML(_) { throw new Error('Chart data must never enter an HTML parser'); }
    appendChild(el) { if (el.parentNode) el.remove(); el.parentNode = this; this.children.push(el); return el; }
    removeChild(el) { const i = this.children.indexOf(el); if (i !== -1) this.children.splice(i, 1); el.parentNode = null; return el; }
    replaceChildren(...items) { for (const x of this.children.slice()) this.removeChild(x); this._text = ''; for (const x of items) this.appendChild(x); }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return this.getAttribute(k) !== null; }
    contains(el) { return this === el || this.children.some(x => x.contains(el)); }
    matches(sel) {
        if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
        const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(sel);
        if (attr) return attr[2] === undefined ? this.hasAttribute(attr[1]) : this.getAttribute(attr[1]) === attr[2];
        return this.tagName === sel.toLowerCase();
    }
    querySelectorAll(sel) { return this.children.flatMap(x => (x.matches(sel) ? [x] : []).concat(x.querySelectorAll(sel))); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { return this.matches(sel) ? this : this.parentNode && this.parentNode.closest(sel); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { if (this.listeners.has(type)) this.listeners.get(type).delete(fn); }
    dispatch(type, opts = {}) {
        const event = Object.assign({ type, target: this, relatedTarget: null, preventDefault() { this.defaultPrevented = true; } }, opts);
        let el = this;
        while (el) { for (const fn of el.listeners.get(type) || []) fn(event); el = el.parentNode; }
        return event;
    }
    focus() {
        const before = this.ownerDocument.activeElement;
        this.ownerDocument.activeElement = this;
        if (before && before !== this) before.dispatch('focusout', { relatedTarget: this });
        this.dispatch('focusin', { relatedTarget: before });
    }
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, width: this.width, height: 260, right: this.width, bottom: 260 }; }
}
const document = {
    hidden: false, listeners: new Map(),
    createElement(tag) { return new Element(tag, this); },
    createElementNS(_, tag) { return new Element(tag, this); },
    addEventListener: Element.prototype.addEventListener,
    removeEventListener: Element.prototype.removeEventListener,
};
document.body = document.createElement('body'); document.activeElement = document.body;
const frames = new Map(); let frameID = 0;
const observers = [];
const window = {
    document, Oao: { existingAPI: true }, listeners: new Map(),
    addEventListener: Element.prototype.addEventListener,
    removeEventListener: Element.prototype.removeEventListener,
    requestAnimationFrame(fn) { const id = ++frameID; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    matchMedia() { return { matches: false }; },
    ResizeObserver: class {
        constructor(fn) { this.fn = fn; observers.push(this); }
        observe(el) { this.el = el; }
        disconnect() { this.disconnected = true; }
    },
};
const context = vm.createContext({ window, document, console, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(process.argv[2] || path.join(__dirname, '../static/oao-charts.js'), 'utf8'), context);
const charts = window.Oao.charts;
assert.ok(window.Oao.existingAPI, 'the extension must preserve the host Oao API');
assert.equal(typeof charts.create, 'function');
function container() { return document.body.appendChild(document.createElement('div')); }
function line(points = [{ x: 0, y: -2 }, { x: 10, y: 0 }, { x: 100, y: 4 }]) {
    return { type: 'line', title: '队列趋势', unit: '项', series: [{ key: 'q', label: '排队', points }] };
}
function categorical(type = 'bar', values = [-3, 0, 7]) {
    return { type, title: '分类', data: values.map((value, i) => ({ key: 'k' + i, label: '类别 ' + i, value })) };
}
function flush() { const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn()); }
function nodes(el) { return el.querySelectorAll('[data-oao-point]'); }
function errors(el) { return el.querySelector('.oao-chart-error'); }
function allNumbersFinite(el) {
    for (const x of el.querySelectorAll('svg').flatMap(svg => [svg].concat(svg.querySelectorAll('path'), svg.querySelectorAll('circle'), svg.querySelectorAll('rect'), svg.querySelectorAll('line'), svg.querySelectorAll('text')))) {
        for (const [key, value] of Object.entries(x.attrs)) if (['d', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'width', 'height', 'viewBox', 'stroke-dasharray', 'stroke-dashoffset', 'transform'].includes(key)) assert.doesNotMatch(value, /NaN|Infinity/, key + '=' + value);
    }
}
let count = 0;
function test(name, body) {
    body(); count++; console.log('PASS ' + name);
    for (const child of document.body.children.slice()) { if (child.chart) child.chart.destroy(); child.remove(); }
    assert.ok([...document.listeners.values()].every(set => set.size === 0), 'document listeners are released');
    assert.equal(frames.size, 0, 'scheduled frames are released');
}
function mount(opts) { const el = container(); el.chart = charts.create(el, opts); return el; }

test('line uses real numeric spacing, negative values and a zero baseline', () => {
    const el = mount(line()); const pts = nodes(el);
    assert.equal(pts.length, 3);
    const xs = pts.map(x => +x.getAttribute('cx'));
    assert.ok(Math.abs((xs[1] - xs[0]) / (xs[2] - xs[0]) - 0.1) < 0.001);
    assert.ok(el.querySelector('.oao-chart-zero'));
    const ys = pts.map(x => +x.getAttribute('cy'));
    assert.ok(ys[0] > ys[1] && ys[1] > ys[2]); allNumbersFinite(el);
});
test('null creates separate subpaths and remains explicitly missing in the table', () => {
    const el = mount(line([{ x: 0, y: 1 }, { x: 1, y: null }, { x: 2, y: 3 } ]));
    const p = el.querySelector('.oao-chart-line').getAttribute('d');
    assert.equal((p.match(/M/g) || []).length, 2); assert.doesNotMatch(p, /L/);
    assert.match(el.querySelector('table').textContent, /无观测/);
});
test('single point, all zero, all missing and empty data are distinct', () => {
    const el = mount(line([{ x: 5, y: 0 }]));
    assert.equal(nodes(el).length, 1); assert.equal(el.querySelector('.oao-chart-empty'), null); allNumbersFinite(el);
    el.chart.update(line([{ x: 5, y: null }])); assert.ok(el.querySelector('.oao-chart-empty'));
    assert.match(el.querySelector('table').textContent, /无观测/);
    el.chart.update(line([])); assert.ok(el.querySelector('.oao-chart-empty'));
});
test('validates ordering, stable keys, finite values and explicit limits', () => {
    const bad = [
        line([{ x: 1, y: 1 }, { x: 1, y: 2 }]), line([{ x: 2, y: 1 }, { x: 1, y: 2 }]),
        line([{ x: NaN, y: 1 }]), line([{ x: 1, y: Infinity }]), line([{ x: 1, y: '2' }]),
        { ...line(), series: [{ key: 'a', points: [] }, { key: 'a', points: [] }] },
        { ...line(), series: Array.from({ length: 9 }, (_, i) => ({ key: '' + i, points: [] })) },
        line(Array.from({ length: 301 }, (_, x) => ({ x, y: x }))),
        categorical('bar', Array.from({ length: 51 }, () => 1)), categorical('donut', Array.from({ length: 13 }, () => 1)),
        categorical('donut', [-1, 2]), categorical('bar', [NaN]),
        { type: 'bar', data: [{ key: 'a', value: 1 }, { key: 'a', value: 2 }] },
        { type: 'bar', data: [{ value: 1 }] }, { type: 'unknown' }, { ...line(), xType: 'invalid' },
        { ...line(), series: new Array(2) }, line(new Array(2)), { type: 'bar', data: new Array(2) },
        { ...line([{ x: 8640000000000001, y: 1 }]), xType: 'time' },
        { ...line(), series: [{ ...line().series[0], color: 'url(https://evil.invalid/pixel)' }] },
        { ...line(), series: [{ ...line().series[0], color: '#12345' }] },
        { ...line(), series: [{ ...line().series[0], color: '#1234567' }] },
    ];
    const el = mount(line());
    for (const opts of bad) { el.chart.update(opts); assert.ok(errors(el), JSON.stringify(opts)); assert.equal(nodes(el).length, 0); }
    for (const color of ['#aBc', '#aBcf', '#123ABC', '#123ABCef']) {
        el.chart.update({ ...line(), series: [{ ...line().series[0], color }] });
        assert.equal(errors(el), null, color + ' is a valid hex color');
        assert.equal(el.querySelector('g').style.color, color);
    }
    const priorCSS = window.CSS, colorChecks = [];
    window.CSS = { supports(property, value) { colorChecks.push([property, value]); return value !== 'notacolor'; } };
    el.chart.update({ ...line(), series: [{ ...line().series[0], color: 'notacolor' }] });
    assert.ok(errors(el), 'browser-rejected named color must be an explicit error');
    for (const color of ['rebeccapurple', 'var(--chart-brand)']) {
        el.chart.update({ ...line(), series: [{ ...line().series[0], color }] });
        assert.equal(errors(el), null, color + ' passes browser CSS validation');
    }
    assert.deepEqual(colorChecks, [['color', 'notacolor'], ['color', 'rebeccapurple'], ['color', 'var(--chart-brand)']]);
    if (priorCSS === undefined) delete window.CSS; else window.CSS = priorCSS;
    el.chart.update(line()); assert.equal(errors(el), null); assert.equal(nodes(el).length, 3);
});
test('bar handles zero, negative, horizontal and maximum categories', () => {
    const el = mount(categorical()); let rects = nodes(el);
    assert.equal(rects.length, 3); assert.ok(+rects[0].getAttribute('height') > 0);
    assert.ok(+rects[1].getAttribute('height') >= 0); assert.ok(el.querySelector('.oao-chart-zero'));
    el.chart.update({ ...categorical(), horizontal: true }); rects = nodes(el);
    assert.ok(+rects[0].getAttribute('width') > 0); assert.ok(+rects[2].getAttribute('width') > 0);
    el.chart.update({ ...categorical('bar', Array.from({ length: 50 }, (_, i) => i)), horizontal: true });
    assert.equal(nodes(el).length, 50); assert.equal(errors(el), null); allNumbersFinite(el);
});
test('inclusive series, point and donut limits render every admitted observation', () => {
    const series = Array.from({ length: 8 }, (_, index) => ({ key: 's' + index, points: Array.from({ length: 300 }, (_, x) => ({ x, y: x % 7 ? index : null })) }));
    const el = mount({ type: 'line', series });
    assert.equal(errors(el), null); assert.equal(nodes(el).length, 2400);
    assert.equal(el.querySelector('tbody').children.length, 2400); allNumbersFinite(el);
    el.chart.update(categorical('donut', Array.from({ length: 12 }, (_, index) => index)));
    assert.equal(errors(el), null); assert.equal(nodes(el).length, 12);
    assert.equal(el.querySelector('tbody').children.length, 12); allNumbersFinite(el);
});
test('donut zero-total is empty; single slice and tiny positive values are valid', () => {
    const el = mount(categorical('donut', [0, 0])); assert.ok(el.querySelector('.oao-chart-empty'));
    el.chart.update(categorical('donut', [4])); assert.equal(nodes(el).length, 1); allNumbersFinite(el);
    el.chart.update(categorical('donut', [Number.MIN_VALUE, Number.MIN_VALUE])); assert.equal(errors(el), null); allNumbersFinite(el);
});
test('finite extreme inputs cannot produce invalid SVG coordinates', () => {
    const el = mount(line([{ x: -Number.MAX_VALUE, y: -Number.MAX_VALUE }, { x: 0, y: 0 }, { x: Number.MAX_VALUE, y: Number.MAX_VALUE }]));
    assert.equal(errors(el), null); allNumbersFinite(el);
    el.chart.update(categorical('bar', [-Number.MAX_VALUE, Number.MAX_VALUE])); assert.equal(errors(el), null); allNumbersFinite(el);
    el.chart.update(categorical('donut', [Number.MAX_VALUE, Number.MAX_VALUE])); assert.ok(errors(el), 'overflow total must be explicit');
});
test('small spans on large numeric and time origins retain actual point spacing', () => {
    const el = mount(line());
    for (const [origin, step, xType] of [[1e16, 2, 'number'], [-1e16, 2, 'number'], [1794000000000, 1, 'time']]) {
        el.chart.update({ ...line([{ x: origin, y: 1 }, { x: origin + step, y: 2 }, { x: origin + 3 * step, y: 3 }]), xType });
        assert.equal(errors(el), null);
        const xs = nodes(el).map(point => +point.getAttribute('cx'));
        const fraction = (xs[1] - xs[0]) / (xs[2] - xs[0]);
        assert.ok(Math.abs(fraction - 1 / 3) < 1e-12, xType + ' spacing at ' + origin + ' is ' + fraction);
        allNumbersFinite(el);
    }
});
test('title, labels, description, error and unit are always plain text', () => {
    const attack = '<img src=x onerror=alert(1)>';
    const el = mount({ ...categorical(), title: attack, unit: attack, description: attack, data: [{ key: attack, label: attack, value: 1 }] });
    assert.match(el.textContent, /<img/); assert.equal(el.querySelector('img'), null);
    el.chart.update({ type: 'line', error: attack }); assert.match(errors(el).textContent, /<img/);
});
test('the data table and accessible value keep precision when axis labels are shortened', () => {
    const el = mount(line([{ x: 0.123456789, y: 0.987654321 }]));
    assert.match(el.querySelector('table').textContent, /0\.123456789/);
    assert.match(el.querySelector('table').textContent, /0\.987654321/);
    assert.match(nodes(el)[0].getAttribute('aria-label'), /0\.123456789/, 'numeric x stays exact in keyboard and pointer inspection');
    assert.match(nodes(el)[0].getAttribute('aria-label'), /0\.987654321/);
});
test('keyboard inspection, hover, poll focus, details and removed-point fallback', () => {
    const el = mount(line()); let plot = el.querySelector('.oao-chart-plot');
    plot.focus(); plot.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(document.activeElement, nodes(el)[0]);
    document.activeElement.dispatch('keydown', { key: 'End' }); assert.equal(document.activeElement, nodes(el)[2]);
    const token = document.activeElement.getAttribute('data-oao-point');
    el.querySelector('details').open = true;
    el.chart.update(line([{ x: 0, y: -3 }, { x: 10, y: 1 }, { x: 100, y: 5 }]));
    assert.equal(document.activeElement.getAttribute('data-oao-point'), token); assert.ok(el.querySelector('details').open);
    assert.equal(el.querySelectorAll('[aria-live]').length, 0, 'polling must not become a live announcement');
    nodes(el)[0].dispatch('pointerover'); assert.equal(el.querySelector('.oao-chart-tooltip').hidden, false);
    assert.match(el.querySelector('.oao-chart-tooltip').textContent, /排队/);
    el.chart.update(line([{ x: 0, y: 1 }])); assert.equal(document.activeElement, el.querySelector('.oao-chart-plot'));
    const summary = el.querySelector('summary'); summary.focus(); el.chart.update(line([{ x: 0, y: 2 }]));
    assert.equal(document.activeElement, el.querySelector('summary'));
});
test('unchanged data avoids rerender and update replaces all options', () => {
    const el = mount(line()); const old = el.querySelector('svg'); el.chart.update(line()); assert.equal(el.querySelector('svg'), old);
    el.chart.update(categorical('donut', [1, 2])); assert.equal(el.querySelector('.oao-chart-line'), null);
    assert.equal(nodes(el).length, 2); assert.doesNotMatch(el.textContent, /排队/);
});
test('replacement drops omitted settings and input objects cannot mutate rendered snapshots', () => {
    const source = { ...line(), description: '旧描述', xType: 'time' };
    const el = mount(source);
    source.series[0].points[0].y = 42; source.series[0].label = '已改来源';
    el.width = 320; el.chart.resize(); flush();
    assert.match(nodes(el)[0].getAttribute('aria-label'), /排队/);
    assert.doesNotMatch(nodes(el)[0].getAttribute('aria-label'), /已改来源|42 项/);
    el.chart.update({ type: 'bar', horizontal: true, data: [{ key: 'a', value: 2 }], error: '暂时错误' });
    assert.ok(errors(el));
    el.chart.update({ type: 'bar', data: [{ key: 'a', value: 2 }] });
    assert.equal(errors(el), null);
    assert.equal(el.querySelector('.oao-chart-unit'), null); assert.equal(el.querySelector('.oao-chart-description'), null);
    assert.ok(+nodes(el)[0].getAttribute('height') > +nodes(el)[0].getAttribute('width'), 'omitted horizontal returns to a vertical column');
    el.chart.update({ type: 'line' });
    assert.ok(el.querySelector('.oao-chart-empty')); assert.equal(nodes(el).length, 0);
});
test('details expansion survives a transient error and category focus follows stable keys', () => {
    const el = mount(categorical()); el.querySelector('details').open = true;
    nodes(el)[1].focus(); const token = document.activeElement.getAttribute('data-oao-point');
    const reordered = categorical(); reordered.data.reverse(); el.chart.update(reordered);
    assert.equal(document.activeElement.getAttribute('data-oao-point'), token);
    el.chart.update({ type: 'bar', error: '暂时不可用' }); assert.equal(document.activeElement, el.querySelector('.oao-chart-plot'));
    el.chart.update(categorical()); assert.ok(el.querySelector('details').open);
});
test('background polls and resizing never claim focus from another chart or an outside control', () => {
    const first = mount(line()), second = mount(categorical());
    nodes(second)[1].focus(); const focused = document.activeElement;
    first.chart.update(line([{ x: 0, y: 3 }]));
    first.width = 420; first.chart.resize(); flush(); assert.equal(document.activeElement, focused);
    const outside = container(); outside.focus();
    second.chart.update(categorical('bar', [3, 2, 1])); assert.equal(document.activeElement, outside);
    second.querySelector('summary').focus(); second.querySelector('details').open = true;
    second.width = 300; second.chart.resize(); flush();
    assert.equal(document.activeElement, second.querySelector('summary')); assert.ok(second.querySelector('details').open);
});
test('polls and resize preserve the data table scrolling context and focused scroll region', () => {
    const values = Array.from({ length: 50 }, (_, index) => index);
    const el = mount(categorical('bar', values)); el.querySelector('details').open = true;
    let scroll = el.querySelector('.oao-chart-table-scroll');
    scroll.scrollTop = 280; scroll.scrollLeft = 64; scroll.focus();
    el.chart.update(categorical('bar', values.map(value => value + 1)));
    scroll = el.querySelector('.oao-chart-table-scroll');
    assert.ok(document.activeElement === scroll, 'polling preserves the browser-focusable table scroll region');
    assert.equal(scroll.scrollTop, 280); assert.equal(scroll.scrollLeft, 64);
    el.width = 320; el.chart.resize(); flush(); scroll = el.querySelector('.oao-chart-table-scroll');
    assert.ok(document.activeElement === scroll); assert.equal(scroll.scrollTop, 280); assert.equal(scroll.scrollLeft, 64);
    const outside = container(); outside.focus();
    scroll.scrollTop = 420; scroll.scrollLeft = 90;
    el.chart.update({ type: 'bar', error: '暂时不可用' });
    el.chart.update(categorical('bar', values)); scroll = el.querySelector('.oao-chart-table-scroll');
    assert.equal(document.activeElement, outside, 'restoring the table never captures outside focus');
    assert.ok(el.querySelector('details').open); assert.equal(scroll.scrollTop, 420); assert.equal(scroll.scrollLeft, 90);
});
test('optional host motion cancels old plots and identical polls do not replay', () => {
    const started = [], cancelled = [];
    window.Oao.motion = { animate(el) { started.push(el); }, cancel(el) { cancelled.push(el); } };
    const el = mount(line()); const oldPlot = el.querySelector('.oao-chart-plot');
    assert.equal(started.length, 1); el.chart.update(line()); assert.equal(started.length, 1);
    el.chart.update({ ...line(), description: '单位与口径说明' }); assert.equal(started.length, 1);
    assert.ok(cancelled.includes(oldPlot));
    el.chart.update(line([{ x: 0, y: 4 }])); assert.equal(started.length, 2);
    const plot = el.querySelector('.oao-chart-plot'); el.chart.destroy(); assert.ok(cancelled.includes(plot));
    delete window.Oao.motion;
});
test('system reduced motion and hidden documents prevent new animation work', () => {
    const priorMatchMedia = window.matchMedia; let starts = 0;
    window.Oao.motion = { animate() { starts++; }, cancel() {} };
    window.matchMedia = () => ({ matches: true }); const el = mount(line()); assert.equal(starts, 0);
    window.matchMedia = priorMatchMedia; document.hidden = true;
    el.chart.update(line([{ x: 0, y: 8 }])); assert.equal(starts, 0);
    document.hidden = false; delete window.Oao.motion;
});
test('window resize fallback is removed at destroy', () => {
    const Observer = window.ResizeObserver; delete window.ResizeObserver;
    const el = mount(line()); assert.equal(window.listeners.get('resize').size, 1);
    el.chart.destroy(); assert.equal(window.listeners.get('resize').size, 0); window.ResizeObserver = Observer;
});
test('separate instances, recreation, hidden resize and destroy clean up resources', () => {
    const a = mount(line()); const b = mount(categorical()); const prior = a.chart; const oldObserver = observers.at(-2);
    a.chart = charts.create(a, categorical('donut', [1])); assert.ok(oldObserver.disconnected); assert.equal(a.querySelectorAll('.oao-chart').length, 1);
    prior.update(line()); assert.equal(nodes(a).length, 1); assert.equal(nodes(b).length, 3);
    a.width = 0; a.chart.resize(); flush(); a.width = 300; a.chart.resize(); flush(); allNumbersFinite(a);
    const currentObserver = observers.at(-1); a.chart.resize(); const root = a.querySelector('.oao-chart');
    a.chart.destroy(); a.chart.destroy(); assert.ok(currentObserver.disconnected); assert.equal(a.children.length, 0);
    assert.ok([...root.listeners.values()].every(set => set.size === 0));
    assert.equal(frames.size, 0); a.chart.update(line()); assert.equal(a.children.length, 0);
});
test('observer callbacks and pending frames are harmless after destruction', () => {
    const el = mount(line()); flush(); const observer = observers.at(-1);
    el.width = 300; observer.fn(); observer.fn(); el.chart.resize();
    assert.equal(frames.size, 1, 'resize work is coalesced');
    const pending = [...frames.values()]; const root = el.querySelector('.oao-chart');
    el.chart.destroy(); assert.equal(frames.size, 0);
    observer.fn(); pending.forEach(callback => callback());
    root.dispatch('keydown', { key: 'ArrowRight' });
    el.chart.resize(); assert.equal(el.children.length, 0); assert.equal(frames.size, 0);
});
test('sparkline retains numeric semantics, table and accessible point names', () => {
    const el = mount({ ...line(), type: 'sparkline', xType: 'time' });
    assert.equal(nodes(el).length, 3); assert.ok(el.querySelector('table'));
    assert.match(nodes(el)[0].getAttribute('aria-label'), /排队/); assert.equal(errors(el), null);
});
test('chart data table explicitly isolates text, row backgrounds and hover from host tables', () => {
    const css = fs.readFileSync(path.join(path.dirname(process.argv[2] || path.join(__dirname, '../static/oao-charts.js')), 'oao-charts.css'), 'utf8');
    const declarations = selector => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(match => match[1].split(',').map(value => value.trim()).includes(selector)).map(match => match[2]).join('\n');
    for (const cell of ['th', 'td']) {
        const style = declarations('.oao-chart .oao-chart-data ' + cell);
        assert.match(style, /color:\s*var\(--oao-chart-ink\)/, cell + ' must override explicit host text colors');
        assert.match(style, /border:\s*0\s*;/, cell + ' must not inherit the host grid borders');
        assert.match(style, /white-space:\s*normal\s*;/, cell + ' long labels can wrap');
        assert.match(declarations('.oao-chart .oao-chart-data tbody tr:nth-child(n) > ' + cell), /background:\s*var\(--oao-chart-paper\)/, cell + ' has a consistent body background');
        assert.match(declarations('.oao-chart .oao-chart-data tbody tr:hover > ' + cell), /background:\s*var\(--oao-chart-soft\)/, cell + ' uses the same chart hover background');
    }
    assert.match(declarations('.oao-chart .oao-chart-data thead tr'), /background:\s*var\(--oao-chart-soft\)/);
    assert.match(declarations('.oao-chart .oao-chart-data thead th'), /background:\s*var\(--oao-chart-soft\)/);
});
console.log('PASS ' + count + ' chart regression groups (production JS behavior and CSS isolation)');
