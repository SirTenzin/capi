#!/usr/bin/env node
import { App } from "./ui/app.ts";

if (process.argv.includes("--help")) {
	console.log(
		"capi — Capy cloud agent in Pi's TUI\n\nUsage: capi\n\nSet CAPY_API_KEY or log in interactively. State lives in ~/.capi.\n/quit detaches; /interrupt explicitly stops the cloud agent.\nNo local tools, shell execution, attachments, or Pi state access.",
	);
} else if (process.argv.length > 2) {
	console.error("Unknown option. Run capi --help.");
	process.exitCode = 1;
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.error("Capi requires an interactive terminal. Run capi --help for usage.");
	process.exitCode = 1;
} else {
	const app = new App();
	void app.start().catch(() => {
		app.quit();
		console.error("Capi could not start. Check ~/.capi configuration and terminal support.");
		process.exitCode = 1;
	});
}
