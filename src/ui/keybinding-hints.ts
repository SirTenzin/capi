import { theme } from "./pi/theme/theme.ts";

export function rawKeyHint(key: string, label: string): string {
	return theme.fg("dim", key) + theme.fg("muted", ` ${label}`);
}

export function keyHint(key: string, label: string): string {
	return rawKeyHint(key === "tui.select.confirm" ? "enter" : "esc", label);
}
