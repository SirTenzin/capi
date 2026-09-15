import {
	type Component,
	Container,
	Input,
	matchesKey,
	type OverlayHandle,
	ProcessTerminal,
	Text,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import { authenticate } from "../auth.ts";
import { commandAutocomplete, parseCommand } from "../commands.ts";
import { KeybindingsManager } from "../keybindings.ts";
import { Session } from "../session.ts";
import { type Settings, Storage } from "../storage.ts";
import { HttpTransport } from "../transport.ts";
import type { Delivery, Project, Snapshot } from "../types.ts";
import { Footer } from "./footer.ts";
import { MaskedInput } from "./masked-input.ts";
import { createChatViewport } from "./pi/chat-viewport.ts";
import { AssistantMessageComponent } from "./pi/components/assistant-message.ts";
import { CustomEditor } from "./pi/components/custom-editor.ts";
import { DynamicBorder } from "./pi/components/dynamic-border.ts";
import { SelectorComponent } from "./pi/components/selector.ts";
import { UserMessageComponent } from "./pi/components/user-message.ts";
import { getEditorTheme, initTheme, theme } from "./pi/theme/theme.ts";
import { safeText } from "./safe-text.ts";
import { Splash } from "./splash.ts";
import { StatusIndicator } from "./status-indicator.ts";

export class App {
	private readonly storage = new Storage();
	private settings: Settings = {};
	private tui!: TuiAltScreen;
	private editor!: CustomEditor;
	private readonly document = new Container();
	private readonly notices = new Text("", 1, 0);
	private readonly pending = new Text("", 1, 0);
	private readonly footer = new Footer();
	private session?: Session;
	private indicator?: StatusIndicator;
	private projects: Project[] = [];
	private busy = false;
	private ended = false;
	private overlay?: OverlayHandle;
	private cancelOverlay?: () => void;
	private transcriptKey = "";

	async start(): Promise<void> {
		for (const name of Object.keys(process.env)) {
			if (name.startsWith("PI_")) delete process.env[name];
		}
		this.settings = (await this.storage.read<Settings>("settings.json")) ?? {};
		initTheme(
			this.settings.theme === "light" || this.settings.theme === "dark" ? this.settings.theme : "capy",
		);
		this.tui = new TuiAltScreen(new ProcessTerminal(), true, `${this.storage.root}/logs`, {
			searchMatchStyle: (text) =>
				theme.underline(theme.bg("searchMatchBg", theme.fg("searchMatchText", text))),
			searchCurrentMatchStyle: (text) =>
				theme.bold(theme.inverse(theme.bg("searchMatchBg", theme.fg("searchMatchText", text)))),
			scrollToEndIndicator: () =>
				theme.bg("selectedBg", theme.fg("text", " ↓ Jump to latest message · end ")),
			copySelection: async (text) => {
				this.copy(text);
				return true;
			},
		});
		this.editor = new CustomEditor(this.tui, getEditorTheme(), new KeybindingsManager(), {
			embedWorkingStatus: true,
		});
		this.editor.setAutocompleteProvider(commandAutocomplete);
		this.editor.onCtrlD = () => this.quit();
		this.editor.onSubmit = (text) => {
			void this.submit(text);
		};
		this.editor.onQueue = (text) => {
			void this.submit(text, "queue");
		};
		const viewport = createChatViewport({
			document: this.document,
			pendingMessages: this.pending,
			status: this.notices,
			editor: this.editor,
			footer: this.footer,
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		});
		this.tui.setLayoutRoot(viewport.root);
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c") && !this.overlay && !this.tui.hasActiveSelection()) {
				this.quit();
				return { consume: true };
			}
			return undefined;
		});
		process.once("SIGTERM", () => this.quit());
		process.once("SIGHUP", () => this.quit());
		this.welcome();
		this.tui.start();
		this.busy = true;
		await this.login();
		this.busy = false;
	}

	quit(): void {
		if (this.ended) return;
		this.ended = true;
		this.cancelOverlay?.();
		this.session?.close();
		this.indicator?.stop();
		this.tui?.stop();
		process.stdin.pause();
	}

	private welcome(): void {
		this.document.clear();
		this.document.addChild(
			new Splash(
				(width) =>
					this.tui.terminal.rows -
					[this.pending, this.notices, this.editor, this.footer].reduce(
						(rows, component) => rows + component.render(width).length,
						0,
					),
			),
		);
		this.transcriptKey = "";
	}

	private notice(text: string): void {
		if (this.ended) return;
		this.notices.setText(theme.fg("muted", safeText(text)));
		this.tui.requestRender();
	}

	private async guarded(action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			if (!this.ended) this.notice(error instanceof Error ? error.message : "Operation failed.");
		}
	}

	private async login(manual = false): Promise<void> {
		this.session?.close();
		this.session = undefined;
		this.stopIndicator();
		this.footer.thread = undefined;
		this.welcome();
		await this.guarded(async () => {
			let key = manual && !process.env.CAPY_API_KEY?.trim() ? undefined : await this.storage.key();
			let entered = false;
			if (!key) {
				key = await this.prompt("Log in to Capy", "API key (masked; stored only after validation)", true);
				entered = true;
			}
			if (!key || this.ended) {
				this.notice("Not logged in. Use /login to continue.");
				return;
			}
			this.notice("Validating API key…");
			const transport = new HttpTransport(key);
			const projects = await authenticate(transport, this.storage, entered ? key : undefined);
			if (this.ended) return;
			key = undefined;
			this.projects = projects;
			this.session = new Session(transport, this.storage);
			this.session.onSnapshot = (snapshot, cached) => this.renderSnapshot(snapshot, cached);
			this.session.onStatus = (text) => {
				this.footer.stale = true;
				this.notice(text);
			};
			if (!projects.length) {
				this.notice("Authenticated, but no projects are accessible. Create a project in Capy, then /login.");
				return;
			}
			this.notice("");
			await this.newThread();
		});
	}

	private async newThread(): Promise<void> {
		if (!this.session) throw new Error("Use /login first.");
		if (!this.projects.length) throw new Error("No accessible projects. Create one in Capy, then /login.");
		const projects = [...this.projects].sort(
			(a, b) => Number(b.id === this.settings.projectId) - Number(a.id === this.settings.projectId),
		);
		const chosen = await this.select(
			"Select project",
			projects.map((project) => ({ label: `${project.name}  ·  ${project.id}`, value: project })),
		);
		if (!chosen || this.ended) return;
		this.session.newThread(chosen);
		this.settings.projectId = chosen.id;
		await this.storage.write("settings.json", this.settings);
		this.footer.thread = undefined;
		this.stopIndicator();
		this.pending.setText("");
		this.welcome();
		this.notice("");
		const tracked = await this.session.tracked();
		if (tracked.outbox) this.notice("An uncertain send is saved. Use /queue to recover it.");
		else if (tracked.messages.length) this.notice("Locally tracked sends are available in /queue.");
	}

	private renderSnapshot(snapshot: Snapshot, cached: boolean): void {
		if (this.ended) return;
		this.footer.thread = snapshot.thread;
		this.footer.stale = cached;
		const key = JSON.stringify(snapshot.messages);
		if (key !== this.transcriptKey) {
			this.transcriptKey = key;
			this.document.clear();
			for (const message of snapshot.messages) {
				if (message.source === "user")
					this.document.addChild(new UserMessageComponent(safeText(message.text)));
				else if (message.source === "assistant")
					this.document.addChild(new AssistantMessageComponent(safeText(message.text)));
				else
					this.document.addChild(
						new Text(
							theme.fg(
								"muted",
								`↳ ${safeText(message.tool ?? "Cloud activity")}${message.text ? ` · ${safeText(message.text).split("\n")[0].slice(0, 180)}` : ""}`,
							),
							1,
							0,
						),
					);
				if (message.calls?.length)
					this.document.addChild(
						new Text(
							theme.fg("dim", `↳ ${message.calls.map((call) => safeText(call.tool)).join(" · ")}`),
							1,
							0,
						),
					);
			}
		}
		this.stopIndicator();
		if (["active", "waiting"].includes(snapshot.thread.status)) {
			this.indicator = new StatusIndicator(this.tui, `Capy ${snapshot.thread.status}`);
			this.editor.setWorkingStatusIndicator(this.indicator);
		}
		this.notice(`${snapshot.thread.status}${cached ? " • syncing…" : ""}`);
	}

	private stopIndicator(): void {
		this.indicator?.stop();
		this.indicator = undefined;
		this.editor?.setWorkingStatusIndicator(undefined);
	}

	private async submit(raw: string, delivery: Delivery = "steer"): Promise<void> {
		const text = raw.trim();
		if (!text || this.ended) return;
		if (text === "/quit") {
			this.quit();
			return;
		}
		if (this.busy) {
			this.editor.setText(raw);
			this.notice("Request in progress…");
			return;
		}
		this.busy = true;
		try {
			const command = parseCommand(text);
			if (command) {
				this.editor.setText("");
				await this.command(command.name, command.argument);
				return;
			}
			if (!this.session) throw new Error("Use /login first.");
			this.editor.addToHistory(text);
			this.pending.setText(theme.fg("muted", "Sending to Capy…"));
			await this.session.send(text, delivery);
		} catch (error) {
			this.pending.setText("");
			if (!this.editor.getText()) this.editor.setText(raw);
			this.notice(error instanceof Error ? error.message : "Operation failed.");
		} finally {
			this.pending.setText("");
			this.busy = false;
		}
		this.tui.requestRender();
	}

	private async command(name: string, argument: string): Promise<void> {
		switch (name) {
			case "queue": {
				if (!this.session) throw new Error("Use /login first.");
				const { outbox, messages } = await this.session.tracked();
				const items = messages.map((message, index) => ({
					label: `${index + 1}. ${message.delivery ?? "legacy default"} · ${message.action ? `${message.action} outcome unknown` : "accepted; queue status unknown"} · ${message.threadId} · ${safeText(message.text).replace(/\s+/g, " ").slice(0, 100)}`,
					value: message.id,
				}));
				if (outbox)
					items.unshift({
						label: `Recover uncertain ${outbox.delivery ?? "legacy default"} send · ${outbox.threadId ?? "new thread"} · ${safeText(outbox.text).replace(/\s+/g, " ").slice(0, 100)}`,
						value: "recover",
					});
				if (!items.length) {
					this.notice("No locally tracked pending sends. This is not the server's queue list.");
					break;
				}
				const id = await this.select("Locally tracked sends", items);
				if (id === "recover") await this.session.recover();
				else if (id) {
					const message = messages.find((message) => message.id === id);
					const actions = [
						{ label: "Send now", value: "send-now" as const },
						{ label: "Cancel message", value: "cancel" as const },
					].filter((action) => !message?.action || action.value === message.action);
					const action = await this.select(
						message?.action ? "Retry uncertain action" : "Message action",
						actions,
					);
					if (action) await this.session.act(id, action);
				}
				break;
			}
			case "login":
				await this.login(true);
				break;
			case "logout":
				this.session?.close();
				this.session = undefined;
				this.stopIndicator();
				await this.storage.logout();
				this.welcome();
				this.footer.thread = undefined;
				this.notice(
					process.env.CAPY_API_KEY
						? "Stored key and cache removed. CAPY_API_KEY is still set in your shell; unset it before restarting to fully log out."
						: "Logged out. Use /login to continue.",
				);
				break;
			case "new":
				await this.newThread();
				break;
			case "resume": {
				if (!this.session?.project) throw new Error("Select a project with /new first.");
				let id = argument;
				if (!id) {
					this.notice("Loading cloud threads…");
					const threads = await this.session.transport.threads(this.session.project.id);
					if (!threads.length) {
						this.notice("No cloud threads yet.");
						return;
					}
					id =
						(await this.select(
							"Resume cloud thread",
							threads.map((thread) => ({
								label: `${thread.title ?? "Untitled"}  ·  ${thread.status}  ·  ${thread.id}`,
								value: thread.id,
							})),
						)) ?? "";
				}
				if (id) await this.session.resume(id);
				break;
			}
			case "name": {
				if (!this.session?.snapshot) throw new Error("No cloud thread is attached.");
				const title = argument || (await this.prompt("Rename thread", "New title"));
				if (title) await this.session.rename(title);
				break;
			}
			case "session": {
				const thread = this.session?.snapshot?.thread;
				this.notice(
					thread
						? `${thread.id} • ${thread.title ?? "Untitled"} • ${thread.status} • Capy owns this thread; local transcript is a cache.`
						: "No cloud thread yet. The first message creates one.",
				);
				break;
			}
			case "copy": {
				const message = this.session?.snapshot?.messages.findLast(
					(message) => message.source === "assistant",
				);
				if (!message) throw new Error("No assistant response to copy.");
				this.copy(message.text);
				this.notice("Clipboard request sent via OSC 52. Your terminal must allow clipboard access.");
				break;
			}
			case "interrupt":
				if (!this.session) throw new Error("No cloud thread is attached.");
				await this.session.interrupt();
				break;
			case "settings": {
				const selected = await this.select("Display settings • theme", [
					{ label: "Capy blue", value: "capy" as const },
					{ label: "Dark", value: "dark" as const },
					{ label: "Light", value: "light" as const },
				]);
				if (!selected) return;
				this.settings.theme = selected;
				await this.storage.write("settings.json", this.settings);
				initTheme(selected);
				this.transcriptKey = "";
				if (this.session?.snapshot) this.renderSnapshot(this.session.snapshot, true);
				else this.welcome();
				this.tui.invalidate();
				this.notice(`Theme: ${selected}`);
				break;
			}
			case "hotkeys":
				await this.select("Keyboard shortcuts", [
					{ label: "Enter steer · Alt+Enter queue · Shift+Enter / Ctrl+J newline", value: "" },
					{ label: "Tab command completion · /queue locally tracked sends", value: "" },
					{ label: "↑↓ editor history · Ctrl+U clear line · Ctrl+W delete word", value: "" },
					{ label: "PageUp/PageDown scroll · Home/End transcript top/bottom", value: "" },
					{ label: "Ctrl+Shift+F search transcript · mouse scroll/select", value: "" },
					{ label: "Ctrl+C / Ctrl+D (empty editor) detach · Esc cancel picker", value: "" },
					{ label: "/interrupt explicitly stops Capy · /quit never stops Capy", value: "" },
				]);
				break;
		}
	}

	private copy(text: string): void {
		process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
	}

	private select<T>(title: string, items: { label: string; value: T }[]): Promise<T | undefined> {
		return new Promise((resolve) => {
			const finish = (value?: T) => {
				this.hideOverlay();
				resolve(value);
			};
			const labels = items.map((item) => safeText(item.label));
			const selector = new SelectorComponent(
				title,
				labels,
				(label) => finish(items[labels.indexOf(label)]?.value),
				() => finish(),
			);
			this.mountOverlay(selector, () => finish());
		});
	}

	private prompt(title: string, label: string, masked = false): Promise<string | undefined> {
		return new Promise((resolve) => {
			const input = masked ? new MaskedInput() : new Input();
			const finish = (value?: string) => {
				input.setValue("");
				this.hideOverlay();
				resolve(value);
			};
			input.onSubmit = (value) => finish(value.trim() || undefined);
			input.onEscape = () => finish();
			const box = new Container() as Container & { handleInput(data: string): void };
			box.addChild(new DynamicBorder());
			box.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 1));
			box.addChild(new Text(theme.fg("muted", label), 1, 0));
			box.addChild(input);
			box.addChild(new Text(theme.fg("dim", "enter confirm • esc cancel"), 1, 1));
			box.addChild(new DynamicBorder());
			box.handleInput = (data) => input.handleInput(data);
			this.mountOverlay(box, () => finish());
			input.focused = true;
		});
	}

	private mountOverlay(component: Component, cancel: () => void): void {
		this.cancelOverlay = cancel;
		this.overlay = this.tui.showOverlay(component, { width: "90%", maxHeight: "85%", anchor: "center" });
		this.tui.requestRender();
	}

	private hideOverlay(): void {
		this.overlay?.hide();
		this.overlay = undefined;
		this.cancelOverlay = undefined;
		if (!this.ended) this.tui.setFocus(this.editor);
	}
}
