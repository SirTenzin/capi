import { getKeybindings, type Keybinding, matchesKey } from "@earendil-works/pi-tui";

export type AppKeybinding = "app.interrupt" | "app.exit";
export class KeybindingsManager {
	matches(data: string, action: string): boolean {
		if (action === "app.interrupt") return matchesKey(data, "escape");
		if (action === "app.exit") return matchesKey(data, "ctrl+d");
		return getKeybindings().matches(data, action as Keybinding);
	}
}
