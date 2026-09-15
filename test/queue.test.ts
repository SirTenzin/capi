import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../src/session.ts";
import { Storage } from "../src/storage.ts";
import { HttpTransport } from "../src/transport.ts";
import type { Delivery, Snapshot } from "../src/types.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class QueueTransport extends HttpTransport {
	value = { id: "thread_test", projectId: "project_test", title: "Test", status: "active" };
	sends: { id: string; delivery: Delivery; text: string }[] = [];
	creates: string[] = [];
	actions: { eventId: string; action: string }[] = [];
	failSend = false;
	failAction = false;
	outcome: "cancelled" | "tooLate" = "cancelled";
	actionGate?: ReturnType<typeof deferred<void>>;
	actionStarted = deferred<void>();
	page = deferred<Snapshot | undefined>();
	constructor() {
		super("unused", async () => {
			throw new Error("Unexpected HTTP request");
		});
	}
	override async thread() {
		return this.value;
	}
	override async create(_project: string, _text: string, id: string) {
		this.creates.push(id);
		return this.value;
	}
	override async send(
		_thread: string,
		text: string,
		id: string,
		_signal?: AbortSignal,
		delivery: Delivery = "steer",
	) {
		this.sends.push({ id, delivery, text });
		if (this.failSend) throw new Error("Network unavailable");
		return { id: "01ABCDEFGHIJKLMNOPQRSTUVWX", deduped: this.sends.length > 1 };
	}
	override async cancel(_thread: string, eventId: string) {
		this.actions.push({ eventId, action: "cancel" });
		this.actionStarted.resolve();
		await this.actionGate?.promise;
		if (this.failAction) throw new Error("Network unavailable");
		return { outcome: this.outcome };
	}
	override async sendNow(_thread: string, eventId: string) {
		this.actions.push({ eventId, action: "send-now" });
		if (this.failAction) throw new Error("Network unavailable");
		return { outcome: "sent" as const, id: "01ZYXWVUTSRQPONMLKJIHGFEDC" };
	}
	override async *watch(
		_id: string,
		_initial: Snapshot | undefined,
		signal: AbortSignal,
	): AsyncGenerator<Snapshot> {
		while (!signal.aborted) {
			const page = this.page;
			const abort = () => page.resolve(undefined);
			signal.addEventListener("abort", abort, { once: true });
			try {
				const snapshot = await page.promise;
				if (this.page === page) this.page = deferred();
				if (snapshot && !signal.aborted) yield snapshot;
			} finally {
				signal.removeEventListener("abort", abort);
			}
		}
	}
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "capi-queue-"));
	const storage = new Storage(root);
	const transport = new QueueTransport();
	const session = new Session(transport, storage);
	session.newThread({ id: "project_test", name: "Test" });
	await session.resume("thread_test");
	return {
		root,
		storage,
		transport,
		session,
		async close() {
			session.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("queue delivery survives restart; recovery reuses clientKey and rejects a different mode", async () => {
	const f = await fixture();
	let restarted: Session | undefined;
	try {
		f.transport.failSend = true;
		await assert.rejects(f.session.send("Queued work", "queue"), /Network unavailable/);
		await assert.rejects(f.session.send("Queued work", "steer"), /delivery mode/);
		assert.equal(f.transport.sends.length, 1);
		f.session.close();
		restarted = new Session(f.transport, f.storage);
		restarted.newThread({ id: "project_test", name: "Test" });
		f.transport.failSend = false;
		await restarted.recover();
		assert.deepEqual(f.transport.sends[1], f.transport.sends[0]);
		const tracked = await restarted.tracked();
		assert.equal(tracked.outbox, null);
		assert.equal(tracked.messages[0].delivery, "queue");
		assert.equal(tracked.messages[0].eventId, "01ABCDEFGHIJKLMNOPQRSTUVWX");
		restarted.close();
		restarted = new Session(f.transport, f.storage);
		assert.deepEqual((await restarted.tracked()).messages, tracked.messages);
	} finally {
		restarted?.close();
		await f.close();
	}
});

test("poll absence never confirms queued or removes receipts; positive clientKey match reconciles", async () => {
	const f = await fixture();
	try {
		await f.session.send("Queued work", "queue");
		const receipt = (await f.session.tracked()).messages[0];
		for (const present of [false, true]) {
			const synced = deferred<void>();
			f.session.onSnapshot = (_snapshot, cached) => {
				if (!cached) synced.resolve();
			};
			f.transport.page.resolve({
				thread: f.transport.value,
				cursor: null,
				messages: present
					? [
							{
								id: "different-transcript-id",
								clientKey: receipt.id,
								source: "user",
								text: "Queued work",
								createdAt: "2026-09-15",
							},
						]
					: [],
			});
			await synced.promise;
			assert.equal((await f.session.tracked()).messages.length, present ? 0 : 1);
		}
	} finally {
		await f.close();
	}
});

test("cancel uses receipt event ID and tooLate does not report cancellation", async () => {
	const f = await fixture();
	try {
		await f.session.send("Queued work", "queue");
		const receipt = (await f.session.tracked()).messages[0];
		f.transport.outcome = "tooLate";
		let status = "";
		f.session.onStatus = (text) => {
			status = text;
		};
		await f.session.act(receipt.id, "cancel");
		assert.deepEqual(f.transport.actions, [{ eventId: receipt.eventId, action: "cancel" }]);
		assert.match(status, /not confirmed/);
		assert.equal((await f.session.tracked()).messages.length, 0);
		await assert.rejects(f.session.act(receipt.id, "send-now"), /no longer locally pending/);
	} finally {
		await f.close();
	}
});

test("uncertain action persists across restart and cannot switch from cancel to send-now", async () => {
	const f = await fixture();
	let restarted: Session | undefined;
	try {
		await f.session.send("Queued work", "queue");
		const receipt = (await f.session.tracked()).messages[0];
		f.transport.failAction = true;
		await assert.rejects(f.session.act(receipt.id, "cancel"), /Network unavailable/);
		f.session.close();
		restarted = new Session(f.transport, f.storage);
		restarted.newThread({ id: "project_test", name: "Test" });
		assert.equal((await restarted.tracked()).messages[0].action, "cancel");
		await assert.rejects(restarted.act(receipt.id, "send-now"), /Retry that action first/);
		assert.equal(f.transport.actions.length, 1);
		f.transport.failAction = false;
		await restarted.act(receipt.id, "cancel");
		assert.equal((await restarted.tracked()).messages.length, 0);
	} finally {
		restarted?.close();
		await f.close();
	}
});

test("poll synchronization cannot resurrect a receipt while cancellation is in flight", async () => {
	const f = await fixture();
	try {
		await f.session.send("Queued work", "queue");
		const receipt = (await f.session.tracked()).messages[0];
		f.transport.actionGate = deferred();
		const action = f.session.act(receipt.id, "cancel");
		await f.transport.actionStarted.promise;
		const synced = deferred<void>();
		f.session.onSnapshot = (_snapshot, cached) => {
			if (!cached) synced.resolve();
		};
		f.transport.page.resolve({ thread: f.transport.value, cursor: null, messages: [] });
		assert.equal((await f.session.tracked()).messages[0].action, "cancel");
		f.transport.actionGate.resolve();
		await action;
		await synced.promise;
		assert.equal((await f.session.tracked()).messages.length, 0);
	} finally {
		await f.close();
	}
});

test("send-now uses receipt event ID, retains uncertainty on network failure, and never resends text", async () => {
	const f = await fixture();
	try {
		await f.session.send("Queued work", "queue");
		const receipt = (await f.session.tracked()).messages[0];
		f.transport.failAction = true;
		await assert.rejects(f.session.act(receipt.id, "send-now"), /Network unavailable/);
		assert.equal((await f.session.tracked()).messages[0].action, "send-now");
		f.transport.failAction = false;
		await f.session.act(receipt.id, "send-now");
		assert.deepEqual(f.transport.actions, Array(2).fill({ eventId: receipt.eventId, action: "send-now" }));
		assert.equal(f.transport.sends.length, 1);
		assert.equal((await f.session.tracked()).messages.length, 0);
	} finally {
		await f.close();
	}
});

test("concurrent submit is rejected instead of duplicating a send", async () => {
	const f = await fixture();
	try {
		const send = f.session.send("Once", "queue");
		await assert.rejects(f.session.send("Once", "queue"), /already in progress/);
		await send;
		assert.equal(f.transport.sends.length, 1);
	} finally {
		await f.close();
	}
});

test("accepted receipt survives failure to clear outbox and recovery does not send again", async () => {
	const f = await fixture();
	try {
		const write = f.storage.write.bind(f.storage);
		let fail = true;
		f.storage.write = async (name, value) => {
			if (name === "outbox.json" && value === null && fail) {
				fail = false;
				throw new Error("Disk unavailable");
			}
			await write(name, value);
		};
		await assert.rejects(f.session.send("Once", "queue"), /Disk unavailable/);
		const receipt = (await f.session.tracked()).messages[0];
		await assert.rejects(f.session.act(receipt.id, "cancel"), /Recover this send/);
		await f.session.recover();
		assert.equal(f.transport.sends.length, 1);
		assert.equal((await f.session.tracked()).outbox, null);
	} finally {
		await f.close();
	}
});

test("creation cache failure keeps original context and requestId for recovery", async () => {
	const f = await fixture();
	try {
		f.session.newThread();
		const cache = f.storage.cache.bind(f.storage);
		let fail = true;
		f.storage.cache = async (snapshot) => {
			if (fail) {
				fail = false;
				throw new Error("Disk unavailable");
			}
			await cache(snapshot);
		};
		await assert.rejects(f.session.send("Create once", "queue"), /Disk unavailable/);
		assert.equal(Boolean(f.session.snapshot), false);
		await f.session.recover();
		assert.equal(f.transport.creates.length, 2);
		assert.equal(f.transport.creates[0], f.transport.creates[1]);
		assert.equal(f.session.snapshot?.thread.id, "thread_test");
		assert.equal(f.transport.sends.length, 0);
	} finally {
		await f.close();
	}
});

test("legacy uncertain sends replay the original omitted delivery field", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-legacy-"));
	const storage = new Storage(root);
	const bodies: Record<string, unknown>[] = [];
	const transport = new HttpTransport("test", async (_url, options) => {
		bodies.push(JSON.parse(String(options?.body)));
		return Response.json({ id: "01ABCDEFGHIJKLMNOPQRSTUVWX", deduped: true });
	});
	const session = new Session(transport, storage);
	try {
		session.newThread({ id: "project_test", name: "Test" });
		session.snapshot = {
			thread: { id: "thread_test", projectId: "project_test", title: "Test", status: "idle" },
			messages: [],
			cursor: null,
		};
		await storage.write("outbox.json", {
			projectId: "project_test",
			threadId: "thread_test",
			text: "Old send",
			id: "old-client-key",
		});
		session.onSnapshot = () => session.close();
		await session.send("Old send");
		assert.deepEqual(bodies, [{ text: "Old send", clientKey: "old-client-key" }]);
		assert.equal((await session.tracked()).messages[0].delivery, undefined);
	} finally {
		session.close();
		await rm(root, { recursive: true, force: true });
	}
});
