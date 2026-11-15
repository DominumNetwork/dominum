importScripts("./scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

// Activate immediately and take over already-open tabs so an extension
// popup's bootstrap iframe is guaranteed to be intercepted on first click,
// rather than only after the next full page reload.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// --- Extension engine: serves installed extensions' unpacked files (stored in
// IndexedDB by src/assets/js/ext/extensions.js) under /__ext/<id>/<path>, and
// resolves an extension's own relative fetches once its context is bootstrapped.

const _extClients = new Map();

function _extDB() {
	return new Promise((res, rej) => {
		const r = indexedDB.open("dominum-ext", 1);
		r.onupgradeneeded = (e) => {
			const db = e.target.result;
			if (!db.objectStoreNames.contains("ext_files")) db.createObjectStore("ext_files");
		};
		r.onsuccess = (e) => res(e.target.result);
		r.onerror = (e) => rej(e.target.error);
	});
}

function _guessMime(path) {
	const ext = path.split(".").pop().toLowerCase();
	return (
		{
			js: "application/javascript",
			mjs: "application/javascript",
			css: "text/css",
			html: "text/html",
			json: "application/json",
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			svg: "image/svg+xml",
			webp: "image/webp",
			ico: "image/x-icon",
			woff: "font/woff",
			woff2: "font/woff2",
			ttf: "font/ttf",
			eot: "application/vnd.ms-fontobject",
		}[ext] || "application/octet-stream"
	);
}

async function _serveExtFile(extId, filePath) {
	try {
		filePath = filePath.replace(/^\//, "");
		const db = await _extDB();
		const key = `${extId}/${filePath}`;
		const buf = await new Promise((res, rej) => {
			const req = db.transaction("ext_files", "readonly").objectStore("ext_files").get(key);
			req.onsuccess = (e) => res(e.target.result);
			req.onerror = (e) => rej(e.target.error);
		});
		db.close();
		if (!buf) return null;
		return new Response(buf, {
			status: 200,
			headers: {
				"Content-Type": _guessMime(filePath),
				"Cross-Origin-Resource-Policy": "same-origin",
			},
		});
	} catch {
		return null;
	}
}

function handleExtRequest(event) {
	const url = new URL(event.request.url);
	const parts = url.pathname.slice(7).split("/");
	const extId = parts[0];
	const rest = parts.slice(1).join("/");

	if (rest === "__bootstrap__") {
		const clientId = event.resultingClientId || event.clientId;
		if (clientId) _extClients.set(clientId, extId);
		event.respondWith(
			new Response(
				'<!DOCTYPE html><html><head><meta name="dominum-ext-sw" content="1"></head><body></body></html>',
				{
					status: 200,
					headers: {
						"Content-Type": "text/html",
						"Cross-Origin-Opener-Policy": "same-origin",
					},
				}
			)
		);
		return;
	}

	event.respondWith(
		(async () => {
			const served = await _serveExtFile(extId, rest);
			return served || new Response("Extension file not found: " + rest, { status: 404 });
		})()
	);
}

async function handleRequest(event) {
	await scramjet.loadConfig();
	if (scramjet.route(event)) {
		return scramjet.fetch(event);
	}
	return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	const path = new URL(event.request.url).pathname;

	if (path.startsWith("/__ext/")) {
		handleExtRequest(event);
		return;
	}

	if (event.clientId) {
		const extId = _extClients.get(event.clientId);
		if (extId && !path.startsWith("/api/")) {
			event.respondWith(
				(async () => {
					const served = await _serveExtFile(extId, path);
					return served || handleRequest(event);
				})()
			);
			return;
		}
	}

	event.respondWith(handleRequest(event));
});
