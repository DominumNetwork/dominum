import { loadExtFiles } from './extensions.js';
import { ensureBackground, deliverToBackground, hasBackground } from './ext-background.js';

function loadExts() {
	try { return JSON.parse(localStorage.getItem('dominum-extensions') || '[]'); } catch { return []; }
}

const contentFrames = new Map();

function registerContentFrame(extId, win) {
	if (!contentFrames.has(extId)) contentFrames.set(extId, new Set());
	contentFrames.get(extId).add(win);
}

let hubInstalled = false;
export function installHub() {
	if (hubInstalled) return;
	hubInstalled = true;
	window.addEventListener('message', async e => {
		const data = e.data;
		if (!data || typeof data !== 'object') return;

		if (data.type === '__dominum_ext_msg') {
			const exts = loadExts();
			const ext = exts.find(x => x.id === data.extId);
			if (!ext || ext.enabled === false) return;
			let reply;
			if (hasBackground(ext.manifest || {})) {
				await ensureBackground(ext);
				reply = await deliverToBackground(data.extId, data.msg, { id: data.extId, frameId: 0 });
			}
			try { e.source?.postMessage({ type: '__dominum_ext_reply', extId: data.extId, callId: data.callId, reply }, e.origin); } catch {}
			return;
		}

		if (data.type === '__dominum_bg_broadcast') {
			const frames = contentFrames.get(data.extId);
			if (!frames) return;
			for (const win of frames) {
				try { win.postMessage({ type: '__dominum_ext_broadcast', extId: data.extId, msg: data.msg }, location.origin); } catch {}
			}
			return;
		}
	});
}

