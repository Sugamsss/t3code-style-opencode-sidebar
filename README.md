# t3code-style-opencode-sidebar

A T3 Code-style thread sidebar for OpenCode. It groups your chats into clear sections so you can see what is running, what you parked, and what is done.

## Sections

- **Pinned**: chats you keep at the top. Always the first section.
- **Needs You**: everything in flight that isn't actively running — waiting on a permission or form (yellow), stopped or failed (red), or finished (green or grey) and not yet acted on. Rows show the full detail view with `pin / snooze / archive / delete` actions. A chat stays here until you do something with it: send a new prompt (it wakes into Running) or pin, snooze, archive, or delete it. Viewing it is not enough.
- **Running**: only chats that are running right now (the animated dots). Collapsed by default; click the header to expand. The header count is the number of live tasks.
- **Snoozed**: chats parked until a time you pick.
- **Archive**: finished chats live here, collapsed by default. Old ones move here on their own after a few days; any new prompt moves a chat back to Running. Archiving a chat that is still running is refused.

## Snooze

Press `s` on a chat (or click `snooze`) and pick when it should come back:

- After 1 hour
- After 3 hours
- Tomorrow (09:00 local)
- Weekends (Saturday 09:00 local)
- Next week (Monday 09:00 local)
- Indefinitely (never wakes on its own; use `w` to wake it)

When the time comes, the chat moves back to **Running** (or into **Needs You** if it finished needing your attention while parked). Waking a chat by hand clears its timer.

## Upgrading from `opencode.setups`

The plugin id is now `t3code-style-opencode-sidebar`, so its state file moved too. Copy `plugin.opencode.setups.metadata.json` to `plugin.t3code-style-opencode-sidebar.metadata.json` in your OpenCode state folder (`~/.local/state/opencode/latest/tui/`). Your saved snoozes, pins, and sections come with it. The old file is left in place as a backup.

## Keys

| Key | Action |
| :--- | :--- |
| `p` | Pin |
| `s` | Snooze |
| `t` | Archive |
| `x` | Delete |
| `u` | Unpin or restore |
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
