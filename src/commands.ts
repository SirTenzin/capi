import type { AutocompleteProvider } from "@earendil-works/pi-tui";

export const commands = [
	["new", "Start a new cloud thread"],
	["resume", "Resume a cloud thread"],
	["name", "Rename the current thread"],
	["session", "Show cloud thread details"],
	["tasks", "List tasks in the attached cloud thread"],
	["copy", "Copy the latest assistant response"],
	["hotkeys", "Show keyboard shortcuts"],
	["quit", "Detach; leave Capy running"],
	["login", "Authenticate with an API key"],
	["logout", "Remove stored credentials and cache"],
	["settings", "Change display theme"],
	["interrupt", "Explicitly interrupt the cloud agent"],
	["queue", "Manage locally tracked sends and recover uncertain delivery"],
] as const;

export function parseCommand(text: string): { name: string; argument: string } | undefined {
	if (text.startsWith("!"))
		throw new Error("Local shell execution is not supported. Send plain text to Capy instead.");
	if (!text.startsWith("/")) return undefined;
	const [name, ...rest] = text.slice(1).split(/\s+/);
	if (!commands.some(([command]) => command === name))
		throw new Error(`Unsupported command /${name}. Use /hotkeys.`);
	return { name, argument: rest.join(" ").trim() };
}

export const commandAutocomplete: AutocompleteProvider = {
	triggerCharacters: ["/"],
	async getSuggestions(lines, cursorLine, cursorCol) {
		const prefix = lines[cursorLine].slice(0, cursorCol);
		if (cursorLine !== 0 || !/^\/\w*$/.test(prefix)) return null;
		const items = commands
			.filter(([name]) => `/${name}`.startsWith(prefix))
			.map(([name, description]) => ({ value: `/${name}`, label: `/${name}`, description }));
		return items.length ? { items, prefix } : null;
	},
	applyCompletion(lines, cursorLine, cursorCol, item) {
		const updated = [...lines];
		updated[cursorLine] = `${item.value} ${lines[cursorLine].slice(cursorCol)}`;
		return { lines: updated, cursorLine, cursorCol: item.value.length + 1 };
	},
};
