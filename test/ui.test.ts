import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { commandAutocomplete, commands, parseCommand } from "../src/commands.ts";
import { KeybindingsManager } from "../src/keybindings.ts";
import { Footer } from "../src/ui/footer.ts";
import { MaskedInput } from "../src/ui/masked-input.ts";
import { AssistantMessageComponent } from "../src/ui/pi/components/assistant-message.ts";
import { UserMessageComponent } from "../src/ui/pi/components/user-message.ts";
import { initTheme } from "../src/ui/pi/theme/theme.ts";
import { safeText } from "../src/ui/safe-text.ts";

initTheme("dark");

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
	assert.match(safeText(footer.render(100).join("\n")), /Credits unavailable/);
	footer.thread = {
		id: "t",
		title: "Thread",
		projectId: "p",
		status: "idle",
		usage: { totalCredits: 1.25, llmCredits: 1, imageCredits: 0, vmCredits: 0.25 },
	};
	assert.match(safeText(footer.render(100).join("\n")), /1.25 credits • thread total/);
	assert.ok(!safeText(footer.render(100).join("\n")).includes("tokens"));
});

test("terminal escape sequences from cloud messages cannot control the terminal", () => {
	assert.equal(safeText("Hello\u001b]52;c;evil\u0007\u001b[2Jworld"), "Helloworld");
});

test("runtime dependencies contain Pi TUI, never a Pi agent or provider shim", async () => {
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.dependencies["@earendil-works/pi-tui"], "0.85.1");
	for (const name of Object.keys(pkg.dependencies)) assert.ok(!/pi-(ai|agent|coding-agent)/.test(name));
});
