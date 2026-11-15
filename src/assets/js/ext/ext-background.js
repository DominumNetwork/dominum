import { loadExtFileText } from './extensions.js';

const backgrounds = new Map();

function loadExts() {
	try { return JSON.parse(localStorage.getItem('dominum-extensions') || '[]'); } catch { return []; }
}

function backgroundShim(extId, manifest, origin) {
	return `
window.chrome = window.browser = (function() {
	const EXT_ID = ${JSON.stringify(extId)};
	const MANIFEST = ${JSON.stringify(manifest)};
	const ORIGIN = ${JSON.stringify(origin)};
	const listeners = {};
	function fireEvent(name, ...args) {
		let result;
		(listeners[name] || []).forEach(fn => { try { const r = fn(...args); if (r !== undefined) result = r; } catch (e) { console.error('[ext-bg]', EXT_ID, e); } });
		return result;
	}
	function makeEvent(name) {
		return {
			addListener(fn) { (listeners[name] = listeners[name] || []).push(fn); },
			removeListener(fn) { listeners[name] = (listeners[name] || []).filter(f => f !== fn); },
			hasListener(fn) { return (listeners[name] || []).includes(fn); },
		};
	}

	const storage = { local: makeStorageArea('local'), sync: makeStorageArea('sync'), session: makeStorageArea('session') };
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
			set(items, cb) { const d = load(); Object.assign(d, items); save(d); if (cb) cb(); else return Promise.resolve(); },
			remove(keys, cb) { const d = load(); (Array.isArray(keys) ? keys : [keys]).forEach(k => delete d[k]); save(d); if (cb) cb(); else return Promise.resolve(); },
			clear(cb) { save({}); if (cb) cb(); else return Promise.resolve(); },
			onChanged: makeEvent('storage.' + area + '.changed'),
		};
	}

	window.addEventListener('message', e => {
		if (e.data?.type === '__dominum_bg_deliver' && e.data.extId === EXT_ID) {
			const sender = e.data.sender || {};
			const result = fireEvent('runtime.onMessage', e.data.msg, sender, (reply) => {
				window.parent.postMessage({ type: '__dominum_bg_reply', extId: EXT_ID, callId: e.data.callId, reply }, ORIGIN);
			});
			if (result && typeof result.then === 'function') {
				result.then(reply => window.parent.postMessage({ type: '__dominum_bg_reply', extId: EXT_ID, callId: e.data.callId, reply }, ORIGIN));
			}
		}
	});

	const runtime = {
		id: EXT_ID,
		getManifest() { return MANIFEST; },
		getURL(path) { return ORIGIN + '/__ext/' + EXT_ID + '/' + path.replace(/^\\//, ''); },
		sendMessage(msg, cb) {
			window.parent.postMessage({ type: '__dominum_bg_broadcast', extId: EXT_ID, msg }, ORIGIN);
			if (cb) cb({});
			return Promise.resolve({});
		},
		onMessage: makeEvent('runtime.onMessage'),
		onInstalled: makeEvent('runtime.onInstalled'),
		onStartup: makeEvent('runtime.onStartup'),
		onConnect: makeEvent('runtime.onConnect'),
		lastError: null,
		connect() { return { postMessage() {}, onMessage: makeEvent('port.onMessage'), onDisconnect: makeEvent('port.onDisconnect'), disconnect() {} }; },
	};

	return {
		runtime, storage,
		tabs: {
			query(q, cb) { if (cb) cb([]); return Promise.resolve([]); },
			sendMessage(tabId, msg, cb) { if (cb) cb(); return Promise.resolve(); },
			create(opts, cb) { window.parent.postMessage({ type: 'dominum-newtab', url: opts.url }, ORIGIN); if (cb) cb({}); return Promise.resolve({}); },
			get(tabId, cb) { if (cb) cb({}); return Promise.resolve({}); },
			update(tabId, opts, cb) { if (cb) cb(); return Promise.resolve(); },
			onUpdated: makeEvent('tabs.onUpdated'),
			onActivated: makeEvent('tabs.onActivated'),
			onRemoved: makeEvent('tabs.onRemoved'),
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
		alarms: {
			create(name, opts) {},
			clear(name, cb) { if (cb) cb(true); return Promise.resolve(true); },
			onAlarm: makeEvent('alarms.onAlarm'),
		},
		contextMenus: { create() {}, update() {}, remove() {}, removeAll() {}, onClicked: makeEvent('contextMenus.onClicked') },
		notifications: {
			create(id, opts, cb) { try { new Notification(opts.title, { body: opts.message }); } catch {} if (cb) cb(id); return Promise.resolve(id); },
			clear(id, cb) { if (cb) cb(true); return Promise.resolve(true); },
			onClicked: makeEvent('notifications.onClicked'),
			onClosed: makeEvent('notifications.onClosed'),
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
		i18n: {
			getMessage(key) { return key; },
			getUILanguage() { return navigator.language || 'en'; },
		},
	};
})();

window.__dominumBgReady = true;
window.parent.postMessage({ type: '__dominum_bg_ready', extId: ${JSON.stringify(extId)} }, ${JSON.stringify(origin)});
`;
}

