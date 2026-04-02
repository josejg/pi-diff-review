# pi-diff-review

This is pure slop, see: https://pi.dev/session/#d4ce533cedbd60040f2622dc3db950e2

It is my hope, that someone takes this idea and makes it gud.

Diff review UI for pi, served over HTTP with WebSocket transport. Uses Monaco for code display.

```
pi install git:https://github.com/badlogic/pi-diff-review
```

## What it does

Adds a `/diff-review` command to pi.

The command:

1. gathers reviewable files from the current git repository
2. starts a local HTTP server with a random port and session token
3. prints a URL to open in your browser
4. lets you switch between `git diff`, `last commit`, and `all files` scopes
5. shows a collapsible sidebar with fuzzy file search
6. shows git status markers in the sidebar for changed files and untracked files
7. lazy-loads file contents on demand as you switch files and scopes
8. lets you draft comments on the original side, modified side, or whole file
9. inserts the resulting feedback prompt into the pi editor when you submit

## Requirements

- Node.js 20+
- `pi` installed
- Internet access for the Tailwind and Monaco CDNs used by the review UI

## Local usage

Run `/diff-review` inside pi. The terminal will print a URL like:

```
Open review UI: http://127.0.0.1:54321/?token=abc123...
```

Open that URL in your browser.

## Remote usage with SSH port forwarding

When running pi on a remote server, the review server binds to `127.0.0.1` and is not directly accessible. Use SSH port forwarding:

1. Run `/diff-review` in pi on the remote machine. Note the port number printed.

2. From your local machine, set up the port forward (using the actual port from step 1):

   ```
   ssh -L 8765:127.0.0.1:8765 user@remote
   ```

3. Open the printed URL in your local browser:

   ```
   http://127.0.0.1:8765/?token=...
   ```

The review UI communicates with the host over a WebSocket. File contents are fetched on demand as you navigate.

## Configuration

Optional environment variables:

| Variable | Default | Description |
|---|---|---|
| `PI_DIFF_REVIEW_HOST` | `127.0.0.1` | Bind address for the review server |
| `PI_DIFF_REVIEW_PORT` | `0` (ephemeral) | Fixed port number |
| `PI_DIFF_REVIEW_SESSION_TIMEOUT_MS` | `1800000` (30 min) | Session inactivity timeout |
| `PI_DIFF_REVIEW_PUBLIC_URL` | (auto) | Override the printed URL base (for reverse proxies) |
