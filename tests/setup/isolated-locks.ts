import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// The agent locks (one agent, one listener) live in a per-user folder every
// front door reads. No test may write there, and test files running at the
// same time must not stand each other by: each file gets a folder of its own.
process.env['AGENTCHAT_LOCK_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-test-locks-'))
