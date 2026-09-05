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

## Work inside your own tab group

Your tab group is your workspace, and it is the only place you can work. Everything you open goes
into it, every command you run acts on a tab inside it, and tabs outside it are not available to you
— not the user's tabs, and not another agent's. Latch enforces this rather than trusting you to
remember it, so you cannot collide with another session even when you both call yourself the same
thing.

Use `browser_open` for URLs. It works entirely inside your group:

1. Reuse a tab you already own on that exact URL.
2. Otherwise reuse a tab you already own on the same site, and navigate it.
3. Otherwise open a new tab, inside your group.

Because it never reaches outside your group, `browser_open` is always safe to call. Do not call
`browser_tabs` first to hunt for a tab to take over — a tab of the user's on the URL you want is
still not yours, and `browser_open` will correctly open your own instead of stealing it. Use
`browser_tabs` to report on what is open, not to pick a tab to seize.

Do not use `browser_new_tab` unless the user explicitly asks for another or separate tab.

Keep `active=false` for normal work so Chrome stays in the background. Set `active=true` only when the user explicitly asks to see, open in front, or switch to the page. Browser work must not use macOS screen capture, Accessibility, AppleScript, or desktop input automation.

The group title also carries your live status, as an emoji and a word — `Codex · ⏳ Working`,
then `Codex · ✅ Done`. Latch sets that from the command you are running; you do not manage it.

Tabs opened by a page you control are adopted into your group automatically, so a link that opens in
a new tab stays inside your workspace.

What the lock means in practice:

- A command with no `tabId` resolves only to an attached tab in your group. It will never fall
  through to whichever tab happens to be in the foreground.
- Naming a `tabId` outside your group fails with `TAB_NOT_IN_YOUR_GROUP`, and the message names the
  owning agent when there is one. Do not retry it and do not try to attach it: open your own tab
  with `browser_open` instead.
- The group is the record of ownership, so if the user drags one of your tabs into another agent's
  group, that tab becomes theirs; drag it out of every agent group and it is detached. Either way
  you will start getting `TAB_NOT_IN_YOUR_GROUP` on it. That is the user reassigning the tab, not an
  error to work around.
- `browser_attach` is for bringing a tab of the user's into your group. It is refused for a tab
  another live agent is driving.

## Page actions

- Use `browser_snapshot` before interacting and prefer its element refs for clicks and typing.
- Snapshots and element refs cross open shadow roots, so keep using them when an app opens a modal
  or editor inside Shadow DOM; no site-specific JavaScript workaround should be needed.
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
