Context Master

A local Mac app that turns selected coding chats into an editable library of specialists. Other agents can search the library, request a context handoff, or ask a specialist through an installed CLI subscription.

Saved context is historical. Review the linked source messages before acting. Answer mode sends the brief, question, and selected source excerpts to the chosen CLI provider and consumes subscription usage. Context-only mode makes no model call. Credential redaction covers common patterns; review imports before sending them to a provider.

Flow
  Saved chats -> local specialist brief + linked source messages
  Another agent -> MCP search -> specialist -> subscription answer with sources
                                      |-> context-only handoff

Run from source
  Node 22.13+ is required.
  npm ci
  npm run desktop:dev

Browser development
  npm run dev
  Open http://127.0.0.1:3000

Build a Mac app
  npm run desktop:build
  The app appears under release/. The current Apple Silicon build is locally signed and is not notarized. macOS distribution signing and notarization require your own Apple Developer credentials.
  npm run desktop:dist builds DMG and ZIP installers.
  npm run desktop:smoke checks the packaged runtime, library, CLI, and MCP server without model calls.
  npm run desktop:smoke:native verifies the actual Mac renderer, token protection, context handoff, shutdown, forced-crash cleanup, and immutable bundle resources.

Use the app
  Import opens native discovery. Select only the chats you want to keep, or choose transcript files.
  Create a specialist, inspect the extracted brief, choose its answering CLI, and save it.
  Ask runs a fresh isolated CLI process. Handoff returns the bounded brief and evidence packet without a model call.
  Sources links to exact imported messages. Brief shows the saved context and provenance; Edit brief keeps revision history. Archive can be reversed.
  Connections provides the MCP configuration for another agent.

Import support
  Codex: local JSONL chats and state-database titles.
  Claude Code: project JSONL chats and session-index titles.
  OpenCode: local SQLite sessions and normalized JSON/JSONL exports.
  Cursor: supported state.vscdb composer headers and visible bubbles; JSON exports remain the fallback for other versions.
  ChatGPT: JSON exports follow the active conversation branch.
  Other agents: JSON/JSONL messages with user/assistant roles, or role-labelled text transcripts.
  Limits: 8 MiB per file, 100 conversations per export, 20 files per selection. Native stores are read only. Hidden reasoning and tool output are omitted.

CLI subscriptions
  Codex and Claude must advertise the required isolation flags and report subscription login. OpenCode must report subscription/OAuth auth and support pure mode. API-key configurations are refused.
  Cursor imports and context handoffs work. Its live specialist adapter is blocked until its CLI exposes a verified way to disable all tools.
  Connections shows installation and readiness separately. Readiness confirms login and isolation capabilities; provider usage limits can still prevent a call.
  New specialists default to Codex. Change the answering CLI in the specialist editor.

Connect another agent
  Open Connections and copy its generated MCP server configuration. The packaged app includes the server and runtime, so it does not require a source checkout.
  For source development: npm run mcp
  Tools: search_specialists, get_specialist_context, ask_specialist, get_consultation.
  Resources: specialist://<specialist-id>
  The Mac app does not need to remain open for the MCP server to access the library.

Command line
  npm run cli -- scan
  npm run cli -- import /path/to/transcript.json
  npm run cli -- create <imported-session-id> "Database specialist"
  npm run cli -- specialists "database migrations"
  npm run cli -- context <specialist-id> "What was decided?"
  npm run cli -- ask <specialist-id> "What was decided?" codex

Data and process behavior
  The default library is ~/Library/Application Support/Context Master/library.db on macOS. CONTEXT_MASTER_DATA_DIR can isolate a test library.
  Original chats are never resumed, modified, or deleted. Questions and session metadata also pass through common credential-pattern redaction. Imported copies are stored locally with restrictive file permissions.
  Briefs use inspectable extractive compression, and matching uses SQLite full-text search plus weighted lexical ranking. Match scores are not confidence probabilities.
  Each context packet includes at most six source excerpts. Citation numbers are validated; supporting a claim still requires reading its source.
  CLI processes receive a restricted environment without application tokens, API keys, or runtime injection variables. Codex disables its full advertised feature inventory and web search; an incomplete or unfamiliar inventory blocks answer mode.
  Parent-connected supervisors terminate process groups after cancellation, provider exit, or owner crash. Temporary consultation workspaces are removed. The native backend also stops when the Mac app process ends.
  Two specialist consultations are scheduled at once across app/MCP processes, with up to ten unfinished answer consultations admitted to the shared queue. Runs have heartbeats, cancellation, a 180-second execution timeout, and bounded output. Stale runs become failed instead of restarting silently.
  The desktop backend binds to loopback and requires a per-launch token. Foreign origins and hosts are rejected. Generic browser development has no launch token; do not expose it through a proxy.
  SQLite imports and edits are transactional. Specialist edits reject stale revisions. A linked session cannot be deleted until removed from its specialist.

Verification
  npm run check
  npm run test:e2e
  npm run build
  ESLint enforces cyclomatic complexity <=15. Tests cover parsers, SQLite invariants, CLI isolation and subscription checks, HTTP boundaries, stdio MCP interoperability, and browser workflows/accessibility.

Scope
  Reference: https://www.conductor.build/changelog. Its persistent queues, cancellation, provider setup, and attachable summaries informed this harness.
  This is a specialist consultation app inspired by Conductor's session and process workflows. It does not provide Conductor's general-purpose coding worktrees, terminal orchestration, or automatic project execution. It does not cloud-sync your library or guarantee support for every private transcript schema.
