import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createPreview } from "../server.js";

const password = "test-only-password-never-deploy";
const origin = "https://preview.example.test";
async function fixture(t, options = {}) {
	const calls = [];
	const child = {
		kills: 0,
		writes: [],
		kill() {
			this.kills++;
		},
		write(value) {
			this.writes.push(value);
		},
		resize() {},
		onData(fn) {
			this.data = fn;
		},
		onExit(fn) {
			this.exit = fn;
		},
	};
	const app = createPreview({
		password,
		origin,
		spawn: (...args) => {
			calls.push(args);
			return child;
		},
		...options,
	});
	app.server.listen(0, "127.0.0.1");
	await once(app.server, "listening");
	t.after(() => app.close());
	const url = `http://127.0.0.1:${app.server.address().port}`;
	const request = (path, opts = {}) => fetch(`${url}${path}`, opts);
	const login = (value = password, from = origin) =>
		request("/login", {
			method: "POST",
			headers: { Origin: from, "Content-Type": "application/json" },
			body: JSON.stringify({ password: value }),
		});
	const connect = (cookie, from = origin, path = "/ws") =>
		new WebSocket(`${url.replace("http", "ws")}${path}`, {
			origin: from,
			headers: cookie ? { Cookie: cookie } : {},
		});
	return { app, calls, child, request, login, connect };
}
async function rejected(ws) {
	const result = await new Promise((resolve, reject) => {
		ws.once("unexpected-response", (_req, response) => {
			response.resume();
			ws.terminate();
			resolve(response.statusCode);
		});
		ws.once("error", () => {});
		ws.once("open", () => {
			ws.terminate();
			reject(new Error("Unexpected authenticated socket"));
		});
	});
	assert.equal(result, 403);
}

test("configuration fails closed and local opt-in is loopback only", () => {
	assert.throws(() => createPreview({ origin }));
	assert.throws(() => createPreview({ password, origin: "http://preview.example.test" }));
	assert.throws(() => createPreview({ password, origin, insecureLocal: true }));
	assert.throws(() => createPreview({ password, origin: `${origin}/` }));
});

test("unauthorized terminal and websocket fail without spawning", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.request("/terminal")).status, 401);
	assert.equal((await f.request("/session")).status, 401);
	assert.equal((await f.request("/?password=secret")).status, 404);
	await rejected(f.connect());
	assert.equal(f.calls.length, 0);
});

test("browser same-origin metadata avoids hostname pinning without allowing cross-site access", async (t) => {
	const f = await fixture(t);
	for (const site of ["cross-site", "same-site", "none"]) {
		const response = await f.request("/login", {
			method: "POST",
			headers: { Origin: origin, "Sec-Fetch-Site": site, "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		});
		assert.equal(response.status, 403);
	}
	const response = await f.request("/login", {
		method: "POST",
		headers: {
			Origin: "https://new-preview.example.test",
			"Sec-Fetch-Site": "same-origin",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ password }),
	});
	assert.equal(response.status, 200);
});

test("origin is exact and ignores forwarded headers; login is globally rate limited", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.login(password, "https://evil.test")).status, 403);
	assert.equal(
		(
			await f.request("/login", {
				method: "POST",
				headers: { "X-Forwarded-Host": "preview.example.test", "X-Forwarded-Proto": "https" },
			})
		).status,
		403,
	);
	for (let i = 0; i < 5; i++) assert.equal((await f.login("wrong")).status, 401);
	assert.equal((await f.login()).status, 429);
});

test("secure sessions launch only fixed CLI once and logout kills local PTY", async (t) => {
	const f = await fixture(t);
	const response = await f.login();
	assert.equal(response.status, 200);
	const cookie = response.headers.get("set-cookie");
	assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=900; Secure/);
	assert.equal((await f.request("/terminal", { headers: { Cookie: cookie } })).status, 200);
	await rejected(f.connect(cookie, "https://evil.test"));
	await rejected(f.connect(cookie, origin, "/ws?command=bash"));
	const ws = f.connect(cookie);
	await once(ws, "open");
	assert.equal(f.calls.length, 1);
	const [command, args, options] = f.calls[0];
	assert.equal(command, process.execPath);
	assert.deepEqual(args, ["dist/cli.js"]);
	assert.equal(options.cwd, new URL("../../", import.meta.url).pathname);
	assert.equal(options.env.CAPI_PREVIEW_PASSWORD, undefined);
	assert.equal(options.env.CAPI_PREVIEW_ORIGIN, undefined);
	await rejected(f.connect(cookie));
	ws.send(JSON.stringify({ type: "input", data: "/quit\r" }));
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(f.child.writes, ["/quit\r"]);
	const closed = once(ws, "close");
	assert.equal(
		(await f.request("/logout", { method: "POST", headers: { Origin: "https://evil.test", Cookie: cookie } }))
			.status,
		403,
	);
	assert.equal(
		(await f.request("/logout", { method: "POST", headers: { Origin: origin, Cookie: cookie } })).status,
		200,
	);
	await closed;
	assert.equal(f.child.kills, 1);
	await rejected(f.connect(cookie));
});

