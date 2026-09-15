import { Loader, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "./pi/theme/theme.ts";

export class StatusIndicator extends Loader {
	constructor(ui: TUI, message: string) {
		super(
			ui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("muted", text),
			message,
		);
	}
	renderInBorder(width: number): string {
		const line = super.render(width + 2)[1] ?? "";
		return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
	}
	renderSpinnerInBorder(width: number): string {
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}
}
