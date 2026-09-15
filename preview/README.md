# Private browser terminal preview

This optional harness has its own dependencies and build. It is not part of the CLI package. It runs one local `node dist/cli.js` PTY from the repository root, never a shell or an existing tmux session. Browser input cannot change the executable, arguments, environment, or working directory.

## Run

Use Node 22.19+ and a Linux environment capable of building `node-pty` (Python, make, C++ compiler).

```sh
npm ci && npm run build
cd preview
npm ci
npm run build
npm test
npm run lint
npm start
```

Configure these in the server runtime environment, not source, URLs, or shell history:

- `CAPI_PREVIEW_PASSWORD`: required, at least 16 characters; use a randomly generated strong password. No default exists.
- `CAPI_PREVIEW_ORIGIN`: required exact external HTTPS origin, for example `https://your-assigned-preview-host`. No path or trailing slash. This is the fallback allowlist for clients without Fetch Metadata headers. Modern browsers use their own same-origin metadata, so changing the preview hostname does not break login. The server never derives trust from Host or forwarded headers.
- `CAPY_API_KEY`: optional CLI credential, passed only to the local PTY. Otherwise the CLI offers onboarding. The preview password and other server environment variables are not passed to the PTY.
- `CAPI_PREVIEW_LOCAL_TEST=1`: explicit local test mode only. Requires an HTTP localhost or 127.0.0.1 origin, binds only 127.0.0.1, and omits Secure from the cookie. Never use this mode on an exposed preview.

The normal server binds port 4173 on all interfaces for the HTTPS proxy. Only publish through a trusted HTTPS Capy proxy that supports WebSocket upgrades. Do not expose the raw HTTP port to the internet. The proxy URL is routing, not authentication; the application password remains mandatory. Port conflicts fail rather than choosing a different port.

## Boundaries and caveats

The public landing page and local bundled assets contain no terminal data. `/terminal`, session state, and the WebSocket require a session. Login/logout and WebSocket upgrades require the configured exact Origin. Authentication never accepts query credentials. Cookies are HttpOnly, Secure, SameSite=Strict, have no Domain, and expire after 15 minutes. Passwords are compared using salted scrypt and constant-time hash comparison. Five login attempts per minute are allowed globally (including successful attempts); this avoids trusting proxy IP headers, but another visitor can temporarily deny login.

Only one session and one PTY can exist at a time. A new successful login revokes the previous session. A session can create a PTY only once. Disconnect, logout, expiry, process exit, malformed input, or excessive traffic terminates the local PTY and invalidates the session. Refresh requires a new login; no automatic reconnect or shell fallback exists. A closed terminal returns directly to the sign-in form: there is no need to log out first. Boot session lookup and sign-in are serialized, and callbacks belong to one terminal connection so stale sockets cannot update a replacement terminal. The harness sends no cloud interrupt when closing, but an authenticated person can explicitly use the CLI's cloud controls, including `/interrupt`, and can see account/project information. Treat access as access to the configured Capy account. This is a private test tool, not a multi-user sandbox.

Open the preview in its own top-level browser tab. After login, the client verifies that the browser can send the session cookie before attempting a WebSocket; blocked cookies produce a specific message and an open-in-new-tab link rather than a logout loop. Server-initiated closes carry fixed, non-sensitive reason codes for expiry, rotation, process startup/exit, transport, output/input limits, and invalid messages. A rejected WebSocket handshake is reported separately from an established connection dropping. Proxy or network failures may still arrive without a server reason. These diagnostics never include child output, credentials, or exception details.

Terminal output is sensitive and is rendered in the authenticated browser. Do not record credentials or share screenshots containing private conversations. The child inherits HOME and uses the normal `~/.capi` state; use a dedicated OS account/HOME for isolation. Browser scripts, fonts, and styles are local, with a restrictive CSP (inline styles are needed by xterm). The server does not log requests, credentials, or child output. Input frames are limited to 8 KiB and 64 KiB/second; output disconnects above 1 MiB queued or not yet acknowledged by xterm's rendering callback. Slow consumers lose their local terminal rather than accumulating output indefinitely. Sessions are memory-only and restart invalidates them.

Run `npm test` for HTTP/WS authentication, Origin, rate limits, cookies, fixed spawn arguments, session rotation/expiry/logout, oversized traffic, process exit/disconnect, and fail-closed configuration tests. Tests use an injected fake PTY and a test-only password; production always uses node-pty. For a manual browser check, load the configured origin, sign in, inspect onboarding or read-only resume, then log out. Do not send cloud messages as part of a basic smoke test.
