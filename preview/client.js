import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const login = document.querySelector("#login");
const status = document.querySelector("#status");
const logout = document.querySelector("#logout");
const submit = login.querySelector("button");
const openTab = document.querySelector("#open-tab");
let connection;
let authenticating = true;
let generation = 0;

function dispose() {
	if (!connection) return;
	const old = connection;
	connection = undefined;
	window.removeEventListener("resize", old.resize);
	old.socket.close();
	old.terminal.dispose();
}

function showLogin(message) {
	dispose();
	login.hidden = false;
	status.textContent = message;
}

function connect() {
	if (connection) return;
	login.hidden = true;
	logout.hidden = false;
	openTab.hidden = true;
	status.textContent = "Connecting…";
	const terminal = new Terminal({
		cursorBlink: true,
		scrollback: 2000,
		fontSize: 14,
		theme: { background: "#10151e", foreground: "#e6edf5" },
	});
	const fit = new FitAddon();
	terminal.loadAddon(fit);
	terminal.open(document.querySelector("#terminal"));
	fit.fit();
	const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
	const current = () => connection?.socket === socket;
	const send = (value) => {
		if (current() && socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 65536)
			socket.send(JSON.stringify(value));
	};
	const resize = () => {
		fit.fit();
		terminal.resize(Math.max(2, Math.min(300, terminal.cols)), Math.max(2, Math.min(100, terminal.rows)));
		send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
	};
	connection = { socket, terminal, resize };
	window.addEventListener("resize", resize);
	let opened = false;
	socket.onopen = () => {
		if (!current()) return;
		opened = true;
		status.textContent = "";
		resize();
		terminal.focus();
	};
	socket.onmessage = (event) => {
		if (!current()) return;
		terminal.write(event.data, () =>
			send({ type: "ack", bytes: new TextEncoder().encode(event.data).length }),
		);
	};
	socket.onclose = (event) => {
		if (!current()) return;
		const reasons = {
			4001: "Session expired.",
			4002: "Logged out.",
			4003: "Another sign-in replaced this session.",
			4004: "The terminal process could not start.",
			4005: "Terminal output exceeded the browser buffer limit.",
			4006: "The terminal process exited.",
			4007: "The terminal connection failed.",
			4008: "Terminal input exceeded the traffic limit.",
			4009: "The terminal sent an invalid protocol message.",
		};
		showLogin(
			`${reasons[event.code] ?? (opened ? "The terminal connection was interrupted." : "The terminal connection was rejected or unavailable. Close other preview tabs and check that WebSockets are allowed.")} Sign in to start a new terminal; no logout is needed.`,
		);
		openTab.hidden = opened;
	};
	terminal.onData((data) => send({ type: "input", data }));
}

login.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (authenticating) return;
	authenticating = true;
	submit.disabled = true;
	const attempt = ++generation;
	const password = document.querySelector("#password");
	try {
		const response = await fetch("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: password.value }),
		});
		password.value = "";
		if (attempt !== generation) return;
		if (response.ok) {
			const session = await fetch("/session");
			if (attempt !== generation) return;
			if (session.ok) connect();
			else {
				status.textContent =
					"Sign-in succeeded, but the session cookie is unavailable. Open the preview in its own tab and allow cookies, then sign in there.";
				openTab.hidden = false;
			}
		} else
			status.textContent =
				response.status === 429
					? "Too many attempts across this preview. Wait one minute before signing in again."
					: response.status === 401
						? "Password not accepted. Use the latest preview password."
						: response.status === 403
							? "Browser access was rejected. Open the preview in its own tab."
							: "Sign-in unavailable.";
	} catch {
		password.value = "";
		if (attempt === generation)
			status.textContent = "Sign-in unavailable. Check your connection and try again.";
	} finally {
		authenticating = false;
		submit.disabled = false;
	}
});

logout.addEventListener("click", async () => {
	++generation;
	dispose();
	try {
		const response = await fetch("/logout", { method: "POST" });
		if (!response.ok && response.status !== 401) throw new Error("Logout failed");
		logout.hidden = true;
		showLogin("Signed out.");
	} catch {
		status.textContent = "Logout unavailable. Close this tab to disconnect.";
	}
});

const boot = generation;
fetch("/session")
	.then((response) => {
		if (boot !== generation) return;
		if (response.ok) connect();
		else status.textContent = "Private access only. Terminal input can control the cloud agent.";
	})
	.catch(() => {
		if (boot === generation)
			status.textContent = "Preview unavailable. Check your connection and try signing in.";
	})
	.finally(() => {
		authenticating = false;
		submit.disabled = false;
	});
