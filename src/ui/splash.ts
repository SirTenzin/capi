import { type Component, visibleWidth } from "@earendil-works/pi-tui";
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
	constructor(private readonly height: (width: number) => number = () => logo.length) {}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 34) return [];
		const art = logo.map((line) => line.slice(1));
		const logoWidth = Math.max(...art.map(visibleWidth));
		const inset = " ".repeat(Math.max(0, Math.floor((width - logoWidth) / 2)));
		const height = Math.max(logo.length, Math.floor(this.height(width)));
		const top = Math.floor((height - logo.length) / 2);
		return [
			...Array<string>(top).fill(""),
			...art.map((line) => theme.fg("accent", inset + line)),
			...Array<string>(height - logo.length - top).fill(""),
		];
	}
}
