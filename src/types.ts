export interface Project {
	id: string;
	name: string;
}

export interface Thread {
	id: string;
	projectId: string | null;
	title: string | null;
	status: string;
	usage?: {
		totalCredits: number | string;
		llmCredits: number | string;
		vmCredits: number | string;
		imageCredits: number | string;
	};
}

export interface Message {
	id: string;
	source: "user" | "assistant" | "tool";
	text: string;
	createdAt: string;
	tool?: string;
	calls?: { tool: string; durationMs: number | string }[];
}

export interface Page<T> {
	items: T[];
	cursor: string | null;
}

export interface Snapshot {
	thread: Thread;
	messages: Message[];
	cursor: string | null;
}
