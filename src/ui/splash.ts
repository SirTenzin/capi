import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./pi/theme/theme.ts";

const logo = [
	"⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀",
	"⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣾⣿⣷⡄",
	"⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣴⣿⣿⣿⣿⣿⣤⣤⣄⣀⣠⣴⣤",
	"⠀⠀⠀⠀⠀⠀⠀⣠⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠃",
	"⠀⠀⠀⠀⢀⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣏",
	"⠀⠀⠀⣠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠋⠉⠉⠉⣻⣿⣿⣿⣿",
	"⠀⠀⣸⣿⠟⠻⣿⣿⣿⣿⣿⣿⣿⣿⣇⣠⣴⣾⣿⣿⣿⣿⣿⣿⣿⡇",
	"⠀⢀⣿⣿⣦⡀⠈⠻⠿⠛⠛⠛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠁",
	"⠀⠸⣿⣿⣿⣿⡆⠀⣠⣤⣤⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠃",
	"⠀⠀⢿⣿⣿⣿⠀⢠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠁",
	"⠀⠀⠈⢿⣿⣧⣀⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠉",
	"⠀⠀⠀⠀⠙⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠋",
	"⠀⠀⠀⠀⠀⠀⠀⠉⠙⠛⠛⠛⠛⠛⠉⠁",
];

export class Splash implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		const center = (text: string) => {
			const clipped = truncateToWidth(text, Math.max(0, width), "");
			return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2))) + clipped;
		};
		const lines = [""];
		if (width >= 34) {
			const inset = " ".repeat(Math.max(0, Math.floor((width - 30) / 2)));
			lines.push(...logo.map((line) => theme.fg("accent", inset + line)), "");
		}
		lines.push(center(theme.bold(theme.fg("accent", "capi"))));
		lines.push(center(theme.fg("muted", "Your cloud agent. At home in the terminal.")), "");
		return lines;
	}
}
