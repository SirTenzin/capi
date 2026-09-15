import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authenticate } from "../src/auth.ts";
import { Session } from "../src/session.ts";
import { Storage } from "../src/storage.ts";
import { ApiError, type CapyTransport } from "../src/transport.ts";
import type { Snapshot, Thread } from "../src/types.ts";

class FakeTransport implements CapyTransport {
	value: Thread = { id: "thread_test", projectId: "project_test", title: "Test", status: "idle" };
	creates: { projectId: string; text: string; id: string }[] = [];
	sends: { threadId: string; text: string; id: string }[] = [];
	interrupts = 0;
	failAuth = false;
	failCreate = false;
	watchInitial?: Snapshot;
	async projects() {
		if (this.failAuth) throw new ApiError(401);
		return [{ id: "project_test", name: "Test" }];
	}
	async threads() {
		return [this.value];
	}
	async thread() {
		return this.value;
	}
	async create(projectId: string, text: string, id: string) {
		this.creates.push({ projectId, text, id });
		if (this.failCreate) throw new Error("Uncertain delivery");
		return this.value;
	}
	async send(threadId: string, text: string, id: string) {
		this.sends.push({ threadId, text, id });
		return { id: "01ABCDEFGHIJKLMNOPQRSTUVWX", deduped: false };
	}
	async cancel() {
		return { outcome: "cancelled" as const };
	}
	async sendNow() {
		return { outcome: "sent" as const };
	}
	async rename(_id: string, title: string) {
		return { ...this.value, title };
	}
	async interrupt() {
		this.interrupts++;
	}
	async *watch(_id: string, initial: Snapshot | undefined, signal: AbortSignal): AsyncGenerator<Snapshot> {
		this.watchInitial = initial;
		await new Promise<void>((resolve) => {
			if (signal.aborted) resolve();
			else signal.addEventListener("abort", () => resolve(), { once: true });
		});
	}
}

test("onboarding saves only validated keys; environment auth is not persisted", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-auth-"));
	try {
		const storage = new Storage(root);
		const transport = new FakeTransport();
		transport.failAuth = true;
		await assert.rejects(authenticate(transport, storage, "invalid-test-key"), ApiError);
		assert.equal(await storage.key({}), undefined);
		transport.failAuth = false;
		await authenticate(transport, storage);
		assert.equal(await storage.key({}), undefined);
		await authenticate(transport, storage, "valid-test-key");
		assert.equal(await storage.key({}), "valid-test-key");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("first message creates with requestId; subsequent send contains only new text; quit detaches", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-session-"));
	const transport = new FakeTransport();
	const session = new Session(transport, new Storage(root));
	try {
		session.newThread({ id: "project_test", name: "Test" });
		await session.send("First");
		assert.equal(transport.creates.length, 1);
		assert.match(transport.creates[0].id, /^[a-f0-9-]{36}$/);
		await session.send("Second only");
		assert.equal(transport.creates.length, 1);
		assert.equal(transport.sends[0].text, "Second only");
		await session.interrupt();
		assert.equal(transport.interrupts, 1);
		session.close();
		assert.equal(transport.interrupts, 1);
	} finally {
		session.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("uncertain creation reuses durable requestId after restarting and blocks accidental new sends", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-retry-"));
	const transport = new FakeTransport();
	const storage = new Storage(root);
	let session = new Session(transport, storage);
	try {
		session.newThread({ id: "project_test", name: "Test" });
		transport.failCreate = true;
		await assert.rejects(session.send("First"), /Uncertain delivery/);
		await assert.rejects(session.send("Different"), /previous send has uncertain delivery/);
		assert.equal(transport.creates.length, 1);
		session.close();
		session = new Session(transport, storage);
		session.newThread({ id: "project_test", name: "Test" });
		transport.failCreate = false;
		await session.send("First");
		assert.equal(transport.creates[0].id, transport.creates[1].id);
		assert.equal(await storage.read("outbox.json"), null);
	} finally {
		session.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("resume verifies cloud project before presenting cached transcript and continues from cached cursor", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-resume-"));
	const transport = new FakeTransport();
	const storage = new Storage(root);
	const session = new Session(transport, storage);
	try {
		const cached: Snapshot = {
			thread: transport.value,
			messages: [{ id: "message_1", source: "assistant", text: "Cached", createdAt: "2026-09-15" }],
			cursor: "message_1",
		};
		await storage.cache(cached);
		session.newThread({ id: "other", name: "Other" });
		await assert.rejects(session.resume("thread_test"), /different project/);
		assert.equal(Boolean(session.snapshot), false);
		session.newThread({ id: "project_test", name: "Test" });
		await session.resume("thread_test");
		assert.deepEqual(session.snapshot?.messages, cached.messages);
		assert.equal(transport.watchInitial?.cursor, "message_1");
		assert.equal(transport.creates.length, 0);
	} finally {
		session.close();
		await rm(root, { recursive: true, force: true });
	}
});
