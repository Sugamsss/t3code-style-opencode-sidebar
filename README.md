# t3code-style-opencode-sidebar

A T3 Code-style thread sidebar for OpenCode. It groups your chats into clear sections so you can see what is running, what you parked, and what is done.

## Sections

- **Pinned**: chats you keep at the top.
- **Running**: chats that are active or waiting on you.
- **Snoozed**: chats parked until a time you pick.
- **Settled**: chats marked done. Old ones settle on their own after a few days.

## Snooze

Press `s` on a chat (or click `snooze`) and pick when it should come back:

- After 1 hour
- After 3 hours
- Tomorrow (09:00 local)
- Weekends (Saturday 09:00 local)
- Next week (Monday 09:00 local)
- Indefinitely (never wakes on its own; use `w` to wake it)

When the time comes, the chat moves back to **Running**. Waking a chat by hand clears its timer.

## Upgrading from `opencode.setups`

The plugin id is now `t3code-style-opencode-sidebar`, so its state file moved too. Copy `plugin.opencode.setups.metadata.json` to `plugin.t3code-style-opencode-sidebar.metadata.json` in your OpenCode state folder (`~/.local/state/opencode/latest/tui/`). Your saved snoozes, pins, and sections come with it. The old file is left in place as a backup.

## Keys

| Key | Action |
| :--- | :--- |
| `p` | Pin |
| `s` | Snooze |
| `t` | Settle |
| `x` | Delete |
| `u` | Unpin or unsettle |
| `w` | Wake a snoozed chat |

## Setup

This is an OpenCode plugin. Clone it, then add the folder to the `plugin` list in your `opencode.json`, for example:

```json
"plugin": ["file:///path/to/t3code-style-opencode-sidebar"]
```

Restart OpenCode after changes.

## Tests

```sh
bun run test
```

Runs from the plugin folder. See `test/README.md` for what the suite covers.

## License

MIT. See `LICENSE`.
