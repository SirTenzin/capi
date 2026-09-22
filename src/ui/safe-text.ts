export function safeText(text: string): string {
	return text
		.replace(/(?:\x1b\]|\x9d)[^\x07\x9c]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[ -/]*[0-~]/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
