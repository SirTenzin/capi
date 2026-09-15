import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, HttpTransport, mergeMessages } from "../src/transport.ts";
import type { Message, Thread } from "../src/types.ts";

const thread: Thread = { id: "thread_test", projectId: "project_test", title: "Test", status: "idle" };
const message = (id: string, text = id): Message => ({
	id,
	source: "assistant",
	text,
	createdAt: "2026-09-15T00:00:00Z",
});

test("projects validates Bearer auth against the project-list envelope", async () => {
	const transport = new HttpTransport("test-key", async (_url, options) => {
		assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer test-key");
		assert.equal(options?.redirect, "error");
		return Response.json({ items: [{ id: "p", name: "Project" }] });
	});
	assert.deepEqual(await transport.projects(), [{ id: "p", name: "Project" }]);
});

test("401 is not retried and response body cannot leak secrets", async () => {
	let calls = 0;
	const transport = new HttpTransport("sensitive-key", async () => {
		calls++;
		return new Response("sensitive-key", { status: 401 });
	});
	await assert.rejects(
		transport.projects(),
		(error) => error instanceof ApiError && error.status === 401 && !error.message.includes("sensitive-key"),
	);
	assert.equal(calls, 1);
});

test("GET retries server failures but never automatically retries writes", async () => {
	let calls = 0;
	const transport = new HttpTransport("test-key", async () =>
		++calls === 1 ? new Response("", { status: 503 }) : Response.json({ items: [] }),
	);
	assert.deepEqual(await transport.projects(), []);
	assert.equal(calls, 2);
	let writes = 0;
	const failed = new HttpTransport("test-key", async () => {
		writes++;
		throw new Error("sensitive network details");
	});
	await assert.rejects(failed.create("project_test", "Hello", "request_test"), /Cannot reach Capy/);
	assert.equal(writes, 1);
});

test("create and follow-up sends contain no local history or provider fields", async () => {
	const bodies: unknown[] = [];
	const transport = new HttpTransport("test-key", async (_url, options) => {
		bodies.push(JSON.parse(options?.body as string));
		return Response.json(thread);
	});
	await transport.create("project_test", "First", "request_test");
	await transport.send(thread.id, "Next only", "client_test");
	assert.deepEqual(bodies, [
		{ projectId: "project_test", message: "First", requestId: "request_test" },
		{ text: "Next only", clientKey: "client_test" },
	]);
});

test("message IDs dedupe and updates replace cached versions", () => {
	assert.deepEqual(mergeMessages([message("b"), message("a")], [message("a", "Updated")]), [
		message("a", "Updated"),
		message("b"),
	]);
});

test("polling drains pagination, tolerates duplicate IDs and repeated cursor, then resumes after cursor", async () => {
	const urls: string[] = [];
	let page = 0;
	const transport = new HttpTransport(
		"test-key",
		async (url) => {
			urls.push(String(url));
			if (!String(url).includes("/messages?")) return Response.json(thread);
			page++;
			if (page === 1) return Response.json({ items: [message("a"), message("b")], cursor: "b" });
			if (page === 2) return Response.json({ items: [message("b")], cursor: "b" });
			return Response.json({ items: [message("c")], cursor: null });
		},
		"https://api.capy.ai",
		1,
	);
	const controller = new AbortController();
	const iterator = transport.watch(thread.id, undefined, controller.signal);
	const first = await iterator.next();
	assert.deepEqual(
		first.value.messages.map((item: Message) => item.id),
		["a", "b"],
	);
	const second = await iterator.next();
	assert.deepEqual(
		second.value.messages.map((item: Message) => item.id),
		["a", "b", "c"],
	);
	assert.ok(urls.filter((url) => url.includes("after=b")).length >= 2);
	controller.abort();
	await iterator.return(undefined);
});

test("cancelled network calls end without retrying or exposing fetch errors", async () => {
	const controller = new AbortController();
	controller.abort();
	const transport = new HttpTransport("test-key", async () => {
		throw new Error("internal secret");
	});
	await assert.rejects(
		transport.projects(controller.signal),
		(error) => error instanceof Error && !error.message.includes("internal secret"),
	);
});

test("API keys cannot be forwarded to arbitrary origins", () => {
	assert.throws(() => new HttpTransport("test-key", fetch, "https://example.org"), /Only the Capy API/);
});
