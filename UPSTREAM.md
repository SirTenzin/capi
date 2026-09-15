# Pi source provenance

- Repository: https://github.com/earendil-works/pi
- Pinned commit: `f9bcd351dc3cedf989bc5fc0f8aa012db5737df2`
- Upstream package version: `0.85.1`
- Source fetched: September 15, 2026
- License: MIT; the upstream notice is retained verbatim at `src/ui/pi/LICENSE`.
- Runtime presentation dependency: `@earendil-works/pi-tui@0.85.1`, pinned exactly in the manifest and lockfile. No `pi-ai`, `pi-agent-core`, `pi-coding-agent`, or local provider runtime is installed.

## Extracted files

Paths below are relative to upstream `packages/coding-agent/src/`.

| Upstream | Capi | Adaptation |
| --- | --- | --- |
| `modes/interactive/chat-viewport.ts` | `src/ui/pi/chat-viewport.ts` | Unchanged fullscreen scroll view and fixed input dock. |
| `modes/interactive/components/custom-editor.ts` | `src/ui/pi/components/custom-editor.ts` | Retained concrete Pi editor/border rendering; removed extension and image-paste hooks; Capy-only interrupt/exit bindings. |
| `modes/interactive/components/user-message.ts` | `src/ui/pi/components/user-message.ts` | Retained Box/Markdown, spacing, background, and OSC semantic zones; removed extension markdown transformers. |
| `modes/interactive/components/assistant-message.ts` | `src/ui/pi/components/assistant-message.ts` | Retained assistant text/Markdown layout, spacing, invalidation, and semantic zones; plain cloud text replaces Pi assistant object; removed thinking/tool/provider stop-reason branches. |
| `modes/interactive/components/extension-selector.ts` | `src/ui/pi/components/selector.ts` | Retained selector layout, arrows/colors/navigation/borders; removed extension tool/timeout hooks; bounded visible rows for long cloud lists. Renamed for standalone use. |
| `modes/interactive/components/dynamic-border.ts` | `src/ui/pi/components/dynamic-border.ts` | Retained. |
| `modes/interactive/components/status-indicator.ts` | `src/ui/status-indicator.ts` | Retained loader and in-border rendering; cloud status only, no compaction/retry/branch-summary extension options. |
| `modes/interactive/components/footer.ts` | `src/ui/footer.ts` | Adapted truncation/right-aligned identity into one row: API credits, sanitized thread title, and Capi. Missing or cached usage is a dash; project and thread-total suffix are omitted. |
| `modes/interactive/theme/theme.ts` | `src/ui/pi/theme/theme.ts` | Retained colors, conversion, Theme renderer, Markdown/editor/select/settings themes; removed custom theme loading, extension registration, watchers, thinking/bash controls, and export helpers. Built-in palettes only. |
| `modes/interactive/theme/{dark,light}.json` | `src/ui/pi/theme/` | Unchanged upstream palettes. Unused palette keys are inert data. |
| `modes/interactive/theme/dark.json` | `src/ui/pi/theme/capy.json` | Capi's default Capy blue palette: bright blue accents, navy message/selection backgrounds, and cool text colors. Theme selection retains the original dark/light choices. |
| `utils/{syntax-highlight,html}.ts` and `utils/highlight-js.d.ts` | `src/ui/pi/utils/` | Retained syntax highlighting and declarations. |

The renderer composition in `src/ui/app.ts` also retains the fullscreen search styling and jump-to-latest treatment from upstream `modes/interactive/tui-renderer.ts`. These extracted/adapted files remain covered by Pi's MIT license. Original Capi transport/controller/storage/auth code is separate.

Upstream instruction files, local agent orchestration, session managers, resource/context loaders, tool implementations, shell execution, extensions, and provider integrations were deliberately not copied.

The centered splash in `src/ui/splash.ts` is Capi-specific. Its monochrome logo is sampled into 30-column Unicode Braille from Capy's 64×64 favicon at https://capy.ai/favicon.png, retrieved September 15, 2026; it is not Pi artwork.

## API provenance

Implementation follows the public OpenAPI schema fetched from https://docs.capy.ai/openapi.json on September 15, 2026, with API origin https://api.capy.ai. Capi uses projects, threads, messages, rename, and interrupt endpoints. Polling is contained in `src/transport.ts`, so replacing it with a future stream does not require changing the presentation or loading a Pi agent runtime.
