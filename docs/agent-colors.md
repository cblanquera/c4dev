# Approved agent-name colors

`web/src/agent-colors.ts` is the canonical inventory. Use these colors for agent labels in Team Chat, Logs, Diffs, Thread, and subtask headings. Assign by displayed name, independently of job title, so an agent stays recognizable when its assignment changes.

| Example name | Color token | Light theme | Dark theme |
|---|---|---|---|
| Grace Hopper | `blue` | `#1d4ed8` | `#93c5fd` |
| Linus Torvalds | `violet` | `#6d28d9` | `#c4b5fd` |
| Alex | `emerald` | `#047857` | `#6ee7b7` |
| Jamie | `amber` | `#92400e` | `#fcd34d` |
| Sam | `rose` | `#be123c` | `#fda4af` |
| Riley | `cyan` | `#0e7490` | `#67e8f9` |
| Casey | `indigo` | `#4338ca` | `#a5b4fc` |
| Jordan | `fuchsia` | `#a21caf` | `#f0abfc` |
| Taylor | `teal` | `#0f766e` | `#5eead4` |
| Morgan | `orange` | `#9a3412` | `#fdba74` |

Each of the ten base profiles has a distinct token. Extended run names reuse the approved palette deterministically. Keep the paired shades together when editing a token.

Palette acceptance requires at least **4.5:1** text contrast against the app's surface, secondary surface, and coordinator-bubble background in both themes. `test/agent-colors.test.ts` checks every pair against the current CSS tokens. Do not lower label opacity or apply an untested background to these colors. Names and job titles remain visible so color is an additional identification cue.

To add or change a color, update the canonical inventory and this table, then run the contrast checks and inspect both themes.
