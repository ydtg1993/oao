// A small eventful DOM for lifecycle/keyboard regression tests. It parses the
// production renderer's HTML and bubbles real handler calls; it does not model
// CSS layout, native tab order, or the browser accessibility tree.
const fs = require('node:fs');
const decode = s => s.replace(/&(?:amp|lt|gt|quot|#39);/g, x => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[x]));

function install() {
    const doc = { activeElement: null, listeners: {}, parentNode: null };
    function listen(type, fn) { (this.listeners[type] ||= []).push(fn); }
    function unlisten(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(x => x !== fn); }
    function dispatch(e) {
        e.target ||= this;
        e.preventDefault ||= function () { this.defaultPrevented = true; };
        e.stopPropagation ||= function () { this.stopped = true; };
        e.stopImmediatePropagation ||= function () { this.immediate = this.stopped = true; };
        // Browsers fix the event path before handlers run, even if a handler
        // removes its target while the event is still bubbling.
        const path = [];
        for (let at = this; at; at = e.bubbles === false ? null : at.parentNode) path.push(at);
        for (const at of path) {
            e.currentTarget = at;
            if (at['on' + e.type]) at['on' + e.type](e);
            for (const fn of [...(at.listeners[e.type] || [])]) { if (e.immediate) break; fn(e); }
            if (e.stopped) break;
        }
        return !e.defaultPrevented;
    }
    function match(el, selector) {
        selector = selector.trim();
        const not = [...selector.matchAll(/:not\(([^)]+)\)/g)].map(m => m[1]);
        selector = selector.replace(/:not\([^)]+\)/g, '');
        if (not.some(s => match(el, s))) return false;
        const attrs = [...selector.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]/g)];
        selector = selector.replace(/\[[^\]]+\]/g, '');
        if (attrs.some(m => !el.hasAttribute(m[1]) || (m[2] !== undefined && el.getAttribute(m[1]) !== m[2]))) return false;
        const tag = selector.match(/^[\w-]+/);
        if (tag && el.tagName !== tag[0].toUpperCase()) return false;
        const id = selector.match(/#([\w-]+)/);
        if (id && el.id !== id[1]) return false;
        return [...selector.matchAll(/\.([\w-]+)/g)].every(m => el.classList.contains(m[1]));
    }
    function matches(el, selector) {
        const parts = selector.trim().split(/\s+>\s+|\s+/);
        if (!match(el, parts.pop())) return false;
        let at = el.parentNode;
        while (parts.length) {
            const part = parts.pop();
            while (at && (!at.tagName || !match(at, part))) at = at.parentNode;
            if (!at) return false;
            at = at.parentNode;
        }
        return true;
    }
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.attrs = {}; this.children = []; this.parentNode = null;
            this.listeners = {}; this.style = {}; this.dataset = {}; this._text = ''; this.value = '';
            this.classList = {
                contains: c => this.className.split(/\s+/).includes(c),
                add: (...cs) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...cs])].join(' '); },
                remove: (...cs) => { this.className = this.className.split(/\s+/).filter(c => !cs.includes(c)).join(' '); },
                toggle: (c, force) => { const on = force === undefined ? !this.classList.contains(c) : force; this.classList[on ? 'add' : 'remove'](c); return on; },
            };
        }
        get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = v; }
        get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
        get disabled() { return this.hasAttribute('disabled'); } set disabled(v) { v ? this.setAttribute('disabled','') : this.removeAttribute('disabled'); }
        get hidden() { return this.hasAttribute('hidden'); } set hidden(v) { v ? this.setAttribute('hidden','') : this.removeAttribute('hidden'); }
        get isConnected() { return this === doc.body || !!(this.parentNode && (this.parentNode === doc || this.parentNode.isConnected)); }
        get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
        set textContent(v) { this.replaceChildren(); this._text = String(v); }
        get innerHTML() { return this._html || ''; }
        set innerHTML(html) {
            this.replaceChildren(); this._text = ''; this._html = String(html);
            const stack = [this];
            for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
                if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
                if (!token.startsWith('<')) { stack.at(-1)._text += decode(token); continue; }
                const tag = token.match(/^<([\w-]+)/); if (!tag) continue;
                const el = new Element(tag[1]);
                const attrs = token.slice(tag[0].length, -1).replace(/\/$/, '');
                for (const m of attrs.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) el.setAttribute(m[1], decode(m[2] ?? m[3] ?? m[4] ?? ''));
                stack.at(-1).appendChild(el);
                if (!/^(input|img|br|hr|meta|link)$/i.test(tag[1]) && !token.endsWith('/>')) stack.push(el);
            }
        }
        setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'type') this.type = String(v); }
        getAttribute(k) { return this.attrs[k] ?? null; }
        hasAttribute(k) { return k in this.attrs; }
        removeAttribute(k) { delete this.attrs[k]; }
        appendChild(el) { if (el.parentNode) el.remove(); this.children.push(el); el.parentNode = this; return el; }
        removeChild(el) { if (el.contains(doc.activeElement)) doc.activeElement = doc.body; this.children = this.children.filter(x => x !== el); el.parentNode = null; return el; }
        remove() { if (this.parentNode) this.parentNode.removeChild(this); }
        replaceChildren() { this.children.slice().forEach(x => this.removeChild(x)); }
        contains(el) { return el === this || this.children.some(x => x.contains(el)); }
        querySelectorAll(s) { const result = []; const selectors = s.split(','); const walk = el => { el.children.forEach(c => { if (selectors.some(q => matches(c, q))) result.push(c); walk(c); }); }; walk(this); return result; }
        querySelector(s) { return this.querySelectorAll(s)[0] || null; }
        closest(s) { for (let el = this; el && el.tagName; el = el.parentNode) if (matches(el,s)) return el; return null; }
        focus() { if (!this.isConnected || doc.activeElement === this) return; doc.activeElement = this; this.dispatchEvent({type:'focusin'}); }
        click() { if (!this.disabled) this.dispatchEvent({type:'click'}); }
        getBoundingClientRect() { return {left:0,top:0,right:120,bottom:30,width:120,height:30}; }
        getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
        scrollIntoView() {}
    }
    Element.prototype.addEventListener = listen; Element.prototype.removeEventListener = unlisten; Element.prototype.dispatchEvent = dispatch;
    Object.assign(doc, {addEventListener:listen, removeEventListener:unlisten, dispatchEvent:dispatch, createElement:tag => new Element(tag)});
    doc.body = new Element('body'); doc.body.parentNode = doc; doc.documentElement = doc.body;
    doc.activeElement = doc.body;
    doc.querySelectorAll = s => doc.body.querySelectorAll(s); doc.querySelector = s => doc.body.querySelector(s); doc.getElementById = id => doc.querySelector('#' + id);
    global.document = doc;
    global.window = {listeners:{},addEventListener:listen,removeEventListener:unlisten,dispatchEvent:dispatch,innerWidth:1200,innerHeight:800};
    global.CustomEvent = function (type, opts) { this.type = type; Object.assign(this,opts); };
    return {doc, create: tag => new Element(tag), key: (el,key,extra) => el.dispatchEvent(Object.assign({type:'keydown',key},extra))};
}
function load(path) { eval(fs.readFileSync(path,'utf8')); return window.Oao; }
const flush = () => new Promise(resolve => setImmediate(resolve));
module.exports = {install,load,flush};
