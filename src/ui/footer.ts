import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Thread } from "../types.ts";
import { theme } from "./pi/theme/theme.ts";
import { safeText } from "./safe-text.ts";

export class Footer implements Component {
	thread?: Thread;
	stale = false;
	invalidate(): void {}
	render(width: number): string[] {
		const title = safeText(this.thread?.title ?? "New thread")
			.replace(/\s+/g, " ")
			.trim();
		const credits = this.thread?.usage?.totalCredits;
		const usage =
			!this.stale && typeof credits === "number" && Number.isFinite(credits)
				? `${credits.toFixed(2)} credits`
				: "— credits";
		const columns = Math.max(0, Math.floor(width));
		const right = truncateToWidth("Capi", columns, "");
		const available = Math.max(0, columns - visibleWidth(right) - 1);
		const left = truncateToWidth(`${usage} · ${title}`, available, "…");
		const padding = " ".repeat(Math.max(0, columns - visibleWidth(left) - visibleWidth(right)));
		return [theme.fg("dim", left + padding) + theme.fg("accent", right)];
	}
}
