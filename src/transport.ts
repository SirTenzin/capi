import type { Message, Page, Project, Snapshot, Thread } from "./types.ts";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly retryAfter = 0,
	) {
		super(
			status === 401
				? "API key rejected. Use /login to authenticate."
				: status === 403
					? "This API key does not have access."
					: `Capy API returned HTTP ${status}.`,
		);
	}
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export function mergeMessages(previous: Message[], incoming: Message[]): Message[] {
	const messages = new Map(previous.map((message) => [message.id, message]));
	for (const message of incoming) messages.set(message.id, message);
	return [...messages.values()].sort(
		(a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
}

export interface CapyTransport {
	projects(signal?: AbortSignal): Promise<Project[]>;
	threads(projectId: string, signal?: AbortSignal): Promise<Thread[]>;
	thread(id: string, signal?: AbortSignal): Promise<Thread>;
	create(projectId: string, message: string, requestId: string, signal?: AbortSignal): Promise<Thread>;
	send(id: string, text: string, clientKey: string, signal?: AbortSignal): Promise<void>;
	rename(id: string, title: string, signal?: AbortSignal): Promise<Thread>;
	interrupt(id: string, signal?: AbortSignal): Promise<void>;
	watch(id: string, initial: Snapshot | undefined, signal: AbortSignal): AsyncGenerator<Snapshot>;
}

export class HttpTransport implements CapyTransport {
	constructor(
		private readonly apiKey: string,
		private readonly fetcher: typeof fetch = fetch,
		private readonly base = "https://api.capy.ai",
		private readonly interval = 2000,
	) {
		if (base !== "https://api.capy.ai" && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base))
			throw new Error("Only the Capy API or a loopback test server is allowed.");
	}

	async request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				const response = await this.fetcher(`${this.base}/api/v1${path}`, {
					method,
					redirect: "error",
					headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
				});
				if (!response.ok) {
					const raw = response.headers.get("retry-after");
					const retryAfter = raw
						? Number.isFinite(Number(raw))
							? Number(raw) * 1000
							: Date.parse(raw) - Date.now()
						: 0;
					throw new ApiError(response.status, Math.max(0, retryAfter || 0));
				}
				if (response.status === 204) return undefined as T;
				return (await response.json()) as T;
			} catch (error) {
				if (signal?.aborted) throw signal.reason;
				if (
					method === "GET" &&
					attempt < 2 &&
					(!(error instanceof ApiError) || error.status === 429 || error.status >= 500)
				) {
					await delay(Math.max(500 * 2 ** attempt, error instanceof ApiError ? error.retryAfter : 0), signal);
					continue;
				}
				if (error instanceof ApiError) throw error;
				throw new Error(
					"Cannot reach Capy. Check your connection; delivery may be uncertain. Retry the same text to reuse its request ID.",
				);
			}
		}
	}

	async projects(signal?: AbortSignal): Promise<Project[]> {
		return (await this.request<{ items: Project[] }>("/projects", "GET", undefined, signal)).items;
	}
	async threads(projectId: string, signal?: AbortSignal): Promise<Thread[]> {
		const items: Thread[] = [];
		let cursor: string | null = null;
		const seen = new Set<string>();
		do {
			const query = new URLSearchParams({ projectId, limit: "100" });
			if (cursor) query.set("cursor", cursor);
			const page: Page<Thread> = await this.request(`/threads?${query}`, "GET", undefined, signal);
			items.push(...page.items);
			cursor = page.cursor;
			if (cursor && seen.has(cursor)) throw new Error("Capy repeated a thread cursor.");
			if (cursor) seen.add(cursor);
		} while (cursor);
		return [...new Map(items.map((thread) => [thread.id, thread])).values()];
	}
	thread(id: string, signal?: AbortSignal): Promise<Thread> {
		return this.request(`/threads/${encodeURIComponent(id)}`, "GET", undefined, signal);
	}
	create(projectId: string, message: string, requestId: string, signal?: AbortSignal): Promise<Thread> {
		return this.request("/threads", "POST", { projectId, message, requestId }, signal);
	}
	async send(id: string, text: string, clientKey: string, signal?: AbortSignal): Promise<void> {
		await this.request(`/threads/${encodeURIComponent(id)}/message`, "POST", { text, clientKey }, signal);
	}
	rename(id: string, title: string, signal?: AbortSignal): Promise<Thread> {
		return this.request(`/threads/${encodeURIComponent(id)}`, "PATCH", { title }, signal);
	}
	async interrupt(id: string, signal?: AbortSignal): Promise<void> {
		await this.request(`/threads/${encodeURIComponent(id)}/interrupt`, "POST", {}, signal);
	}

	async *watch(id: string, initial: Snapshot | undefined, signal: AbortSignal): AsyncGenerator<Snapshot> {
		let messages = initial?.messages ?? [];
		let cursor = initial?.cursor ?? null;
		while (!signal.aborted) {
			let more = true;
			const seen = new Set<string>();
			while (more) {
				const query = new URLSearchParams({ limit: "100" });
				if (cursor) query.set("after", cursor);
				const page = await this.request<Page<Message>>(
					`/threads/${encodeURIComponent(id)}/messages?${query}`,
					"GET",
					undefined,
					signal,
				);
				messages = mergeMessages(messages, page.items);
				more = page.cursor !== null && page.cursor !== cursor && !seen.has(page.cursor);
				if (page.cursor) {
					seen.add(page.cursor);
					cursor = page.cursor;
				}
			}
			const thread = await this.thread(id, signal);
			yield { thread, messages, cursor };
			await delay(this.interval, signal);
		}
	}
}
