import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const login = document.querySelector("#login");
const status = document.querySelector("#status");
const logout = document.querySelector("#logout");
let socket;
let terminal;
function connect() {
	login.hidden = true;
	logout.hidden = false;
	status.textContent = "Connecting…";
	terminal = new Terminal({
		cursorBlink: true,
		scrollback: 2000,
		fontSize: 14,
		theme: { background: "#10151e", foreground: "#e6edf5" },
	});
	const fit = new FitAddon();
	terminal.loadAddon(fit);
	terminal.open(document.querySelector("#terminal"));
	fit.fit();
	socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
	const send = (value) => {
		if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 65536)
			socket.send(JSON.stringify(value));
	};
	const resize = () => {
		fit.fit();
		send({ type: "resize", cols: Math.min(300, terminal.cols), rows: Math.min(100, terminal.rows) });
	};
	window.addEventListener("resize", resize);
	socket.onopen = () => {
		status.textContent = "";
		resize();
		terminal.focus();
	};
	socket.onmessage = (event) =>
		terminal.write(event.data, () =>
			send({ type: "ack", bytes: new TextEncoder().encode(event.data).length }),
		);
	socket.onclose = () => {
		window.removeEventListener("resize", resize);
		status.textContent = "Terminal closed. Log out and sign in again to start a new session.";
	};
	socket.onerror = () => {
		status.textContent = "Connection failed. Log out and sign in again.";
	};
	terminal.onData((data) => send({ type: "input", data }));
}
login.addEventListener("submit", async (event) => {
	event.preventDefault();
	const password = document.querySelector("#password");
	try {
		const response = await fetch("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: password.value }),
		});
		password.value = "";
		if (response.ok) connect();
		else
			status.textContent =
				response.status === 429 ? "Too many attempts. Wait one minute." : "Sign-in failed.";
	} catch {
		password.value = "";
		status.textContent = "Sign-in unavailable.";
	}
});
logout.addEventListener("click", async () => {
	try {
		await fetch("/logout", { method: "POST" });
		socket?.close();
		terminal?.dispose();
		location.replace("/");
	} catch {
		status.textContent = "Logout unavailable. Close this tab to disconnect.";
	}
});
fetch("/session")
	.then((response) => {
		if (response.ok) connect();
	})
	.catch(() => {
		status.textContent = "Preview unavailable.";
	});
