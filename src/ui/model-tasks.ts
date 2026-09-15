import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TaskState, Thread } from "../types.ts";
import { theme } from "./pi/theme/theme.ts";
import { safeText } from "./safe-text.ts";

export class ModelTasks implements Component {
	thread?: Thread;
	tasks: TaskState = { stale: false };
	invalidate(): void {}
	render(width: number): string[] {
		const columns = Math.max(0, Math.floor(width));
		const items = this.tasks.items;
		const counts = ["working", "waiting", "idle", "done", "failed"].flatMap((status) => {
			const count = items?.filter((task) => task.status === status).length;
			return count ? [`${count} ${status}`] : [];
		});
		const label = !this.thread
			? "Tasks —"
			: items === undefined
				? `Tasks ${this.tasks.stale ? "unavailable" : "…"}`
				: `Tasks ${items.length}${this.tasks.stale ? " (stale)" : ""}${counts.length ? ` · ${counts.join(" · ")}` : ""}`;
		const right = truncateToWidth(label, columns, "…");
		const available = Math.max(0, columns - visibleWidth(right) - 2);
		const model =
			safeText(this.thread?.lastModelId ?? "")
				.replace(/\s+/g, " ")
				.trim() || "Model unknown";
		const left = truncateToWidth(model, available, "…");
		return [
			theme.fg(
				"dim",
				left + " ".repeat(Math.max(0, columns - visibleWidth(left) - visibleWidth(right))) + right,
			),
		];
	}
}
