# Security

Fixwright can change things in a real home, so it is built to fail safe. This is how it protects the house, the people in it and the server.

## What can never happen

- Fixwright never operates locks, garage doors, alarms or other security devices. The check runs on normalized entity ids, so an id written in capital letters cannot slip past it.
- It never switches off a device marked as protected, and it offers a safe alternative instead.
- Nothing changes without an explicit yes. A screen can ask for a change, but only the person answering the host can approve it.

## Repairs

- Every repair starts as a dry run with a confirm token signed with HMAC SHA-256, checked in constant time, valid once and for a short time.
- Each step runs at most once, guarded by a compare and set with a fencing number, so a retried alarm or a repeated request cannot apply it twice.
- Every step is read back from the house and rolled back automatically if the house does not agree.

## Households and data

- Every household lives in its own Durable Object with its own SQLite store. One household can never read another.
- Household tokens are signed by the server, so they cannot be guessed or forged.
- The public demo stores only a simulated house. No accounts, names or personal data are collected.
- Home Assistant linking is off by default. When it is turned on, the hub address must be public HTTPS, private and link local addresses are refused, the access token is encrypted with AES-GCM before it is stored, and upstream error text is never passed back to the caller.

## The server

- All traffic is HTTPS.
- CORS allows exact origins only, and the server checks both the Origin and the Host header, as the MCP specification asks.
- Requests are rate limited per address, JSON-RPC batches are charged per message, and request bodies are capped at 64 KB.
- Pages are served with `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `X-Frame-Options: DENY`, a `Permissions-Policy` that allows only the microphone on the page itself, and `Cross-Origin-Opener-Policy: same-origin`.
- The MCP Apps views run in a sandboxed iframe on a separate origin, with the content security policy the view declares, and talk to the host only through the app bridge.
- Secrets such as the token signing key are Cloudflare secrets and never appear in the repository.

## Reporting a problem

Please report anything that looks like a security issue privately through GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), rather than in a public issue.