function buildChromeShim(extId, manifest, origin) {
	return `
(function() {
if (window.__dominumExtId_${extId}) return;
window.__dominumExtId_${extId} = true;

if (window.__dominumExtRuntime) {
  window.__dominumExtRuntime.__registerExt(${JSON.stringify(extId)}, ${JSON.stringify(manifest)});
  return;
}

const EXT_ID = ${JSON.stringify(extId)};
const MANIFEST = ${JSON.stringify(manifest)};
const ORIGIN = ${JSON.stringify(origin)};
const listeners = {};
function fireEvent(name, ...args) {
  (listeners[name] || []).forEach(fn => { try { fn(...args); } catch {} });
}
function makeEvent(name) {
  return {
    addListener(fn) { (listeners[name] = listeners[name] || []).push(fn); },
    removeListener(fn) { listeners[name] = (listeners[name] || []).filter(f => f !== fn); },
    hasListener(fn) { return (listeners[name] || []).includes(fn); },
  };
}

const _pending = {};
let _callSeq = 0;
function postToExt(msg) {
  return new Promise(resolve => {
    const callId = 'c' + (_callSeq++) + '_' + Math.random().toString(36).slice(2);
    _pending[callId] = resolve;
    window.parent?.postMessage({ type: '__dominum_ext_msg', extId: EXT_ID, msg, callId }, ORIGIN);
    setTimeout(() => { if (_pending[callId]) { delete _pending[callId]; resolve(undefined); } }, 8000);
  });
}
window.addEventListener('message', e => {
  if (e.data?.type === '__dominum_ext_reply' && e.data.extId === EXT_ID) {
    const resolve = _pending[e.data.callId];
    if (resolve) { delete _pending[e.data.callId]; resolve(e.data.reply); }
  }
  if (e.data?.type === '__dominum_ext_broadcast' && e.data.extId === EXT_ID) {
    fireEvent('runtime.onMessage', e.data.msg, { id: EXT_ID }, () => {});
  }
});

const storage = {
  local: makeStorageArea('local'),
  sync: makeStorageArea('sync'),
  session: makeStorageArea('session'),
};
function makeStorageArea(area) {
  const key = '__dominum_ext_' + EXT_ID + '_' + area;
  function load() { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } }
  function save(d) { localStorage.setItem(key, JSON.stringify(d)); }
  return {
    get(keys, cb) {
      const d = load();
      let result;
      if (!keys) result = d;
      else if (typeof keys === 'string') result = { [keys]: d[keys] };
      else if (Array.isArray(keys)) result = Object.fromEntries(keys.map(k => [k, d[k]]));
      else result = Object.fromEntries(Object.entries(keys).map(([k, def]) => [k, k in d ? d[k] : def]));
      if (cb) cb(result); else return Promise.resolve(result);
    },
    set(items, cb) {
      const d = load();
      Object.assign(d, items);
      save(d);
      if (cb) cb(); else return Promise.resolve();
    },
    remove(keys, cb) {
      const d = load();
      (Array.isArray(keys) ? keys : [keys]).forEach(k => delete d[k]);
      save(d);
      if (cb) cb(); else return Promise.resolve();
    },
    clear(cb) { save({}); if (cb) cb(); else return Promise.resolve(); },
    onChanged: makeEvent('storage.' + area + '.changed'),
  };
}

const _nativeChrome = window.chrome;
const _shimApi = {
  runtime: {
    id: EXT_ID,
    getManifest() { return MANIFEST; },
    getURL(path) { return ORIGIN + '/__ext/' + EXT_ID + '/' + path.replace(/^\//,''); },
    sendMessage(msg, cb) {
      const p = postToExt(msg);
      if (cb) { p.then(reply => cb(reply)); return; }
      return p;
    },
    onMessage: makeEvent('runtime.onMessage'),
    onInstalled: makeEvent('runtime.onInstalled'),
    onStartup: makeEvent('runtime.onStartup'),
    onConnect: makeEvent('runtime.onConnect'),
    lastError: null,
    connect() { return { postMessage() {}, onMessage: makeEvent('port.onMessage'), onDisconnect: makeEvent('port.onDisconnect'), disconnect() {} }; },
  },
  storage,
  tabs: {
    query(q, cb) { if (cb) cb([]); return Promise.resolve([]); },
    sendMessage(tabId, msg, cb) { if (cb) cb(); return Promise.resolve(); },
    create(opts, cb) { window.parent?.postMessage({ type: 'dominum-newtab', url: opts.url }, ORIGIN); if (cb) cb({}); return Promise.resolve({}); },
    get(tabId, cb) { if (cb) cb({}); return Promise.resolve({}); },
    update(tabId, opts, cb) { if (opts.url) window.location.href = opts.url; if (cb) cb(); return Promise.resolve(); },
    getCurrent(cb) { if (cb) cb({}); return Promise.resolve({}); },
    onUpdated: makeEvent('tabs.onUpdated'),
    onActivated: makeEvent('tabs.onActivated'),
    onRemoved: makeEvent('tabs.onRemoved'),
  },
  windows: {
    getCurrent(opts, cb) { if (cb) cb({}); return Promise.resolve({}); },
    getAll(opts, cb) { if (cb) cb([]); return Promise.resolve([]); },
    create(opts, cb) { if (cb) cb({}); return Promise.resolve({}); },
    onFocusChanged: makeEvent('windows.onFocusChanged'),
  },
  action: {
    setBadgeText(opts, cb) { if (cb) cb(); return Promise.resolve(); },
    setBadgeBackgroundColor(opts, cb) { if (cb) cb(); return Promise.resolve(); },
    setIcon(opts, cb) { if (cb) cb(); return Promise.resolve(); },
    setTitle(opts, cb) { if (cb) cb(); return Promise.resolve(); },
    onClicked: makeEvent('action.onClicked'),
  },
  browserAction: {
    setBadgeText(opts, cb) { if (cb) cb(); return Promise.resolve(); },
    setBadgeBackgroundColor(opts, cb) { if (cb) cb(); return Promise.resolve(); },
    setIcon(opts, cb) { if (cb) cb(); return Promise.resolve(); },
    setTitle(opts, cb) { if (cb) cb(); return Promise.resolve(); },
    onClicked: makeEvent('browserAction.onClicked'),
  },
  scripting: {
    executeScript(opts, cb) { if (cb) cb([]); return Promise.resolve([]); },
    insertCSS(opts, cb) { if (cb) cb(); return Promise.resolve(); },
    removeCSS(opts, cb) { if (cb) cb(); return Promise.resolve(); },
  },
  i18n: {
    getMessage(key) { return key; },
    getUILanguage() { return navigator.language || 'en'; },
    detectLanguage(text, cb) { if (cb) cb({ languages: [] }); return Promise.resolve({ languages: [] }); },
  },
  contextMenus: {
    create() {},
    update() {},
    remove() {},
    removeAll() {},
    onClicked: makeEvent('contextMenus.onClicked'),
  },
  notifications: {
    create(id, opts, cb) { try { new Notification(opts.title, { body: opts.message }); } catch {} if (cb) cb(id); return Promise.resolve(id); },
    clear(id, cb) { if (cb) cb(true); return Promise.resolve(true); },
    onClicked: makeEvent('notifications.onClicked'),
    onClosed: makeEvent('notifications.onClosed'),
  },
  cookies: {
    get(details, cb) { if (cb) cb(null); return Promise.resolve(null); },
    getAll(details, cb) { if (cb) cb([]); return Promise.resolve([]); },
    set(details, cb) { if (cb) cb(null); return Promise.resolve(null); },
    remove(details, cb) { if (cb) cb(null); return Promise.resolve(null); },
    onChanged: makeEvent('cookies.onChanged'),
  },
  webRequest: {
    onBeforeRequest: makeEvent('webRequest.onBeforeRequest'),
    onBeforeSendHeaders: makeEvent('webRequest.onBeforeSendHeaders'),
    onHeadersReceived: makeEvent('webRequest.onHeadersReceived'),
    onCompleted: makeEvent('webRequest.onCompleted'),
    onErrorOccurred: makeEvent('webRequest.onErrorOccurred'),
  },
  declarativeNetRequest: {
    updateDynamicRules() { return Promise.resolve(); },
    updateSessionRules() { return Promise.resolve(); },
    getDynamicRules() { return Promise.resolve([]); },
    getSessionRules() { return Promise.resolve([]); },
    updateEnabledRulesets() { return Promise.resolve(); },
    getEnabledRulesets() { return Promise.resolve([]); },
    onRuleMatchedDebug: makeEvent('dnr.onRuleMatchedDebug'),
  },
};

window.chrome = window.browser = Object.assign({}, _nativeChrome || {}, _shimApi);

window.__dominumExtRuntime = {
  __registerExt(id, manifest) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => fireEvent('runtime.onInstalled', { reason: 'install' }));
    } else {
      fireEvent('runtime.onInstalled', { reason: 'install' });
    }
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => fireEvent('runtime.onInstalled', { reason: 'install' }));
} else {
  fireEvent('runtime.onInstalled', { reason: 'install' });
}
})();
`;
}

