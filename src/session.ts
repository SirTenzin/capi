import { randomUUID } from "node:crypto";
import type { Storage } from "./storage.ts";
import { ApiError, type CapyTransport, delay } from "./transport.ts";
import type { Project, Snapshot, Thread } from "./types.ts";

interface Outbox {
	projectId: string;
	threadId?: string;
	text: string;
	id: string;
}

export class Session {
	project?: Project;
	snapshot?: Snapshot;
	private polling?: AbortController;
	private generation = 0;
	private closed = false;
	private operation = new AbortController();
	onSnapshot: (snapshot: Snapshot, cached: boolean) => void = () => {};
	onStatus: (text: string) => void = () => {};

	constructor(
		readonly transport: CapyTransport,
		private readonly storage: Storage,
	) {}

	detach(): void {
		this.generation++;
		this.polling?.abort();
		this.polling = undefined;
	}

	close(): void {
		this.closed = true;
		this.detach();
		this.operation.abort();
	}

	newThread(project = this.project): void {
		this.detach();
		this.project = project;
		this.snapshot = undefined;
	}

	async send(text: string): Promise<void> {
		if (!this.project) throw new Error("Select a project first with /new.");
		const threadId = this.snapshot?.thread.id;
		const previous = await this.storage.read<Outbox | null>("outbox.json");
		const sameContext = previous?.projectId === this.project.id && previous?.threadId === threadId;
		if (previous && (!sameContext || previous.text !== text))
			throw new Error(
				"A previous send has uncertain delivery. Retry its exact text in its original project/thread before sending something different. /resume can inspect the cloud thread.",
			);
		const outbox: Outbox = previous ?? { projectId: this.project.id, threadId, text, id: randomUUID() };
		await this.storage.write("outbox.json", outbox);
		if (threadId) {
			await this.transport.send(threadId, text, outbox.id, this.operation.signal);
		} else {
			const thread = await this.transport.create(this.project.id, text, outbox.id, this.operation.signal);
			this.snapshot = { thread, messages: [], cursor: null };
			await this.storage.cache(this.snapshot);
		}
		await this.storage.write("outbox.json", null);
		if (this.closed) return;
		if (this.snapshot) this.onSnapshot(this.snapshot, true);
		this.startPolling();
	}

	async resume(id: string): Promise<void> {
		const thread = await this.transport.thread(id, this.operation.signal);
		if (thread.projectId !== this.project?.id)
			throw new Error("This thread belongs to a different project. Select its project with /new first.");
		this.detach();
		const cached = await this.storage.cached(id);
		this.snapshot = { thread, messages: cached?.messages ?? [], cursor: cached?.cursor ?? null };
		if (this.closed) return;
		this.onSnapshot(this.snapshot, true);
		this.startPolling();
	}

	async rename(title: string): Promise<Thread> {
		if (!this.snapshot) throw new Error("Send a message or /resume a thread first.");
		const thread = await this.transport.rename(this.snapshot.thread.id, title, this.operation.signal);
		this.snapshot = { ...this.snapshot, thread };
		this.onSnapshot(this.snapshot, false);
		return thread;
	}

	async interrupt(): Promise<void> {
		if (!this.snapshot) throw new Error("No cloud thread is attached.");
		await this.transport.interrupt(this.snapshot.thread.id, this.operation.signal);
		this.onStatus("Interrupt requested. Waiting for Capy to confirm its state.");
	}

	private startPolling(): void {
		this.detach();
		if (!this.snapshot) return;
		const controller = new AbortController();
		this.polling = controller;
		const generation = this.generation;
		const id = this.snapshot.thread.id;
		void this.poll(id, controller.signal, generation);
	}

	private async poll(id: string, signal: AbortSignal, generation: number): Promise<void> {
		let retry = 0;
		while (!signal.aborted) {
			try {
				for await (const snapshot of this.transport.watch(id, this.snapshot, signal)) {
					if (signal.aborted || generation !== this.generation) return;
					this.snapshot = snapshot;
					await this.storage.cache(snapshot);
					if (signal.aborted || generation !== this.generation) return;
					this.onSnapshot(snapshot, false);
					retry = 0;
				}
			} catch (error) {
				if (signal.aborted) return;
				if (
					error instanceof ApiError &&
					(error.status === 401 || error.status === 403 || error.status === 404)
				) {
					this.onStatus(error.message);
					return;
				}
				this.onStatus("Connection interrupted • cached transcript • reconnecting…");
				try {
					await delay(Math.min(30000, 2000 * 2 ** retry++), signal);
				} catch {
					return;
				}
			}
		}
	}
}
