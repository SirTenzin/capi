import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Storage } from "../src/storage.ts";

test("key persistence is private, env takes precedence, logout removes stored auth", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-test-"));
	try {
		const store = new Storage(join(root, ".capi"));
		assert.equal(await store.key({}), undefined);
		await store.saveKey("test-not-a-real-key");
		assert.equal((await stat(store.root)).mode & 0o777, 0o700);
		assert.equal((await stat(join(store.root, "credentials.json"))).mode & 0o777, 0o600);
		assert.equal(await store.key({}), "test-not-a-real-key");
		assert.equal(await store.key({ CAPY_API_KEY: " env-test-key " }), "env-test-key");
		await store.logout();
		assert.equal(await store.key({}), undefined);
		assert.equal(await store.key({ CAPY_API_KEY: "env-test-key" }), "env-test-key");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("credential symlinks are not read and atomic writes never overwrite their targets", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-test-"));
	try {
		const external = join(root, "other.json");
		await writeFile(external, '{"apiKey":"other"}');
		await symlink(external, join(root, "credentials.json"));
		const store = new Storage(root);
		await assert.rejects(store.key({}), /Cannot read Capi credentials/);
		await store.saveKey("replacement");
		assert.equal(await readFile(external, "utf8"), '{"apiKey":"other"}');
		assert.equal(await store.key({}), "replacement");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("invalid credential JSON does not appear in errors", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-test-"));
	try {
		await writeFile(join(root, "credentials.json"), "sensitive-malformed-content");
		await assert.rejects(
			new Storage(root).key({}),
			(error) => error instanceof Error && !error.message.includes("sensitive"),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Capi refuses a state-directory symlink instead of accessing Pi state", async () => {
	const root = await mkdtemp(join(tmpdir(), "capi-isolation-"));
	try {
		const pi = join(root, ".pi");
		await mkdir(pi);
		await writeFile(join(pi, "settings.json"), '{"piOnly":true}');
		await symlink(pi, join(root, ".capi"));
		const store = new Storage(join(root, ".capi"));
		await assert.rejects(store.read("settings.json"), /must not be symbolic links/);
		await assert.rejects(store.saveKey("test-key"), /must not be symbolic links/);
		await assert.rejects(store.logout(), /must not be symbolic links/);
		assert.equal(await readFile(join(pi, "settings.json"), "utf8"), '{"piOnly":true}');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
