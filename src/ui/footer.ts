import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Project, Thread } from "../types.ts";
import { theme } from "./pi/theme/theme.ts";
import { safeText } from "./safe-text.ts";

export class Footer implements Component {
	project?: Project;
	thread?: Thread;
	stale = false;
	invalidate(): void {}
	render(width: number): string[] {
		const location = `${this.project?.name ?? "No project"} • ${this.thread?.title ?? "New thread"}`.replace(
			/\s+/g,
			" ",
		);
		const credits = this.thread?.usage?.totalCredits;
		let left =
			typeof credits === "number" && Number.isFinite(credits)
				? `${credits.toFixed(2)} credits • thread total${this.stale ? " (cached)" : ""}`
				: "Credits unavailable";
		left = truncateToWidth(left, width, "...");
		const right = "Capy cloud";
		const available = width - visibleWidth(left) - 2;
		const tail = available > 0 ? truncateToWidth(right, available, "") : "";
		const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(tail)));
		return [
			theme.fg("dim", truncateToWidth(safeText(location), width, "...")),
			theme.fg("dim", left + padding + tail),
		];
	}
}