async function injectExtension(frameDoc, ext) {
	const files = await loadExtFiles(ext.id);
	if (!files) return;

	const manifest = ext.manifest || {};
	const origin = location.origin;

	installHub();
	if (hasBackground(manifest)) {
		ensureBackground(ext).catch(() => {});
		try { registerContentFrame(ext.id, frameDoc.defaultView); } catch {}
	}

	try {
		const shim = frameDoc.createElement('script');
		shim.textContent = buildChromeShim(ext.id, manifest, origin);
		(frameDoc.head || frameDoc.documentElement).prepend(shim);
	} catch {}

	const contentScripts = manifest.content_scripts || [];
	for (const cs of contentScripts) {
		const frameUrl = (() => { try { return frameDoc.location.href; } catch { return ''; } })();
		const matches = cs.matches || [];
		const matchesUrl = matches.some(pattern => {
			if (pattern === '<all_urls>' || pattern === '*://*/*') return true;
			try {
				const rx = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
				return new RegExp(rx).test(frameUrl);
			} catch { return false; }
		});
		if (!matchesUrl) continue;

		for (const cssPath of (cs.css || [])) {
			const css = files[cssPath] || files['/' + cssPath];
			if (!css) continue;
			try {
				const style = frameDoc.createElement('style');
				style.textContent = css;
				(frameDoc.head || frameDoc.documentElement).appendChild(style);
			} catch {}
		}

		for (const jsPath of (cs.js || [])) {
			const code = files[jsPath] || files['/' + jsPath];
			if (!code) continue;
			try {
				const script = frameDoc.createElement('script');
				script.textContent = code;
				(frameDoc.head || frameDoc.documentElement).appendChild(script);
			} catch {}
		}
	}
}

const CWS_SHIM = `(function(){
if(window.__dominumCwsShim)return;window.__dominumCwsShim=true;
window.chrome=window.chrome||{};
window.chrome.webstore={
  install:function(url,success,failure){
    var m=url?url.match(/[a-z]{32}/i):null;
    var id=m?m[0]:null;
    if(!id){var u=location.href;var n=u.match(/\\/detail\\/[^/]+\\/([a-z]{32})/i);id=n?n[1]:null;}
    if(!id){if(failure)failure('Could not determine extension ID');return;}
    window.top.postMessage({type:'__dominum_cws_install',id:id},'*');
    if(success)success();
  }
};
function tryIntercept(){
  document.querySelectorAll('button[aria-label*="Add"], button[data-item-id], [jsname="b3VHJd"]').forEach(function(btn){
    if(btn.__dominumHooked)return;btn.__dominumHooked=true;
    btn.addEventListener('click',function(e){
      var u=location.href;
      var n=u.match(/\\/detail\\/[^/]+\\/([a-z]{32})/i)||u.match(/\\/([a-z]{32})(?:[/?#]|$)/i);
      if(!n)return;
      e.preventDefault();e.stopImmediatePropagation();
      window.top.postMessage({type:'__dominum_cws_install',id:n[1]},'*');
    },true);
  });
  document.querySelectorAll('.dd-Va, [class*="webstore-test-button"], .g-c-Hb, #webstore-install-button, .h-e-f-cb-J').forEach(function(btn){
    if(btn.__dominumHooked)return;btn.__dominumHooked=true;
    btn.addEventListener('click',function(e){
      var u=location.href;
      var n=u.match(/detail\\/[^/]+\\/([a-z]{32})/i);
      if(!n)return;
      e.preventDefault();e.stopImmediatePropagation();
      window.top.postMessage({type:'__dominum_cws_install',id:n[1]},'*');
    },true);
  });
}
tryIntercept();
new MutationObserver(tryIntercept).observe(document.documentElement,{childList:true,subtree:true});
})();`;

function isCwsUrl(url) {
	try {
		const h = new URL(url).hostname;
		return h === 'chromewebstore.google.com' || h === 'chrome.google.com';
	} catch { return false; }
}

export async function injectExtensionsIntoFrame(fr) {
	let doc;
	try { doc = fr.contentDocument; } catch { return; }
	if (!doc || !doc.documentElement) return;

	try {
		const frameUrl = doc.location?.href || '';
		if (isCwsUrl(frameUrl)) {
			const s = doc.createElement('script');
			s.textContent = CWS_SHIM;
			(doc.head || doc.documentElement).prepend(s);
		}
	} catch {}

	const exts = loadExts().filter(e => e.enabled !== false);
	for (const ext of exts) {
		try { await injectExtension(doc, ext); } catch {}
	}
}
