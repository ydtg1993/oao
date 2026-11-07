/* Optional presentation preference. Never delays or interpolates actual data. */
(function (global) {
    'use strict';
    var root = document.documentElement, key = 'oao-motion', preference = 'system', running = new Map();
    var media = typeof global.matchMedia === 'function' ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
    try { if (global.localStorage.getItem(key) === 'reduced') preference = 'reduced'; } catch (_) { /* Private/locked storage. */ }
    function reduced() { return preference === 'reduced' || !!(media && media.matches); }
    function cancel(el) { var a = running.get(el); if (a) { running.delete(el); a.cancel(); } }
    function cancelAll() { Array.from(running.keys()).forEach(cancel); }
    function apply() {
        root.setAttribute('data-oao-motion', reduced() ? 'reduced' : 'full');
        if (reduced()) cancelAll();
    }
    function animate(el, kind) {
        if (!el) return;
        cancel(el);
        if (reduced() || document.hidden || typeof el.animate !== 'function') return;
        var frames = kind === 'enter' ? [{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}] : [{opacity:0.5},{opacity:1}];
        var a = el.animate(frames, {duration:kind === 'enter' ? 220 : 160, easing:'ease-out'});
        running.set(el, a);
        a.onfinish = function () { if (running.get(el) === a) running.delete(el); };
        a.oncancel = function () { if (running.get(el) === a) running.delete(el); };
    }
    function set(value) {
        if (value !== 'system' && value !== 'reduced') throw new Error('motion preference must be system or reduced');
        preference = value;
        try { global.localStorage.setItem(key, value); } catch (_) { /* In-memory preference still works. */ }
        apply();
    }
    if (media && media.addEventListener) media.addEventListener('change', apply);
    document.addEventListener('visibilitychange', function () { if (document.hidden) cancelAll(); });
    global.addEventListener('pagehide', cancelAll);
    global.addEventListener('storage', function (e) {
        // Same-origin frames can also emit sessionStorage events; only this preference's storage applies.
        try { if (e.storageArea !== global.localStorage) return; } catch (_) { return; }
        if (e.key === key || e.key === null) { preference = e.newValue === 'reduced' ? 'reduced' : 'system'; apply(); }
    });
    apply();
    global.Oao = global.Oao || {};
    global.Oao.motion = { get: function () { return preference; }, set: set, reduced: reduced, animate: animate, cancel: cancel, cancelAll: cancelAll };
})(window);
