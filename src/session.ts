import { randomUUID } from "node:crypto";
import type { Storage } from "./storage.ts";
import { ApiError, type CapyTransport, delay } from "./transport.ts";
import type { Delivery, PendingMessage, Project, Snapshot, Thread } from "./types.ts";

export interface Outbox {
	projectId: string;
	threadId?: string;
	text: string;
	id: string;
	delivery?: Delivery;
}

export class Session {
	project?: Project;
	snapshot?: Snapshot;
	private polling?: AbortController;
	private generation = 0;
	private closed = false;
	private operation = new AbortController();
	private serial: Promise<unknown> = Promise.resolve();
	private sending = false;
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

	private exclusive<T>(work: () => Promise<T>): Promise<T> {
		const next = this.serial.then(work);
		this.serial = next.catch(() => {});
		return next;
	}

	async tracked(): Promise<{ outbox?: Outbox | null; messages: PendingMessage[] }> {
		return {
			outbox: await this.storage.read<Outbox | null>("outbox.json"),
			messages: (await this.storage.read<PendingMessage[]>("pending.json")) ?? [],
		};
	}

	async recover(): Promise<void> {
		const { outbox } = await this.tracked();
		if (!outbox) throw new Error("No uncertain send to recover.");
		if (outbox.projectId !== this.project?.id)
			throw new Error("Select the original project with /new first.");
		if (outbox.threadId) await this.resume(outbox.threadId);
		else this.newThread();
		await this.send(outbox.text, outbox.delivery ?? "steer");
	}

	async act(id: string, action: "cancel" | "send-now"): Promise<void> {
		return this.exclusive(async () => {
			const { messages, outbox } = await this.tracked();
			if (outbox?.id === id) throw new Error("Recover this send in /queue before changing its receipt.");
			const message = messages.find((message) => message.id === id);
			if (!message) throw new Error("This message is no longer locally pending. Refresh /queue.");
			if (message.projectId !== this.project?.id)
				throw new Error("Select the original project with /new first.");
			if (message.action && message.action !== action)
				throw new Error(`The ${message.action} request is uncertain. Retry that action first.`);
			message.action = action;
			await this.storage.write("pending.json", messages);
			const result =
				action === "cancel"
					? await this.transport.cancel(message.threadId, message.eventId, this.operation.signal)
					: await this.transport.sendNow(message.threadId, message.eventId, this.operation.signal);
			await this.storage.write(
				"pending.json",
				messages.filter((item) => item.id !== id),
			);
			this.onStatus(
				result.outcome === "tooLate"
					? "The API reports too late; this receipt is no longer actionable. Delivery or cancellation is not confirmed."
					: result.outcome === "cancelled"
						? "Message cancelled."
						: "Send-now confirmed by Capy.",
			);
		});
	}

	async send(text: string, delivery: Delivery = "steer"): Promise<void> {
		if (this.sending) throw new Error("A send is already in progress.");
		this.sending = true;
		try {
			await this.exclusive(() => this.sendMessage(text, delivery));
		} finally {
			this.sending = false;
		}
	}

	private async sendMessage(text: string, delivery: Delivery): Promise<void> {
		if (this.closed) throw new Error("Session is closed.");
		if (!this.project) throw new Error("Select a project first with /new.");
		const generation = this.generation;
		const threadId = this.snapshot?.thread.id;
		const previous = await this.storage.read<Outbox | null>("outbox.json");
		const sameContext = previous?.projectId === this.project.id && previous?.threadId === threadId;
		if (previous && (!sameContext || previous.text !== text || (previous.delivery ?? "steer") !== delivery))
			throw new Error(
				"A previous send has uncertain delivery. Use /queue to recover it, or retry its exact text and delivery mode in its original project/thread.",
			);
		const outbox: Outbox = previous ?? {
			projectId: this.project.id,
			threadId,
			text,
			delivery,
			id: randomUUID(),
		};
		await this.storage.write("outbox.json", outbox);
		let created: Snapshot | undefined;
		if (threadId) {
			const { messages } = await this.tracked();
			if (!messages.some((message) => message.id === outbox.id)) {
				const receipt = await this.transport.send(
					threadId,
					text,
					outbox.id,
					this.operation.signal,
					outbox.delivery,
				);
				messages.push({ ...outbox, threadId, eventId: receipt.id });
				await this.storage.write("pending.json", messages);
			}
		} else {
			const thread = await this.transport.create(this.project.id, text, outbox.id, this.operation.signal);
			created = { thread, messages: [], cursor: null };
			await this.storage.cache(created);
		}
		await this.storage.write("outbox.json", null);
		if (this.closed || generation !== this.generation) return;
		if (created) this.snapshot = created;
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
		if (!this.snapshot || this.closed) return;
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
					await this.exclusive(async () => {
						if (signal.aborted || generation !== this.generation) return;
						this.snapshot = snapshot;
						await this.storage.cache(snapshot);
						const { messages } = await this.tracked();
						const remaining = messages.filter(
							(pending) =>
								pending.threadId !== id ||
								!snapshot.messages.some(
									(message) =>
										message.source === "user" &&
										(message.id === pending.eventId || message.clientKey === pending.id),
								),
						);
						if (remaining.length !== messages.length) await this.storage.write("pending.json", remaining);
						if (signal.aborted || generation !== this.generation) return;
						this.onSnapshot(snapshot, false);
						retry = 0;
					});
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
