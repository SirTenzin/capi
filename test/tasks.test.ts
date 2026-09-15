import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { commandAutocomplete, parseCommand } from "../src/commands.ts";
import { Session } from "../src/session.ts";
import { Storage } from "../src/storage.ts";
import { HttpTransport } from "../src/transport.ts";
import type { Task, TaskState, Thread } from "../src/types.ts";
import { App } from "../src/ui/app.ts";
import { ModelTasks } from "../src/ui/model-tasks.ts";
import { SelectorComponent } from "../src/ui/pi/components/selector.ts";
import { initTheme } from "../src/ui/pi/theme/theme.ts";

initTheme("dark");
const thread: Thread = {
	id: "root",
	projectId: "p",
	title: "Fixture",
	status: "idle",
	lastModelId: "codex/fixture-model",
};
const task = (id: string, status: Task["status"] = "working"): Task => ({
	id,
	threadId: "root",
	parentId: "parent",
	taskPath: id,
	title: `Fixture ${id}`,
	status,
});

test("tasks drains after pagination, includes descendants and deduplicates IDs", async () => {
	const urls: URL[] = [];
	const transport = new HttpTransport("fixture", async (input, options) => {
		assert.equal(options?.method, "GET");
		urls.push(new URL(String(input)));
		return Response.json(
			urls.length === 1
				? { items: [task("1"), task("1.1")], cursor: "next cursor" }
				: { items: [task("1", "done"), task("1.1.1", "waiting")], cursor: null },
		);
	});
	assert.deepEqual(await transport.tasks("root/id"), [
		task("1", "done"),
		task("1.1"),
		task("1.1.1", "waiting"),
	]);
	assert.equal(urls[0].pathname, "/api/v1/threads/root%2Fid/tasks");
	assert.equal(urls[1].searchParams.get("after"), "next cursor");
	assert.equal(urls[1].searchParams.get("cursor"), null);
});

test("tasks rejects repeated cursors and partial results on errors", async () => {
	const repeated = new HttpTransport("fixture", async () =>
		Response.json({ items: [task("1")], cursor: "same" }),
	);
	await assert.rejects(repeated.tasks("root"), /repeated a task cursor/);
	let calls = 0;
	const partial = new HttpTransport("fixture", async () =>
		++calls === 1
			? Response.json({ items: [task("1")], cursor: "next" })
			: new Response(null, { status: 403 }),
	);
	await assert.rejects(partial.tasks("root"), /does not have access/);
});

test("model/task row uses authoritative model, nonzero status counts, and bounded cell widths", () => {
	const row = new ModelTasks();
	row.thread = thread;
	row.tasks = {
		items: [task("1"), task("1.1", "waiting"), task("2", "idle"), task("3", "done"), task("4", "failed")],
		stale: false,
	};
	const wide = plain(row.render(150)[0]);
	assert.match(wide, /codex\/fixture-model/);
	assert.match(wide, /Tasks 5 · 1 working · 1 waiting · 1 idle · 1 done · 1 failed$/);
	assert.doesNotMatch(wide, /Fixture/);
	row.tasks = { items: [task("1", "done")], stale: true };
	assert.match(plain(row.render(35)[0]), /Tasks 1 \(stale\) · 1 done$/);
	assert.doesNotMatch(plain(row.render(150)[0]), /0 working/);
	for (const model of [null, "", "模型🦫".repeat(40), "bad\u001b[2J\nmodel"]) {
		row.thread = { ...thread, lastModelId: model };
		for (let width = 0; width < 160; width++) assert.ok(visibleWidth(row.render(width)[0]) <= width);
	}
	row.thread = { ...thread, lastModelId: null };
	row.tasks = { stale: true };
	assert.match(plain(row.render(80)[0]), /Model unknown.*Tasks unavailable/);
	assert.doesNotMatch(plain(row.render(80)[0]), /Tasks 0/);
	row.tasks = { items: [], stale: false };
	assert.match(plain(row.render(80)[0]), /Tasks 0$/);
});

