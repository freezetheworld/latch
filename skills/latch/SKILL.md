---
name: latch
description: "Control the user's real signed-in Chrome with the Latch extension. Use for opening, reusing, grouping, inspecting, clicking, typing, navigating, or screenshotting Chrome tabs when the user asks for browser interaction."
---

# Latch

Latch drives the user's real signed-in Chrome. Use it for any browser task here.

**Access.** Prefer the `latch` MCP tools (`browser_open`, `browser_snapshot`, ...). If they are not
registered in this session, use the CLI instead — same commands, same behavior:

```bash
latch --agent "<your name>" status
latch --agent "<your name>" open <url>
latch --agent "<your name>" snapshot
```

**Name yourself.** Pass your own name as the `agent` parameter (or set `LATCH_AGENT`) so your tabs
land in a tab group titled after you. Several agents share this Chrome profile at once; that group
name is how the user tells your tabs apart from each other's and from their own.

If another live session already holds the name you ask for, you are given a callsign variant of it
instead — ask for `Claude Code` while another Claude Code is running and you become `Claude Nova`.
Call `browser_status` to see the name you actually hold, and use that name when you tell the user
which tab group is yours. Do not try to take the plain name back.

## Tab ownership and reuse

Before opening any page, call `browser_tabs`. Reuse the relevant existing tab whenever possible.

Use `browser_open` for URLs. It follows this order:

1. Reuse an exact URL match.
2. Reuse a tab you already own on the same site and navigate it.
3. Create a tab only when neither exists.

Do not use `browser_new_tab` unless the user explicitly asks for another or separate tab. Never open a duplicate merely because the existing tab is not currently attached; attach and reuse it.

Keep `active=false` for normal work so Chrome stays in the background. Set `active=true` only when the user explicitly asks to see, open in front, or switch to the page. Browser work must not use macOS screen capture, Accessibility, AppleScript, or desktop input automation.

The group title also carries your live status, as an emoji and a word — `Codex · ⏳ Working`,
then `Codex · ✅ Done`. Latch sets that from the command you are running; you do not manage it.

Your tabs belong in the tab group named after you. Tabs opened by a controlled page are adopted into that same group automatically. Never reuse, adopt, or move tabs that belong to another agent's group, and never move unrelated user tabs into yours.

## Page actions

- Use `browser_snapshot` before interacting and prefer its element refs for clicks and typing.
- Use `browser_wait_for` after actions that load or update UI.
- `elements` only ever describes what is on screen. Check `scroll` in the snapshot before concluding
  a page has no more content, and `textTruncated` before concluding you have read all of it.
- Use `browser_evaluate` only when snapshot-based actions are insufficient.
- The on-page cursor, labelled with your agent name, is the visible indication that you are acting. Do not hide or remove it during work.
- Do not inspect cookies, passwords, local storage, or session stores.

## Scrolling

Use `browser_scroll`, not `browser_evaluate` with `window.scrollBy` — the window is often not what
scrolls, and evaluate will silently do nothing on an app whose content lives in an inner pane.

- `browser_scroll` with no arguments moves one screenful down, keeping a strip of overlap.
- `to: "bottom"` or `to: "top"` jumps to either end.
- Pass a `ref` from the snapshot's `scrollers` to move one specific container, or any other `ref` or
  `selector` to bring that element into view.
- Walk a feed by scrolling and re-snapshotting until `atBottom` is true or `movedY` is 0. Do not loop
  past that point; the result tells you when there is nothing left.

## Consequential actions

Opening, reading, navigating, and filling reversible fields are normal browser actions. Require an explicit user request before purchasing, trading, publishing, uploading, sending messages, deleting data, or changing account and security settings. If the exact consequential action is ambiguous, stop before the final click and ask.

When authentication is required, preserve the current Chrome tab and ask the user to sign in there. Do not switch to a different browsing surface to bypass sign-in.
