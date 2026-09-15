import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { WebSocketServer } from "ws";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const cookieName = "capi_preview";
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Capi private preview</title><link rel="stylesheet" href="/client.css"></head><body><header><strong>Capi private preview</strong><button id="logout" hidden>Log out</button></header><main><form id="login"><label>Preview password<input id="password" type="password" autocomplete="current-password" required maxlength="1024"></label><button>Open terminal</button></form><p id="status" role="status">Private access only. Terminal input can control the cloud agent.</p><div id="terminal"></div></main><script src="/client.js" defer></script></body></html>`;

export function createPreview({
	password,
	origin,
	insecureLocal = false,
	sessionMs = 15 * 60 * 1000,
	spawn = pty.spawn,
	assets = new URL("./dist/", import.meta.url),
}) {
	if (!password || password.length < 16)
		throw new Error("A preview password of at least 16 characters is required.");
	const allowed = new URL(origin);
	if (allowed.origin !== origin || allowed.username || allowed.password)
		throw new Error("Set an exact preview origin.");
	if (insecureLocal) {
		if (allowed.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(allowed.hostname))
			throw new Error("Local testing requires a loopback HTTP origin.");
	} else if (allowed.protocol !== "https:") throw new Error("The preview requires an HTTPS origin.");
	const salt = randomBytes(32);
	const passwordHash = scryptSync(password, salt, 32);
	const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
	let session;
	let attempts = [];
	const cookie = (token, age) =>
		`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${insecureLocal ? "" : "; Secure"}`;
	const revoke = () => {
		if (!session) return;
		const old = session;
		session = undefined;
		clearTimeout(old.timer);
		old.socket?.terminate();
		try {
			old.process?.kill();
		} catch {}
	};
	const authenticated = (req) => {
		if (session && Date.now() >= session.expires) revoke();
		const token = req.headers.cookie
			?.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith(`${cookieName}=`))
			?.slice(cookieName.length + 1);
		if (!session || !token || !/^[a-f0-9]{64}$/.test(token)) return false;
		return timingSafeEqual(Buffer.from(token), Buffer.from(session.token));
	};
	const server = createServer(async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader(
			"Content-Security-Policy",
			`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
		);
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		const reply = (code, text) => {
			res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(text);
		};
		if (req.method === "POST" && ["/login", "/logout"].includes(req.url)) {
			if (req.headers.origin !== origin) return reply(403, "Forbidden");
			if (req.url === "/logout") {
				if (!authenticated(req)) return reply(401, "Unauthorized");
				revoke();
				res.setHeader("Set-Cookie", cookie("", 0));
				return reply(200, "Logged out");
			}
			attempts = attempts.filter((time) => time > Date.now() - 60_000);
			if (attempts.length >= 5) {
				res.setHeader("Retry-After", "60");
				return reply(429, "Try again later");
			}
			attempts.push(Date.now());
			if (req.headers["content-type"] !== "application/json") return reply(415, "JSON required");
			let body = "";
			try {
				for await (const chunk of req) {
					body += chunk;
					if (Buffer.byteLength(body) > 4096) return reply(413, "Request too large");
				}
				const candidate = JSON.parse(body).password;
				if (
					typeof candidate !== "string" ||
					candidate.length > 1024 ||
					!timingSafeEqual(scryptSync(candidate, salt, 32), passwordHash)
				)
					return reply(401, "Unauthorized");
			} catch {
				return reply(400, "Invalid request");
			}
			revoke();
			session = { token: randomBytes(32).toString("hex"), expires: Date.now() + sessionMs, used: false };
			session.timer = setTimeout(revoke, sessionMs);
			session.timer.unref();
			res.setHeader("Set-Cookie", cookie(session.token, Math.ceil(sessionMs / 1000)));
			return reply(200, "Authenticated");
		}
		if (req.method !== "GET") return reply(405, "Method not allowed");
		if (req.url === "/session")
			return reply(authenticated(req) ? 200 : 401, authenticated(req) ? "Authenticated" : "Unauthorized");
		if (req.url === "/terminal" && !authenticated(req)) return reply(401, "Unauthorized");
		if (req.url === "/" || req.url === "/terminal") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			return res.end(page);
		}
		if (["/client.js", "/client.css"].includes(req.url)) {
			try {
				const data = readFileSync(new URL(req.url.slice(1), assets));
				res.writeHead(200, { "Content-Type": req.url.endsWith(".js") ? "text/javascript" : "text/css" });
				return res.end(data);
			} catch {
				return reply(503, "Build preview assets first");
			}
		}
		return reply(404, "Not found");
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	server.maxConnections = 32;
	server.on("upgrade", (req, socket, head) => {
		if (req.url !== "/ws" || req.headers.origin !== origin || !authenticated(req) || session.used) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		session.used = true;
		wss.handleUpgrade(req, socket, head, (ws) => {
			const active = session;
			active.socket = ws;
			try {
				const env = { TERM: "xterm-256color", COLORTERM: "truecolor" };
				for (const name of ["HOME", "PATH", "LANG", "CAPY_API_KEY"])
					if (process.env[name]) env[name] = process.env[name];
				active.process = spawn(process.execPath, ["dist/cli.js"], {
					cwd,
					name: "xterm-256color",
					cols: 100,
					rows: 30,
					env,
				});
			} catch {
				revoke();
				return;
			}
			let bytes = 0;
			let pendingOutput = 0;
			let windowStart = Date.now();
			active.process.onData((data) => {
				if (ws.readyState !== 1) return;
				pendingOutput += Buffer.byteLength(data);
				if (pendingOutput > 1024 * 1024 || ws.bufferedAmount > 1024 * 1024) {
					revoke();
					return;
				}
				ws.send(data);
			});
			active.process.onExit(() => {
				if (session === active) revoke();
			});
			ws.on("error", () => {
				if (session === active) revoke();
			});
			ws.on("close", () => {
				if (session === active) revoke();
			});
			ws.on("message", (data, binary) => {
				if (session !== active) return;
				if (Date.now() - windowStart >= 1000) {
					bytes = 0;
					windowStart = Date.now();
				}
				bytes += data.length;
				if (binary || bytes > 65536) {
					revoke();
					return;
				}
				try {
					const message = JSON.parse(data.toString());
					if (message.type === "input" && typeof message.data === "string")
						active.process.write(message.data);
					else if (
						message.type === "ack" &&
						Number.isInteger(message.bytes) &&
						message.bytes > 0 &&
						message.bytes <= pendingOutput
					)
						pendingOutput -= message.bytes;
					else if (
						message.type === "resize" &&
						Number.isInteger(message.cols) &&
						Number.isInteger(message.rows) &&
						message.cols >= 2 &&
						message.cols <= 300 &&
						message.rows >= 2 &&
						message.rows <= 100
					)
						active.process.resize(message.cols, message.rows);
					else revoke();
				} catch {
					revoke();
				}
			});
		});
	});
	return {
		server,
		close: () => {
			revoke();
			wss.close();
			server.closeAllConnections();
			return new Promise((resolve) => server.close(resolve));
		},
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const insecureLocal = process.env.CAPI_PREVIEW_LOCAL_TEST === "1";
		const app = createPreview({
			password: process.env.CAPI_PREVIEW_PASSWORD,
			origin: process.env.CAPI_PREVIEW_ORIGIN,
			insecureLocal,
		});
		app.server.on("error", () => {
			console.error("Preview could not listen.");
			process.exitCode = 1;
		});
		app.server.listen(4173, insecureLocal ? "127.0.0.1" : "0.0.0.0", () =>
			console.log("Private preview listening on port 4173."),
		);
		for (const signal of ["SIGTERM", "SIGINT"])
			process.once(signal, () => {
				void app.close();
			});
	} catch {
		console.error(
			"Preview configuration invalid: set a strong CAPI_PREVIEW_PASSWORD and exact HTTPS CAPI_PREVIEW_ORIGIN (or explicit loopback CAPI_PREVIEW_LOCAL_TEST=1).",
		);
		process.exitCode = 1;
	}
}