test("task failures preserve counts, recover, and never interrupt message polling", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-tasks-"));
	let taskCalls = 0;
	let messageCalls = 0;
	const transport = new HttpTransport(
		"fixture",
		async (input) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/tasks")) {
				taskCalls++;
				return taskCalls === 2
					? new Response(null, { status: 403 })
					: Response.json({ items: [task("1", taskCalls > 2 ? "done" : "working")], cursor: null });
			}
			if (path.endsWith("/messages")) {
				messageCalls++;
				return Response.json({ items: [], cursor: null });
			}
			return Response.json(thread);
		},
		"http://localhost",
		10,
	);
	const session = new Session(transport, new Storage(root));
	session.project = { id: "p", name: "Fixture" };
	const states: TaskState[] = [];
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("task recovery timed out")), 7000);
			session.onTasks = (state) => {
				states.push(state);
				if (state.items?.[0].status === "done") {
					clearTimeout(timer);
					resolve();
				}
			};
			void session.resume("root").catch(reject);
		});
		assert.ok(states.some((state) => state.stale && state.items?.[0].status === "working"));
		assert.ok(messageCalls > 3);
		assert.equal(session.tasks.stale, false);
		session.newThread();
		assert.deepEqual(session.tasks, { stale: false });
	} finally {
		session.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("/tasks opens a prompt-local selector, updates statuses, closes without navigation", async () => {
	assert.equal(parseCommand("/tasks")?.name, "tasks");
	assert.ok(
		(
			await commandAutocomplete.getSuggestions(["/ta"], 0, 3, { signal: new AbortController().signal })
		)?.items.some((item) => item.value === "/tasks"),
	);
	const app = new App() as unknown as {
		command(name: string, argument: string): Promise<void>;
		session: { snapshot: { thread: Thread }; tasks: TaskState };
		editorContainer: Container;
		editor: Container;
		tui: { setFocus(component: unknown): void; requestRender(): void };
		refreshTasksPicker(): void;
	};
	let focus: unknown;
	app.tui = {
		setFocus(component) {
			focus = component;
		},
		requestRender() {},
	};
	app.editor = new Container();
	app.session = { snapshot: { thread }, tasks: { items: [task("1.1", "waiting")], stale: false } };
	const completed = app.command("tasks", "");
	assert.ok(focus instanceof SelectorComponent);
	assert.match(plain(app.editorContainer.render(100).join("\n")), /1.1 · Fixture 1.1 · waiting/);
	app.session.tasks = { items: [task("1.1", "done")], stale: true };
	app.refreshTasksPicker();
	assert.match(plain(app.editorContainer.render(100).join("\n")), /stale.*unavailable/);
	(focus as SelectorComponent).handleInput("\r");
	await completed;
	assert.equal(focus, app.editor);
	assert.equal(app.session.snapshot.thread.id, "root");
	const cancelled = app.command("tasks", "");
	(focus as SelectorComponent).handleInput("\u001b");
	await cancelled;
	assert.equal(focus, app.editor);
});

test("initial task error stays unknown and late task results cannot leak after detach", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-task-detach-"));
	let complete: ((tasks: Task[]) => void) | undefined;
	const transport = new HttpTransport(
		"fixture",
		async (input) =>
			String(input).includes("/messages")
				? Response.json({ items: [], cursor: null })
				: Response.json(thread),
		"http://localhost",
	);
	transport.tasks = async () => {
		throw new Error("unavailable");
	};
	const session = new Session(transport, new Storage(root));
	session.project = { id: "p", name: "Fixture" };
	try {
		await new Promise<void>((resolve, reject) => {
			session.onTasks = (state) => {
				if (state.stale) resolve();
			};
			void session.resume("root").catch(reject);
		});
		assert.deepEqual(session.tasks, { stale: true });
		transport.tasks = () =>
			new Promise((resolve) => {
				complete = resolve;
			});
		await session.resume("root");
		assert.ok(complete);
		session.newThread();
		complete([task("1")]);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(session.tasks, { stale: false });
	} finally {
		session.close();
		await rm(root, { recursive: true, force: true });
	}
});