test("expiry terminates PTY and invalidates cookie", async (t) => {
	const f = await fixture(t, { sessionMs: 150 });
	const cookie = (await f.login()).headers.get("set-cookie");
	const ws = f.connect(cookie);
	await once(ws, "open");
	await once(ws, "close");
	assert.equal(f.child.kills, 1);
	assert.equal((await f.request("/session", { headers: { Cookie: cookie } })).status, 401);
});

for (const action of ["disconnect", "exit", "invalid", "oversize", "output", "rotate"]) {
	test(`${action} closes PTY without any shell or reconnect`, async (t) => {
		const f = await fixture(t);
		const cookie = (await f.login()).headers.get("set-cookie");
		const ws = f.connect(cookie);
		await once(ws, "open");
		const closed = new Promise((resolve) => {
			ws.once("close", resolve);
			ws.on("error", () => {});
		});
		if (action === "disconnect") ws.close();
		if (action === "exit") f.child.exit();
		if (action === "invalid") ws.send(JSON.stringify({ type: "spawn", command: "sh" }));
		if (action === "oversize") ws.send("a".repeat(8193));
		if (action === "output") f.child.data("a".repeat(1024 * 1024 + 1));
		if (action === "rotate") assert.equal((await f.login()).status, 200);
		await closed;
		assert.equal(f.child.kills, 1);
		await rejected(f.connect(cookie));
		assert.equal(f.calls.length, 1);
	});
}

test("malformed cookie and failed spawn are safely rejected", async (t) => {
	const f = await fixture(t, {
		spawn: () => {
			throw new Error("private error");
		},
	});
	const cookie = (await f.login()).headers.get("set-cookie");
	assert.equal(
		(await f.request("/session", { headers: { Cookie: `capi_preview=${"é".repeat(64)}` } })).status,
		401,
	);
	const ws = f.connect(cookie);
	ws.on("error", () => {});
	await once(ws, "close");
	assert.equal((await f.request("/session", { headers: { Cookie: cookie } })).status, 401);
});

test("unacknowledged output is bounded across multiple frames", async (t) => {
	const f = await fixture(t);
	const cookie = (await f.login()).headers.get("set-cookie");
	const ws = f.connect(cookie);
	await once(ws, "open");
	const closed = once(ws, "close");
	f.child.data("a".repeat(600_000));
	f.child.data("b".repeat(600_000));
	await closed;
	assert.equal(f.child.kills, 1);
});

test("render acknowledgements release output budget and input floods terminate", async (t) => {
	const f = await fixture(t);
	const cookie = (await f.login()).headers.get("set-cookie");
	const ws = f.connect(cookie);
	await once(ws, "open");
	for (let i = 0; i < 2; i++) {
		const received = once(ws, "message");
		f.child.data("a".repeat(600_000));
		await received;
		ws.send(JSON.stringify({ type: "ack", bytes: 600_000 }));
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	assert.equal(f.child.kills, 0);
	const closed = once(ws, "close");
	for (let i = 0; i < 12; i++) ws.send(JSON.stringify({ type: "input", data: "a".repeat(6000) }));
	await closed;
	assert.equal(f.child.kills, 1);
});

test("local cookie mode is explicit and security headers cover public landing", async (t) => {
	const f = await fixture(t, { origin: "http://127.0.0.1:4173", insecureLocal: true });
	const response = await f.login(password, "http://127.0.0.1:4173");
	assert.equal(response.status, 200);
	assert.doesNotMatch(response.headers.get("set-cookie"), /Secure/);
	const landing = await f.request("/");
	assert.match(landing.headers.get("content-security-policy"), /frame-ancestors 'none'/);
	assert.equal(landing.headers.get("cache-control"), "no-store");
	assert.equal(landing.headers.get("x-content-type-options"), "nosniff");
});
