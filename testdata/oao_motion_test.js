const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const events={},attrs={},media={matches:false,addEventListener:(k,f)=>events.media=f},document={hidden:false,documentElement:{setAttribute:(k,v)=>attrs[k]=v},addEventListener:(k,f)=>events[k]=f};
const window={Oao:{},matchMedia:()=>media,localStorage:{getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}},addEventListener:(k,f)=>events[k]=f};
vm.runInNewContext(fs.readFileSync(process.argv[2]||path.join(__dirname,'../static/oao-motion.js'),'utf8'),{window,document});
const m=window.Oao.motion;let starts=0,cancels=0;
const el={animate:()=>{starts++;return{cancel:()=>cancels++};}};
m.animate(el);m.animate(el);assert.equal(starts,2);assert.equal(cancels,1);
m.set('reduced');assert.equal(cancels,2);assert.equal(attrs['data-oao-motion'],'reduced');m.animate(el);assert.equal(starts,2);
m.set('system');media.matches=true;events.media();assert.equal(m.reduced(),true);
media.matches=false;events.media();m.animate(el);document.hidden=true;events.visibilitychange();assert.equal(cancels,3);
m.animate(el);assert.equal(starts,3);document.hidden=false;m.animate(el);m.cancel(el);assert.equal(cancels,4);
assert.throws(()=>m.set('full'));assert.equal(m.get(),'system');
m.set('reduced');
events.storage({key:'oao-motion',newValue:'system',storageArea:{}});
assert.equal(m.get(),'reduced','sessionStorage events must not overwrite the localStorage motion preference');
events.storage({key:'oao-motion',newValue:'system',storageArea:window.localStorage});
assert.equal(m.get(),'system');

// Completion from an older animation must not release its replacement or another element.
const animations=[];
function animatedElement(){return{animate(){const animation={cancels:0,cancel(){this.cancels++;}};animations.push(animation);return animation;}};}
const first=animatedElement(),second=animatedElement();
m.animate(first);const old=animations.at(-1);m.animate(first);const replacement=animations.at(-1);
m.animate(second);const other=animations.at(-1);
old.onfinish();old.oncancel();m.cancel(first);
assert.equal(old.cancels,1);assert.equal(replacement.cancels,1);assert.equal(other.cancels,0);
events.pagehide();assert.equal(other.cancels,1);events.pagehide();assert.equal(other.cancels,1);
m.animate(first);const finished=animations.at(-1);finished.onfinish();m.cancelAll();assert.equal(finished.cancels,0);
m.animate(second);const external=animations.at(-1);external.oncancel();m.cancelAll();assert.equal(external.cancels,0);
m.animate({});m.animate(null);

m.set('reduced');events.storage({key:null,newValue:null,storageArea:{}});assert.equal(m.get(),'reduced');
events.storage({key:'unrelated',newValue:'system',storageArea:window.localStorage});assert.equal(m.get(),'reduced');
events.storage({key:null,newValue:null,storageArea:window.localStorage});assert.equal(m.get(),'system');
events.storage({key:'oao-motion',newValue:'reduced',storageArea:window.localStorage});assert.equal(m.get(),'reduced');
const localStorage=window.localStorage;
Object.defineProperty(window,'localStorage',{configurable:true,get(){throw Error('blocked property');}});
assert.doesNotThrow(()=>events.storage({key:'oao-motion',newValue:'system',storageArea:localStorage}));
assert.equal(m.get(),'reduced');assert.doesNotThrow(()=>m.set('system'));
Object.defineProperty(window,'localStorage',{configurable:true,value:localStorage});

// Removing transition alone still leaves the core button's hover/active displacement in place.
const css=fs.readFileSync(path.join(path.dirname(process.argv[2]||path.join(__dirname,'../static/oao-motion.js')),'oao-motion.css'),'utf8');
const ruleBodies=selector=>[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match=>match[1].split(',').map(s=>s.trim()).includes(selector)).map(match=>match[2]).join('\n');
for(const state of ['hover','active']) {
    assert.match(ruleBodies('[data-oao-motion="reduced"] .oao-btn:'+state),/transform:\s*none\s*!important/,'explicit reduced preference stops button '+state+' displacement');
}
const systemRules=css.slice(css.indexOf('@media(prefers-reduced-motion:reduce)'));
assert.match(systemRules,/\.oao-btn:hover,\s*\.oao-btn:active\s*\{\s*transform:\s*none\s*!important/,'system reduced preference stops button displacement');
console.log('motion: storage isolation, inaccessible storage, stale completion, multiple elements, pagehide, reduced displacement and cancellation passed');
