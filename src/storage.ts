import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "./types.ts";

export interface Settings {
	projectId?: string;
	theme?: "capy" | "dark" | "light";
}

export class Storage {
	constructor(readonly root = join(homedir(), ".capi")) {}

	private async verifyDirectory(path: string): Promise<void> {
		try {
			const info = await lstat(path);
			if (!info.isDirectory() || info.isSymbolicLink())
				throw new Error("Capi state directories must not be symbolic links.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}

	private async directory(path: string): Promise<void> {
		await this.verifyDirectory(this.root);
		await this.verifyDirectory(path);
		await mkdir(path, { recursive: true, mode: 0o700 });
		await chmod(path, 0o700);
	}

	async write(name: string, value: unknown): Promise<void> {
		await this.directory(this.root);
		const target = join(this.root, name);
		const temporary = `${target}.${randomUUID()}.tmp`;
		const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		try {
			await file.writeFile(JSON.stringify(value));
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await rename(temporary, target);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	async read<T>(name: string): Promise<T | undefined> {
		await this.verifyDirectory(this.root);
		if (name.startsWith("cache/")) await this.verifyDirectory(join(this.root, "cache"));
		try {
			return JSON.parse(await readFile(join(this.root, name), "utf8")) as T;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error(`Cannot read Capi ${name}. Repair or remove it in ~/.capi.`);
		}
	}

	async key(env = process.env): Promise<string | undefined> {
		if (env.CAPY_API_KEY?.trim()) return env.CAPY_API_KEY.trim();
		await this.verifyDirectory(this.root);
		const path = join(this.root, "credentials.json");
		try {
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				await file.chmod(0o600);
				const value = JSON.parse(await file.readFile("utf8")) as { apiKey?: unknown };
				return typeof value.apiKey === "string" ? value.apiKey : undefined;
			} finally {
				await file.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error("Cannot read Capi credentials. Remove ~/.capi/credentials.json and log in again.");
		}
	}

	async saveKey(apiKey: string): Promise<void> {
		await this.write("credentials.json", { apiKey });
	}

	async logout(): Promise<void> {
		await this.verifyDirectory(this.root);
		await rm(join(this.root, "credentials.json"), { force: true });
		await rm(join(this.root, "cache"), { recursive: true, force: true });
	}

	async cache(snapshot: Snapshot): Promise<void> {
		await this.directory(join(this.root, "cache"));
		await this.write(`cache/${encodeURIComponent(snapshot.thread.id)}.json`, snapshot);
	}

	async cached(id: string): Promise<Snapshot | undefined> {
		return this.read<Snapshot>(`cache/${encodeURIComponent(id)}.json`);
	}
}
