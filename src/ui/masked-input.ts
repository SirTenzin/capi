import { CURSOR_MARKER, Input } from "@earendil-works/pi-tui";

export class MaskedInput extends Input {
	override render(width: number): string[] {
		const count = Math.min(Math.max(0, width - 3), Array.from(this.getValue()).length);
		return [`> ${"•".repeat(count)}${this.focused ? CURSOR_MARKER : ""}`];
	}
}
