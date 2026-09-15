import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setKittyProtocolActive, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { commandAutocomplete, commands, parseCommand } from "../src/commands.ts";
import { KeybindingsManager } from "../src/keybindings.ts";
import { Footer } from "../src/ui/footer.ts";
import { MaskedInput } from "../src/ui/masked-input.ts";
import { AssistantMessageComponent } from "../src/ui/pi/components/assistant-message.ts";
import { CustomEditor } from "../src/ui/pi/components/custom-editor.ts";
import { UserMessageComponent } from "../src/ui/pi/components/user-message.ts";
import { getEditorTheme, initTheme, theme } from "../src/ui/pi/theme/theme.ts";
import { safeText } from "../src/ui/safe-text.ts";
import { Splash } from "../src/ui/splash.ts";

initTheme("dark");

test("Enter steers, AltEnter queues, ShiftEnter and Ctrl+J only insert newlines across Pi encodings", () => {
	const editor = new CustomEditor({ requestRender() {} } as TUI, getEditorTheme(), new KeybindingsManager());
	const actions: { delivery: string; text: string }[] = [];
	editor.onSubmit = (text) => actions.push({ delivery: "steer", text });
	editor.onQueue = (text) => actions.push({ delivery: "queue", text });
	try {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			for (const key of [
				"\u001b[13;2u",
				"\u001b[57414;2u",
				"\u001b[27;2;13~",
				"\u001b[13;2~",
				"\n",
				"\u001b[106;5u",
				...(kitty ? ["\u001b\r"] : []),
			]) {
				editor.setText("newline\\");
				const before = actions.length;
				editor.handleInput(key);
				assert.equal(editor.getText(), "newline\\\n", JSON.stringify({ kitty, key }));
				assert.equal(actions.length, before);
			}
			for (const key of [
				"\u001b[13;3u",
				"\u001b[57414;3u",
				"\u001b[27;3;13~",
				...(!kitty ? ["\u001b\r"] : []),
			]) {
				editor.setText("queue");
				editor.handleInput(key);
				assert.deepEqual(actions.at(-1), { delivery: "queue", text: "queue" });
				assert.equal(editor.getText(), "");
			}
			for (const key of ["\r", "\u001b[13u", "\u001bOM", "\u001b[57414u"]) {
				editor.setText("steer\\");
				editor.handleInput(key);
				assert.deepEqual(actions.at(-1), { delivery: "steer", text: "steer\\" });
				assert.equal(editor.getText(), "");
			}
		}
	} finally {
		setKittyProtocolActive(false);
	}
});

test("queue submits expanded paste content and honors disabled submission", () => {
	const editor = new CustomEditor({ requestRender() {} } as TUI, getEditorTheme(), new KeybindingsManager());
	let queued = "";
	editor.onQueue = (text) => {
		queued = text;
	};
	const text = "pasted line\n".repeat(30);
	editor.handleInput(`\u001b[200~${text}\u001b[201~`);
	editor.disableSubmit = true;
	editor.handleInput("\u001b[13;3u");
	assert.equal(queued, "");
	editor.disableSubmit = false;
	editor.handleInput("\u001b[13;3u");
	assert.equal(queued, text);
});

test("API key input always renders masked text, including bracketed paste", () => {
	const input = new MaskedInput();
	input.handleInput("\u001b[200~test-not-real-secret\u001b[201~");
	assert.equal(input.getValue(), "test-not-real-secret");
	assert.ok(input.render(80)[0].includes("•"));
	assert.ok(!input.render(80)[0].includes("secret"));
	assert.ok(input.render(5)[0].length <= 5);
});

test("command allowlist rejects removed Pi functionality and local shell", () => {
	for (const name of [
		"model",
		"provider",
		"thinking",
		"bash",
		"skill",
		"extension",
		"compact",
		"tree",
		"fork",
		"clone",
		"import",
		"export",
		"share",
		"attach",
		"reload",
	])
		assert.throws(() => parseCommand(`/${name}`), /Unsupported command/);
	assert.throws(() => parseCommand("!ls"), /Local shell/);
	assert.equal(parseCommand("Please review this"), undefined);
	for (const [name] of commands) assert.equal(parseCommand(`/${name}`)?.name, name);
});

test("autocomplete only completes supported slash commands, never local paths", async () => {
	const options = { signal: new AbortController().signal };
	assert.equal(await commandAutocomplete.getSuggestions(["@src/"], 0, 5, options), null);
	assert.equal(await commandAutocomplete.getSuggestions(["./"], 0, 2, options), null);
	assert.equal(await commandAutocomplete.getSuggestions(["/model"], 0, 6, options), null);
	const suggestions = await commandAutocomplete.getSuggestions(["/res"], 0, 4, options);
	assert.equal(suggestions?.items[0].value, "/resume");
});

