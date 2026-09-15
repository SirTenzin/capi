import type { Storage } from "./storage.ts";
import type { CapyTransport } from "./transport.ts";
import type { Project } from "./types.ts";

export async function authenticate(
	transport: CapyTransport,
	storage: Storage,
	enteredKey?: string,
): Promise<Project[]> {
	const projects = await transport.projects();
	if (enteredKey) await storage.saveKey(enteredKey);
	return projects;
}
