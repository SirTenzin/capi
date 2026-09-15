# capi

Capy's cloud agent in Pi's terminal interface. This is a separate executable and runtime, not a Pi provider or an adapter that runs a local agent.

## Run

Requires Node.js 22.19+ and an interactive terminal.

```sh
npm ci
npm run build
node dist/cli.js
```

Optionally run `npm link` to install the `capi` executable. Use `capi --help` for noninteractive help.

Set `CAPY_API_KEY` in your shell or enter it in the masked login dialog. Don't paste a key into the message editor. Capi validates authentication with `GET /api/v1/projects`, then opens the project picker. Entered keys are saved only after successful validation, with mode `0600` inside the private `~/.capi` directory. Environment keys take precedence and are never written to disk. `/login` lets you replace a stored key; if an environment key is configured, change or unset it in the launching shell instead.

Select a project with the arrow keys and Enter. Your **first message creates a cloud thread and starts Capy**, which may consume credits. Follow-up messages send only the new text. Project selection, listing threads, and resuming do not start a new run. Capy owns the conversation and execution state.

## Commands

| Command | Action |
| --- | --- |
| `/new` | Pick a project and detach into a fresh, not-yet-created thread. |
| `/resume [threadId]` | Pick a cloud thread, or resume a known ID in the selected project. |
| `/name [title]` | Rename the attached cloud thread. |
| `/session` | Show cloud thread ID, title, and state. |
| `/copy` | Request terminal clipboard copy of the last assistant message (OSC 52). |
| `/hotkeys` | Show supported keyboard shortcuts. |
| `/settings` | Choose Pi's built-in dark or light display theme. |
| `/login` | Validate an environment key or enter a replacement stored key. |
| `/logout` | Detach, remove the stored key and transcript cache. It cannot unset your shell's environment key. |
| `/interrupt` | Explicitly request interruption of the attached cloud agent. |
| `/quit` | Quit locally. **Capy continues running.** |

Enter sends; Shift+Enter or Ctrl+J inserts a newline. Tab completes supported commands only. The editor retains Pi's editing, history, undo, and multiline-paste behavior. PageUp/PageDown and the mouse scroll the transcript. Home/End jump to its ends. Ctrl+Shift+F searches it. Ctrl+C (without a selection) and Ctrl+D (with an empty editor) detach. Escape cancels pickers, not the cloud agent.

Unsupported Pi commands and shortcuts are removed: model/provider/thinking selection, local shell/tools, filesystem completion, skills/extensions, context loading, compaction, tree/fork/clone, import/export/share, and attachments. Text mentioning files is sent as ordinary text; no local files are read or uploaded.

## State, recovery, and usage

All application state is under `~/.capi`: `credentials.json`, display/project preferences in `settings.json`, thread caches in `cache/`, and a durable send identifier in `outbox.json`. Capi does not read `.pi`, project instructions, working-directory files, provider configuration, or Pi sessions. The installed Pi TUI dependency is presentation-only. Inherited `PI_*` environment overrides are removed inside Capi's process, so Pi debug logging paths and configuration cannot leak into this application.

The HTTP transport polls message pages and thread metadata every two seconds, drains pagination, and deduplicates by cloud message ID. The thread cache is not an alternative history source for the agent. `/resume` checks cloud access before showing cached data and continues from the saved cursor. GET failures retry with bounded exponential backoff; polling reconnects without replaying user messages. API keys and response error bodies are never logged. Cloud control sequences are stripped before display.

Thread creation uses a persistent `requestId`; each later send uses a persistent `clientKey`. Mutating requests are not blindly retried. If delivery is uncertain, retry the **exact same text in the original project/thread** to reuse the ID, including after restarting Capi. The outbox blocks different messages until the uncertain send is resolved. Use `/resume` to inspect cloud state first. Don't remove an uncertain outbox unless you've independently confirmed delivery; doing so discards deduplication protection.

The footer displays the API's `thread.usage.totalCredits`, labeled as a thread total, not local session spend, tokens, or a dollar estimate. Missing usage is shown as unavailable; cached metadata is labeled. Tool entries and call names are read-only cloud activity summaries, not local executable tool blocks. `/quit`, `/new`, logout, and terminal disconnect never interrupt or archive cloud work.

## UI provenance

The fullscreen transcript/fixed-input-dock layout and concrete editor, user/assistant message renderers, selector, borders, palettes, and syntax highlighting are extracted from Pi rather than recreated with generic terminal primitives. The agent/session/provider portions are removed. See [UPSTREAM.md](UPSTREAM.md) and [the retained MIT notice](src/ui/pi/LICENSE) for the exact commit, source paths, and adaptations.

## Development and verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Tests use fake transports and temporary state directories, not paid live agents. They cover private key storage, authentication, masked paste, HTTP failures, new-text-only sends, duplicate pages, persistent request IDs, resume isolation, explicit interruption versus detach, command isolation, and retained UI rendering.

For a finished-UI recording, build first, open a 120×36 terminal, and run `asciinema rec --command 'node dist/cli.js' capi.cast`. Set the environment key before recording to avoid recording secret keystrokes; never record credential entry. A live message starts billable cloud work. The cast is ignored by git.
