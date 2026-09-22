import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8")
	.split("\n")
	.filter((line) => !line.startsWith("import "))
	.join("\n");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
	const elements = new Map();
	const element = (id) => {
		if (!elements.has(id))
			elements.set(id, {
				hidden: false,
				value: "test-password",
				textContent: "",
				handlers: {},
				addEventListener(type, handler) {
					this.handlers[type] = handler;
				},
				querySelector: element,
			});
		return elements.get(id);
	};
	const requests = [];
	const sockets = [];
	const terminals = [];
	class Socket {
		static OPEN = 1;
		readyState = 1;
		bufferedAmount = 0;
		sent = [];
		constructor() {
			sockets.push(this);
		}
		send(message) {
			this.sent.push(JSON.parse(message));
		}
		close() {
			this.readyState = 3;
		}
	}
	class Terminal {
		cols = 400;
		rows = 1;
		constructor() {
			terminals.push(this);
		}
		loadAddon() {}
		open() {}
		focus() {}
		dispose() {
			this.disposed = true;
		}
		resize(cols, rows) {
			this.cols = cols;
			this.rows = rows;
		}
		onData(fn) {
			this.input = fn;
		}
		write(_data, callback) {
			this.rendered = callback;
		}
	}
	const listeners = new Set();
	runInNewContext(source, {
		document: { querySelector: element },
		window: {
			addEventListener: (_type, fn) => listeners.add(fn),
			removeEventListener: (_type, fn) => listeners.delete(fn),
		},
		location: { protocol: "https:", host: "preview.test" },
		WebSocket: Socket,
		Terminal,
		FitAddon: class {
			fit() {}
		},
		TextEncoder,
		fetch: (path) =>
			new Promise((resolve) =>
				requests.push({ path, resolve: (status) => resolve({ status, ok: status === 200 }) }),
			),
	});
	return {
		element,
		requests,
		sockets,
		terminals,
		listeners,
		submit: () => element("#login").handlers.submit({ preventDefault() {} }),
	};
}

test("boot session lookup serializes login and repeated submits create only one socket", async () => {
	const f = fixture();
	await f.submit();
	assert.equal(f.requests.length, 1);
	f.requests[0].resolve(401);
	await tick();
	const login = f.submit();
	await f.submit();
	assert.equal(f.requests.length, 2);
	f.requests[1].resolve(200);
	await tick();
	assert.equal(f.requests[2].path, "/session");
	f.requests[2].resolve(200);
	await login;
	assert.equal(f.sockets.length, 1);
	assert.equal(f.terminals.length, 1);
});

test("blocked session cookie offers a top-level tab without attempting a websocket", async () => {
	const f = fixture();
	f.requests[0].resolve(401);
	await tick();
	const login = f.submit();
	f.requests[1].resolve(200);
	await tick();
	f.requests[2].resolve(401);
	await login;
	assert.equal(f.sockets.length, 0);
	assert.equal(f.element("#open-tab").hidden, false);
	assert.match(f.element("#status").textContent, /session cookie is unavailable/);
});

test("closed connection is disposed and stale callbacks cannot affect a new terminal", async () => {
	const f = fixture();
	f.requests[0].resolve(200);
	await tick();
	const old = f.sockets[0];
	old.onopen();
	assert.equal(old.sent[0].cols, 300);
	assert.equal(old.sent[0].rows, 2);
	old.onmessage({ data: "hello" });
	old.onclose({ code: 4006 });
	assert.match(f.element("#status").textContent, /process exited/);
	assert.equal(f.element("#login").hidden, false);
	assert.equal(f.terminals[0].disposed, true);
	assert.equal(f.listeners.size, 0);
	const login = f.submit();
	f.requests[1].resolve(200);
	await tick();
	f.requests[2].resolve(200);
	await login;
	f.sockets[1].onopen();
	const sent = f.sockets[1].sent.length;
	f.terminals[0].rendered();
	f.terminals[0].input("stale");
	old.onclose({ code: 4003 });
	assert.equal(f.sockets[1].sent.length, sent);
	assert.equal(f.element("#status").textContent, "");
	assert.equal(f.terminals[1].disposed, undefined);
	assert.equal(f.listeners.size, 1);
});