test("app bindings expose interrupt and detach only, not Pi model/tool shortcuts", () => {
	const bindings = new KeybindingsManager();
	assert.ok(bindings.matches("\u001b", "app.interrupt"));
	assert.ok(bindings.matches("\u0004", "app.exit"));
	for (const action of ["app.model.cycleForward", "app.tools.expand", "app.clipboard.pasteImage"])
		assert.equal(bindings.matches("\u0010", action), false);
});

test("Pi user background and assistant markdown layout are retained", () => {
	const user = new UserMessageComponent("Hello").render(60);
	const assistant = new AssistantMessageComponent("**World**").render(60);
	assert.ok(user.join("\n").includes("Hello"));
	assert.ok(user.join("\n").includes("48;"));
	assert.ok(assistant.join("\n").includes("World"));
	assert.ok(!assistant.join("\n").includes("48;"));
});

test("footer uses only actual cloud thread credit totals and labels missing usage", () => {
	const footer = new Footer();
	assert.deepEqual(footer.render(40).map(safeText), [`— credits · New thread${" ".repeat(14)}Capi`]);
	footer.thread = {
		id: "t",
		title: "Thread",
		projectId: "p",
		status: "idle",
		usage: { totalCredits: 1.25, llmCredits: 1, imageCredits: 0, vmCredits: 0.25 },
	};
	assert.deepEqual(footer.render(40).map(safeText), [`1.25 credits · Thread${" ".repeat(15)}Capi`]);
	footer.stale = true;
	assert.match(safeText(footer.render(40)[0]), /^— credits · Thread +Capi$/);
	footer.stale = false;
	for (const totalCredits of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
		footer.thread.usage = { totalCredits, llmCredits: 0, imageCredits: 0, vmCredits: 0 };
		assert.match(safeText(footer.render(40)[0]), totalCredits === 0 ? /^0.00 credits/ : /^— credits/);
	}
});

test("footer stays one terminal row at narrow widths and sanitizes cloud titles", () => {
	const footer = new Footer();
	footer.thread = {
		id: "t",
		title: "A\u001b]52;c;evil\u0007\u001b[2J\u001bPprivate\u001b\\\u009b31m\n\t界🙂 title",
		projectId: "p",
		status: "idle",
	};
	assert.match(safeText(footer.render(60)[0]), /^— credits · A 界🙂 title +Capi$/);
	for (let width = 0; width <= 60; width++) {
		const lines = footer.render(width);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= width, `width ${width}`);
		assert.ok(!/[\r\n\t]/.test(lines[0]));
		if (width >= 4) assert.ok(safeText(lines[0]).endsWith("Capi"));
	}
});

test("Capy blue is the default palette and dark/light remain selectable", () => {
	initTheme();
	assert.equal(theme.name, "capy");
	assert.notEqual(theme.fg("accent", "x"), theme.fg("dim", "x"));
	assert.ok(new UserMessageComponent("Blue message").render(60).join("\n").includes("48;"));
	for (const name of ["dark", "light", "capy"] as const) {
		initTheme(name);
		assert.equal(theme.name, name);
		assert.match(safeText(new Footer().render(40)[0]), /Capi$/);
	}
});

test("terminal escape sequences from cloud messages cannot control the terminal", () => {
	assert.equal(safeText("Hello\u001b]52;c;evil\u0007\u001b[2Jworld"), "Helloworld");
	assert.equal(safeText("A\u001b]8;;url\u001b\\link\u001b]8;;\u001b\\B"), "AlinkB");
	assert.equal(safeText("A\u009d52;c;evil\u009cB\u001b]unterminated"), "AB");
});

test("splash centers the logo at normal widths and fits narrow terminals", () => {
	const splash = new Splash(() => 31);
	const normal = splash.render(80).map(safeText);
	assert.ok(normal.some((line) => /[⣿⣴⣀]/u.test(line)));
	assert.equal(normal.length, 31);
	assert.equal(
		normal.findIndex((line) => line.trim()),
		9,
	);
	assert.equal(
		normal.findLastIndex((line) => line.trim()),
		21,
	);
	assert.ok(!normal.some((line) => /capi|cloud agent/i.test(line)));
	const art = normal.filter((line) => line.trim());
	const left = Math.min(...art.map((line) => line.search(/[^ ⠀]/u)));
	const right = 80 - Math.max(...art.map(visibleWidth));
	assert.ok(Math.abs(left - right) <= 1);
	for (const width of [0, 1, 4, 20, 33, 34, 60, 80, 120]) {
		const lines = splash.render(width);
		assert.ok(
			lines.every((line) => visibleWidth(line) <= width),
			`width ${width}`,
		);
		if (width < 34) assert.ok(!lines.some((line) => /[⣿⣴⣀]/u.test(line)));
	}
});

test("runtime dependencies contain Pi TUI, never a Pi agent or provider shim", async () => {
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.dependencies["@earendil-works/pi-tui"], "0.85.1");
	for (const name of Object.keys(pkg.dependencies)) assert.ok(!/pi-(ai|agent|coding-agent)/.test(name));
});
