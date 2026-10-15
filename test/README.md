Run `bun run test` from the plugin directory. The browser condition selects Solid's reactive runtime instead of its server renderer.

The suite drives the actual sidebar status controller with reactive session, selection, permission, and form state. It covers strict precedence, completion/read persistence, failures and retries, stale snapshots, duplicate events, reconnect hydration, nested background subagents, unrelated tasks, and listener cleanup.

Keep `sidebar-status.tsx` as TSX even though it contains no JSX. In the installed OpenCode beta, the TSX plugin transform binds its Solid imports to the host's embedded runtime. A plain TS helper can load a separate Solid instance: isolated tests pass but live sidebar dependencies stop updating. Verify runtime changes by loading the plugin in OpenCode too.
