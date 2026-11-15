import { loadExtFileText, getExtensions, setExtensionEnabled } from './extensions.js';
import { ensureBackground, deliverToBackground, hasBackground } from './ext-background.js';

async function ensureExtSW() {
	if (!('serviceWorker' in navigator)) return;
	if (navigator.serviceWorker.controller) return;
	try {
		await navigator.serviceWorker.register('/sw.js');
		await navigator.serviceWorker.ready;
	} catch {}
}

function injectChromeApi(win, extId, manifest, ext) {
	const _ev = {};
	function ev(n) {
		return {
			addListener: f => { (_ev[n] = _ev[n] || []).push(f); },
			removeListener: f => { _ev[n] = (_ev[n] || []).filter(x => x !== f); },
			hasListener: f => (_ev[n] || []).includes(f),
			dispatch: (...a) => (_ev[n] || []).forEach(f => f(...a)),
		};
	}
	function mkStore(area) {
		const key = `__dext_${extId}_${area}`;
		const ld = () => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } };
		const sv = d => localStorage.setItem(key, JSON.stringify(d));
		return {
			get(keys, cb) {
				const d = ld(); let r;
				if (!keys) r = d;
				else if (typeof keys === 'string') r = { [keys]: d[keys] };
				else if (Array.isArray(keys)) r = Object.fromEntries(keys.map(k => [k, d[k]]));
				else r = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in d ? d[k] : v]));
				if (cb) cb(r); else return Promise.resolve(r);
			},
			set(it, cb) { const d = ld(); Object.assign(d, it); sv(d); if (cb) cb(); else return Promise.resolve(); },
			remove(keys, cb) { const d = ld(); (Array.isArray(keys) ? keys : [keys]).forEach(k => delete d[k]); sv(d); if (cb) cb(); else return Promise.resolve(); },
			clear(cb) { sv({}); if (cb) cb(); else return Promise.resolve(); },
			onChanged: ev(`st.${area}`),
		};
	}

	const extBase = `${location.origin}/__ext/${extId}/`;

	const api = {
		runtime: {
			id: extId,
			getManifest: () => manifest,
			getURL: p => extBase + p.replace(/^\//, ''),
			sendMessage: (m, cb) => {
				const p = hasBackground(manifest)
					? ensureBackground(ext).then(() => deliverToBackground(extId, m, { id: extId, popup: true }))
					: Promise.resolve(undefined);
				if (cb) { p.then(reply => cb(reply)); return; }
				return p;
			},
			onMessage: ev('msg'),
			onInstalled: ev('inst'),
			lastError: null,
		},
		storage: { local: mkStore('local'), sync: mkStore('sync'), session: mkStore('session') },
		tabs: {
			query: (q, cb) => { if (cb) cb([]); return Promise.resolve([]); },
			sendMessage: (id, m, cb) => { if (cb) cb(); return Promise.resolve(); },
			create: (o, cb) => { window.open(o.url, '_blank'); if (cb) cb({}); return Promise.resolve({}); },
			getCurrent: cb => { if (cb) cb({}); return Promise.resolve({}); },
		},
		i18n: { getMessage: k => k, getUILanguage: () => navigator.language || 'en' },
		action: {
			setBadgeText: (o, cb) => { if (cb) cb(); return Promise.resolve(); },
			setBadgeBackgroundColor: (o, cb) => { if (cb) cb(); return Promise.resolve(); },
			onClicked: ev('action'),
		},
		browserAction: {
			setBadgeText: (o, cb) => { if (cb) cb(); return Promise.resolve(); },
			setBadgeBackgroundColor: (o, cb) => { if (cb) cb(); return Promise.resolve(); },
			onClicked: ev('action'),
		},
	};

	win.chrome = api;
	if (!win.browser) win.browser = api;
}

function rewriteExtHtml(html, extId, pagePath) {
	const pageDir = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/') + 1) : '';
	const base = `${location.origin}/__ext/${extId}/${pageDir}`;
	const baseTag = `<base href="${base}">`;
	if (/<head\b/i.test(html)) {
		return html.replace(/<head\b([^>]*)>/i, `<head$1>${baseTag}`);
	}
	return baseTag + html;
}

const MIN_W = 180, MAX_W = 420, MIN_H = 100, MAX_H = 600;

function measurePopup(win) {
	try {
		const doc = win.document;
		const el = doc.documentElement;
		const w = Math.max(el.scrollWidth, doc.body?.scrollWidth || 0);
		const h = Math.max(el.scrollHeight, doc.body?.scrollHeight || 0);
		if (!w || !h) return null;
		return {
			width: Math.min(MAX_W, Math.max(MIN_W, w)),
			height: Math.min(MAX_H, Math.max(MIN_H, h)),
		};
	} catch { return null; }
}