function backgroundScriptPaths(manifest) {
	const bg = manifest.background;
	if (!bg) return [];

	if (bg.service_worker) return [bg.service_worker];
	if (Array.isArray(bg.scripts)) return bg.scripts;
	return [];
}

export function hasBackground(manifest) {
	return backgroundScriptPaths(manifest).length > 0;
}

async function buildBackgroundDoc(extId, manifest, origin) {
	const paths = backgroundScriptPaths(manifest);
	const scripts = [];
	for (const path of paths) {
		const code = await loadExtFileText(extId, path.replace(/^\//, ''));
		if (code) scripts.push(code);
	}
	if (!scripts.length) return null;

	const shim = backgroundShim(extId, manifest, origin);
	const body = [shim, ...scripts].map(s => `<script>try{\n${s}\n}catch(e){console.error('[ext-bg]',${JSON.stringify(extId)},e);}<\/script>`).join('\n');
	return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

export async function ensureBackground(ext) {
	const extId = ext.id;
	if (backgrounds.has(extId)) return backgrounds.get(extId).ready;

	const manifest = ext.manifest || {};
	if (!hasBackground(manifest)) return null;

	const origin = location.origin;
	const html = await buildBackgroundDoc(extId, manifest, origin);
	if (!html) return null;

	const frame = document.createElement('iframe');
	frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
	frame.style.display = 'none';
	frame.setAttribute('data-dominum-ext-bg', extId);

	const ready = new Promise(resolve => {
		function onReady(e) {
			if (e.data?.type === '__dominum_bg_ready' && e.data.extId === extId) {
				window.removeEventListener('message', onReady);
				resolve(frame);
			}
		}
		window.addEventListener('message', onReady);
		setTimeout(() => { window.removeEventListener('message', onReady); resolve(frame); }, 5000);
	});

	document.body.appendChild(frame);
	frame.srcdoc = html;

	backgrounds.set(extId, { frame, ready });
	return ready;
}

export function deliverToBackground(extId, msg, sender) {
	const entry = backgrounds.get(extId);
	if (!entry) return Promise.resolve(undefined);
	return entry.ready.then(frame => {
		if (!frame?.contentWindow) return undefined;
		const callId = Math.random().toString(36).slice(2);
		return new Promise(resolve => {
			function onReply(e) {
				if (e.data?.type === '__dominum_bg_reply' && e.data.extId === extId && e.data.callId === callId) {
					window.removeEventListener('message', onReply);
					resolve(e.data.reply);
				}
			}
			window.addEventListener('message', onReply);
			setTimeout(() => { window.removeEventListener('message', onReply); resolve(undefined); }, 8000);
			frame.contentWindow.postMessage({ type: '__dominum_bg_deliver', extId, msg, sender, callId }, location.origin);
		});
	});
}

export function removeBackground(extId) {
	const entry = backgrounds.get(extId);
	if (entry) { entry.frame.remove(); backgrounds.delete(extId); }
}

export function hasActiveBackground(extId) {
	return backgrounds.has(extId);
}

export async function startAllBackgrounds() {
	const exts = loadExts().filter(e => e.enabled !== false);
	await Promise.all(exts.map(ext => ensureBackground(ext).catch(() => {})));
}
