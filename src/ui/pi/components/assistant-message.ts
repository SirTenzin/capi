import { Container, Markdown, type MarkdownTheme, Spacer } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private lastText = "";

	constructor(text = "", markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super();
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);
		this.updateContent(text);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateContent(this.lastText);
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.updateContent(this.lastText);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(text: string): void {
		this.lastText = text;
		this.contentContainer.clear();
		if (!text.trim()) return;
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Markdown(text.trim(), this.outputPad, 0, this.markdownTheme));
	}
}
