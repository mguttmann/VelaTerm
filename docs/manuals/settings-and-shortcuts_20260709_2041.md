# Settings & Shortcuts

Created: 2026-07-09 20:41

> Settings open from the gear button in the title bar (on macOS also the app menu, "Settings… ⌘,"). Eight categories on the left; this chapter is an item-by-item reference, ending with the default key bindings and how to rebind. Settings are shared between the desktop app and browser remote clients (a few purely per-client view options aside).

![Settings · Appearance](../assets/manuals/settings-appearance.png)

## 1. General

| Item | Description |
|------|-------------|
| Language | UI language; Auto (follow system) by default, or pin one of eleven languages |
| System notifications | Notification permission state and toggle, with per-platform steps when the OS has denied it |
| Notification sound | Sound for notifications |
| Vela Skills | One-click install of the `vspawn`, `vspawn-tree`, and `vopen` skills for both Claude and Codex (installed and removed as a bundle, refreshed on upgrade) |

## 2. Appearance

| Item | Description |
|------|-------------|
| Accent | Accent color: follow theme, or one of four fixed colors |
| Density | UI density: Compact / Regular / Comfy |
| Panes | Pane style: Flush / Card |
| Divider | Divider style: Subtle / Visible |
| Sidebar | Sidebar style: Tree / Compact |
| Interface font / size | UI font and size (Auto or manual stepping) |

Light/dark themes are switched from the title bar, not here (follow-system / dark / light). Running claude sessions re-skin instantly on switch.

## 3. Terminal

| Item | Description |
|------|-------------|
| Terminal font / size | Terminal font and size (⌘+ / ⌘- / ⌘0 adjust on the fly) |
| Terminal renderer | Rendering backend; keep the default (DOM) |
| Redraw on tab switch | Force a full repaint when switching tabs — enable if TUIs occasionally look glitched |
| Default shell (Windows only) | Default shell for new terminal sessions |

## 4. Conversation view

Applies to agent conversation views (the chat layout), not to terminal sessions.

| Item | Description |
|------|-------------|
| Conversation font / size / line height | Font, size and line height of the conversation view, independent of the terminal font |
| Composer toolbar | Choose which chips appear beside the message input and set their order: Model, Thinking effort, Collaboration mode, Permission mode, Fast mode, Speed, Tone, MCP servers, Background tasks, Account and Codex reset credits. Use each On/Off switch to include or remove a chip from the input row; use the arrows to reorder chips that are on. Model, Thinking effort, Collaboration mode and Permission mode are on by default. Chips unsupported by the current agent or model are omitted. A supported chip remains present when its feature is temporarily unavailable: MCP servers and Background tasks are disabled while the agent process is stopped, and Account is disabled during a pending sign-in or account operation. With a running agent and no background tasks, the Background tasks menu shows an empty state |

On desktop, **More** appears whenever a supported chip is off or the chips that are on do not all fit beside the input. It contains both the overflowed chips and those that are off. Even with every chip off, you can open More and use the supported controls without first enabling them in Settings. More is absent when there are no supported chips, or when every supported chip is on and fits in the row. To return a chip to the input row, turn it on in Settings; turning a chip off and on again places it at the end of the inline order. Temporarily disabled controls remain disabled in More. On mobile, chips that are off remain visible in a second row.

## 5. Behavior

| Item | Description |
|------|-------------|
| Tabs | Tab mode: Multi (default) / Single (single reused tab) |
| Background limit | Cap on background keep-alive tabs (default 32); past it, the oldest inactive tab is ended automatically |
| Confirm before spawn | Show the confirmation card before spawning child sessions (on by default) — see [Session Spawning & Git Collaboration](session-spawning-and-git_20260709_2041.md) |
| Usage refresh | Refresh interval for the Usage quota in the Info panel |
| Image paste | Image paste behavior: Upload as file (materialize to a path) / Agent default |
| Auto-clean pasted images | Periodically clean up pasted temp images, with a "Clean now" button |
| System notifications | Shortcut to the notification permission controls (same as General) |

## 6. Advanced

| Item | Description |
|------|-------------|
| Foreground-priority output | Output scheduling that protects typing latency while agents flood output (on by default); turn off to compare if you suspect display issues |
| Record session logs | Session recording (off by default). When on, terminal content is recorded in full — archives get replay, global search covers terminal output |

## 7. Agents

Configured per type (Claude / Codex / OpenCode / …), applying to **newly created** sessions of that type; per-session settings in the edit form override these defaults.

![Settings · Agents](../assets/manuals/settings-agents.png)

| Item | Description |
|------|-------------|
| Executable path | Full path to the executable. Empty = look up the command on PATH; set it when the agent lives outside PATH. Auto-filled after a successful one-click install |
| Launch args | Default launch-argument template for the type (e.g. `--model opus`) |
| Permission | Default permission level: Default (step-by-step confirmation) / YOLO (skip all permission prompts) |

## 8. Shortcuts

![Settings · Shortcuts](../assets/manuals/settings-shortcuts.png)

Click an action's binding, then press the new combination (must include ⌘/Ctrl). Conflicts name the current owner; "Restore defaults" resets everything. Defaults:

| Action | macOS | Windows / Linux |
|--------|-------|-----------------|
| Open project | ⌘O | Ctrl+Alt+O |
| New scratch terminal | ⌘T | Ctrl+Alt+T |
| New agent session | ⌘N | Ctrl+Alt+N |
| New browser tab | ⌘⇧B | Ctrl+Alt+B |
| Close pane / tab | ⌘W | Ctrl+Alt+W |
| Split right | ⌘D | Ctrl+Alt+D |
| Split down | ⌘⇧D | Ctrl+Alt+E |
| Find in terminal | ⌘F | Ctrl+Alt+F |
| Search all sessions | ⌘⇧F | Ctrl+Alt+G |
| Save document | ⌘S | Ctrl+S |

**New agent session** opens a searchable list of agent types and saved presets, with recently used choices first. Its default is ⌘N in the macOS desktop app and remote-connection windows, and Ctrl+Alt+N on Windows, Linux and regular browsers, including browsers on macOS. You can rebind this action in Settings > Shortcuts.

The picker shows where the new session will be created. With an active saved session, choose **Sibling** to create it at the same level or **Child** to nest it below that session. While the search field is focused, Tab switches between these two positions, ↑/↓ selects a result, and Enter creates the selected session. Shift+Tab moves focus out of the search field to the preceding control; Escape closes the picker. You can also select a result with the mouse and press **Create**. If there is no valid target project, select one or use **Open project** before creating a session.

The picker URL preserves the target, position, search text and selected choice. Copying the URL, refreshing, or using Back and Forward restores that state without creating a session. Creation requires Enter in the search field or the Create button, and a failed attempt leaves the picker open for review or retry.

Fixed, non-rebindable keys: ⌘1–9 (switch tabs), ⌘+ / ⌘- / ⌘0 (terminal font size).

When you open VelaTerm in a regular browser (URL remote access), the browser itself consumes ⌘/Ctrl letter combos (⌘D bookmarks, ⌘T opens a tab…), so the Windows / Linux Ctrl+Alt bindings above apply on every OS, and the settings page shows them that way. Desktop apps and remote-connection windows keep the macOS ⌘ bindings.