let panelRoot = null;
function root() {
	if (!panelRoot) {
		panelRoot = document.createElement('div');
		panelRoot.id = 'ext-ui-root';
		document.body.appendChild(panelRoot);
	}
	return panelRoot;
}

export function openExtPopup(ext, anchorRect) {
	const manifest = ext.manifest || {};
	const popupPath =
		manifest.action?.default_popup ||
		manifest.browser_action?.default_popup ||
		manifest.page_action?.default_popup;

	const win = document.createElement('div');
	win.className = 'ext-window';
	win.style.top = `${(anchorRect?.bottom ?? 60) + 8}px`;
	win.style.right = `${Math.max(8, window.innerWidth - (anchorRect?.right ?? 400))}px`;

	const bar = document.createElement('div');
	bar.className = 'ext-window-bar';
	bar.innerHTML = `
		<div class="ext-panel-icon">${ext.icon ? `<img src="${ext.icon}" alt="">` : '<i class="fa-solid fa-puzzle-piece"></i>'}</div>
		<span class="ext-window-title"></span>
		<button class="ext-window-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
	`;
	bar.querySelector('.ext-window-title').textContent = ext.name || ext.id;
	win.appendChild(bar);

	function close() { win.remove(); document.removeEventListener('mousedown', onOutside, true); }
	bar.querySelector('.ext-window-close').addEventListener('click', close);
	function onOutside(e) { if (!win.contains(e.target)) close(); }
	setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);

	if (!popupPath) {
		const msg = document.createElement('div');
		msg.className = 'ext-window-error';
		msg.textContent = 'This extension has no popup page.';
		win.appendChild(msg);
		root().appendChild(win);
		return;
	}

	const fr = document.createElement('iframe');
	fr.className = 'ext-window-frame';
	win.appendChild(fr);
	root().appendChild(win);

	let cancelled = false;
	let retried = false;

	function navigateBootstrap() {
		fr.addEventListener('load', onBootstrapLoad, { once: true });
		fr.src = `${location.origin}/__ext/${ext.id}/__bootstrap__?r=${Date.now()}`;
	}

	function showError(text) {
		const msg = document.createElement('div');
		msg.className = 'ext-window-error';
		msg.textContent = text;
		fr.replaceWith(msg);
	}

	function onBootstrapLoad() {
		if (cancelled) return;
		let intercepted = false;
		try { intercepted = !!fr.contentDocument?.querySelector('meta[name="dominum-ext-sw"]'); } catch {}
		if (!intercepted) {
			if (!retried) { retried = true; navigateBootstrap(); return; }
			showError('Extension frame lost same-origin access — try reopening.');
			return;
		}

		loadExtFileText(ext.id, popupPath).then(html => {
			if (cancelled) return;
			if (!html) { showError(`Popup file "${popupPath}" not found.`); return; }

			const cw = fr.contentWindow;
			if (!cw) { showError('Frame has no contentWindow.'); return; }
			try { injectChromeApi(cw, ext.id, manifest, ext); } catch {}

			const rewritten = rewriteExtHtml(html, ext.id, popupPath);
			try {
				cw.document.open();
				cw.document.write(rewritten);
				cw.document.close();
			} catch {
				showError('Extension frame lost same-origin access — try reopening.');
				return;
			}
			setTimeout(() => { try { cw.dispatchEvent(new cw.Event('load')); } catch {} }, 0);

			const measure = () => {
				if (cancelled) return;
				const m = measurePopup(cw);
				if (m) { fr.style.width = m.width + 'px'; fr.style.height = m.height + 'px'; win.style.width = m.width + 'px'; }
			};
			measure();
			setTimeout(measure, 100);
			setTimeout(measure, 400);
			try {
				const ro = new cw.ResizeObserver(measure);
				ro.observe(cw.document.documentElement);
			} catch {}
		}).catch(e => { if (!cancelled) showError(e.message); });
	}

	ensureExtSW().then(() => { if (!cancelled) navigateBootstrap(); });
}

function extHasPopup(ext) {
	const m = ext.manifest || {};
	return !!(m.action?.default_popup || m.browser_action?.default_popup || m.page_action?.default_popup);
}

function closeDropdown() {
	document.querySelectorAll('.ext-panel').forEach(p => p.remove());
	document.removeEventListener('mousedown', onDropdownOutside, true);
}
function onDropdownOutside(e) {
	if (!e.target.closest('.ext-panel') && !e.target.closest('#extToolbarBtn')) closeDropdown();
}

