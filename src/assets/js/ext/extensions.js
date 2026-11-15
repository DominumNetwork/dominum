function _extDB() {
	return new Promise((res, rej) => {
		const r = indexedDB.open('dominum-ext', 1);
		r.onupgradeneeded = e => {
			const db = e.target.result;
			if (!db.objectStoreNames.contains('ext_files')) {
				db.createObjectStore('ext_files');
			}
		};
		r.onsuccess = e => res(e.target.result);
		r.onerror = e => rej(e.target.error);
	});
}

function guessMime(path) {
	const ext = path.split('.').pop().toLowerCase();
	return { js: 'application/javascript', mjs: 'application/javascript',
		css: 'text/css', html: 'text/html', json: 'application/json',
		png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
		gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
		ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
		ttf: 'font/ttf', eot: 'application/vnd.ms-fontobject' }[ext] || 'application/octet-stream';
}

async function _saveExtFile(db, extId, path, arrayBuffer) {
	return new Promise((res, rej) => {
		const key = `${extId}/${path.replace(/^\//, '')}`;
		const tx = db.transaction('ext_files', 'readwrite');
		tx.objectStore('ext_files').put(arrayBuffer, key);
		tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
	});
}

export async function loadExtFile(extId, path) {
	try {
		const db = await _extDB();
		const key = `${extId}/${path.replace(/^\//, '')}`;
		const buf = await new Promise((res, rej) => {
			const req = db.transaction('ext_files', 'readonly').objectStore('ext_files').get(key);
			req.onsuccess = e => res(e.target.result);
			req.onerror = e => rej(e.target.error);
		});
		db.close();
		return buf || null;
	} catch { return null; }
}

export async function loadExtFileText(extId, path) {
	const buf = await loadExtFile(extId, path);
	if (!buf) return null;
	return new TextDecoder().decode(buf);
}

export async function loadExtFiles(extId) {
	try {
		const db = await _extDB();
		const prefix = extId + '/';
		const keys = await new Promise((res, rej) => {
			const req = db.transaction('ext_files', 'readonly').objectStore('ext_files').getAllKeys();
			req.onsuccess = e => res(e.target.result);
			req.onerror = e => rej(e.target.error);
		});
		const extKeys = keys.filter(k => k.startsWith(prefix));
		const result = {};
		const store = db.transaction('ext_files', 'readonly').objectStore('ext_files');
		await Promise.all(extKeys.map(key => new Promise((res, rej) => {
			const req = store.get(key);
			req.onsuccess = e => {
				const path = key.slice(prefix.length);
				const buf = e.target.result;
				if (buf) {
					const mime = guessMime(path);
					if (mime.startsWith('text/') || mime.includes('javascript') || mime.includes('json') || mime.includes('svg')) {
						result[path] = new TextDecoder().decode(buf);
					} else {
						const bytes = new Uint8Array(buf);
						let b64 = '';
						for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
						result[path] = `data:${mime};base64,${btoa(b64)}`;
					}
				}
				res();
			};
			req.onerror = e => rej(e.target.error);
		})));
		db.close();
		return Object.keys(result).length ? result : null;
	} catch { return null; }
}

function loadExtensions() {
	try { return JSON.parse(localStorage.getItem('dominum-extensions') || '[]'); } catch { return []; }
}

function saveExtensions(exts) {
	const meta = exts.map(e => ({ ...e, files: null }));
	localStorage.setItem('dominum-extensions', JSON.stringify(meta));
}

export async function installExtension(idOrUrl) {
	let crxUrl;
	if (/^[a-z]{32}$/i.test(idOrUrl.trim())) {
		crxUrl = `/api/crx?id=${idOrUrl.trim()}`;
	} else {
		crxUrl = `/api/proxy?url=${encodeURIComponent(idOrUrl)}`;
	}

	const res = await fetch(crxUrl);
	if (!res.ok) throw new Error('Failed to fetch extension');
	const buf = await res.arrayBuffer();

	const JSZip = window.JSZip;
	const zip = new JSZip();

	let offset = 0;
	const view = new DataView(buf);
	if (view.getUint32(0, true) === 0x34327243) {
		const version = view.getUint32(4, true);
		if (version === 2) offset = view.getUint32(8, true);
		else if (version === 3) offset = 12 + view.getUint32(8, true);
	}

	const zipBuf = buf.slice(offset);
	const zipData = await zip.loadAsync(zipBuf);
	const manifest = JSON.parse(await zipData.files['manifest.json'].async('string'));

	const extId = idOrUrl.trim().slice(0, 32) || Math.random().toString(36).slice(2);

	const db = await _extDB();

	const iconSizes = [128, 64, 48, 32, 16];
	const iconMap = manifest.icons || manifest.action?.default_icon || manifest.browser_action?.default_icon || {};
	let iconDataUri = null;
	let messages = null;
	const defaultLocale = manifest.default_locale || '';
	const messagesPath = defaultLocale ? `_locales/${defaultLocale}/messages.json` : '';

	for (const [path, file] of Object.entries(zipData.files)) {
		if (file.dir) continue;
		const arrBuf = await file.async('arraybuffer');
		await _saveExtFile(db, extId, path, arrBuf);

		if (!messages && messagesPath && path.replace(/^\//, '') === messagesPath) {
			try { messages = JSON.parse(new TextDecoder().decode(arrBuf)); } catch { messages = null; }
		}

		if (!iconDataUri) {
			const cleanPath = path.replace(/^\//, '');
			for (const sz of iconSizes) {
				const ip = (iconMap[sz] || iconMap[String(sz)] || '').replace(/^\//, '');
				if (ip && ip === cleanPath) {
					const mime = guessMime(path);
					const bytes = new Uint8Array(arrBuf);
					let b64 = '';
					for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
					iconDataUri = `data:${mime};base64,${btoa(b64)}`;
					break;
				}
			}
		}
	}

	if (!iconDataUri) {
		for (const sz of iconSizes) {
			const p = (iconMap[sz] || iconMap[String(sz)] || '').replace(/^\//, '');
			if (p) {
				const fileBuf = await loadExtFile(extId, p);
				if (fileBuf) {
					const mime = guessMime(p);
					const bytes = new Uint8Array(fileBuf);
					let b64 = '';
					for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
					iconDataUri = `data:${mime};base64,${btoa(b64)}`;
					break;
				}
			}
		}
	}

	db.close();

	const resolveMsg = s => {
		if (typeof s !== 'string') return s;
		return s.replace(/__MSG_(\w+)__/g, (m, key) => messages?.[key]?.message ?? m);
	};

	const ext = {
		id: extId,
		name: resolveMsg(manifest.name) || extId,
		version: manifest.version || '0',
		manifest: { ...manifest, name: resolveMsg(manifest.name), description: resolveMsg(manifest.description) },
		icon: iconDataUri,
		enabled: true,
		files: null,
	};

	const exts = loadExtensions().filter(e => e.id !== extId);
	exts.push(ext);
	saveExtensions(exts);
	return ext;
}

export function uninstallExtension(id) {
	const exts = loadExtensions().filter(e => e.id !== id);
	saveExtensions(exts);
}

export function getExtensions() {
	return loadExtensions();
}

export function setExtensionEnabled(id, enabled) {
	const exts = loadExtensions().map(e => e.id === id ? { ...e, enabled } : e);
	saveExtensions(exts);
	return exts;
}
