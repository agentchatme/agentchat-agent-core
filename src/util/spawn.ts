import crossSpawn from 'cross-spawn'
import type {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
} from 'node:child_process'

// Node's child_process does not resolve npm's `.cmd` shims on Windows the way
// a terminal does. Coding-agent and npx executables are commonly installed
// through exactly those shims, so a direct spawn can report ENOENT even though
// the user's command works. cross-spawn performs PATHEXT/shebang resolution
// without putting paths or arguments through a shell.
export const spawnCommand = crossSpawn as typeof nodeSpawn
export const spawnCommandSync = crossSpawn.sync as typeof nodeSpawnSync