export function toggleExtDropdown(anchorEl, opts = {}) {
	const existing = document.querySelector('.ext-panel');
	if (existing) { closeDropdown(); return; }

	const exts = getExtensions();
	const r = anchorEl.getBoundingClientRect();

	const panel = document.createElement('div');
	panel.className = 'ext-panel';
	panel.style.top = `${r.bottom + 8}px`;
	panel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;

	const hdr = document.createElement('div');
	hdr.className = 'ext-panel-hdr';
	hdr.innerHTML = '<span>Extensions</span>';
	panel.appendChild(hdr);

	if (!exts.length) {
		const empty = document.createElement('div');
		empty.className = 'ext-panel-empty';
		empty.textContent = 'No extensions installed.';
		panel.appendChild(empty);
	} else {
		const enabled = exts.filter(e => e.enabled !== false);
		const disabled = exts.filter(e => e.enabled === false);

		function renderGroup(list, label, sub) {
			if (!list.length) return;
			const group = document.createElement('div');
			group.className = 'ep-group';
			if (label) {
				const lbl = document.createElement('div');
				lbl.className = 'ep-group-lbl';
				lbl.textContent = label;
				group.appendChild(lbl);
			}
			if (sub) {
				const s = document.createElement('div');
				s.className = 'ep-group-sub';
				s.textContent = sub;
				group.appendChild(s);
			}
			list.forEach(ext => group.appendChild(renderExtRow(ext)));
			panel.appendChild(group);
		}

		function renderExtRow(ext) {
			const hasPopup = extHasPopup(ext);
			const clickable = ext.enabled !== false && hasPopup;
			const row = document.createElement('div');
			row.className = `ext-panel-item${clickable ? ' clickable' : ''}${ext.enabled === false ? ' ep-disabled' : ''}`;
			row.innerHTML = `
				<div class="ext-panel-icon">${ext.icon ? `<img src="${ext.icon}" alt="">` : '<i class="fa-solid fa-puzzle-piece"></i>'}</div>
				<span class="ext-panel-name"></span>
				<div class="ep-actions">
					<button class="ep-dots" title="More options"><i class="fa-solid fa-ellipsis-vertical"></i></button>
				</div>
			`;
			row.querySelector('.ext-panel-name').textContent = ext.name || ext.id;

			row.addEventListener('click', e => {
				if (e.target.closest('.ep-actions')) return;
				if (!clickable) return;
				const rr = row.getBoundingClientRect();
				closeDropdown();
				openExtPopup(ext, rr);
			});

			row.querySelector('.ep-dots').addEventListener('click', e => {
				e.stopPropagation();
				document.querySelectorAll('.ep-menu').forEach(m => m.remove());
				const menu = document.createElement('div');
				menu.className = 'ep-menu';
				menu.innerHTML = `
					<button data-act="toggle"><i class="fa-solid ${ext.enabled !== false ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>${ext.enabled !== false ? 'Disable' : 'Enable'}</button>
					<button data-act="manage"><i class="fa-solid fa-gear"></i>Manage extension</button>
				`;
				menu.querySelector('[data-act="toggle"]').addEventListener('click', () => {
					setExtensionEnabled(ext.id, ext.enabled === false);
					closeDropdown();
					toggleExtDropdown(anchorEl, opts);
				});
				menu.querySelector('[data-act="manage"]').addEventListener('click', () => {
					closeDropdown();
					opts.onManage?.();
				});
				row.querySelector('.ep-menu-wrap')?.remove();
				const wrap = document.createElement('div');
				wrap.className = 'ep-menu-wrap';
				wrap.appendChild(menu);
				row.querySelector('.ep-actions').appendChild(wrap);
			});

			return row;
		}

		renderGroup(enabled, enabled.length ? 'Full access' : '', enabled.length ? 'These extensions can see and change information on this site.' : '');
		renderGroup(disabled, disabled.length ? 'Disabled' : '');
	}

	const footer = document.createElement('div');
	footer.className = 'ep-footer';
	footer.innerHTML = '<i class="fa-solid fa-gear"></i><span>Manage extensions</span>';
	footer.addEventListener('click', () => { closeDropdown(); opts.onManage?.(); });
	panel.appendChild(footer);

	root().appendChild(panel);
	setTimeout(() => document.addEventListener('mousedown', onDropdownOutside, true), 0);
}

export function extensionCount() {
	return getExtensions().length;
}
