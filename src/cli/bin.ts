import { main } from './main.js'

// The `agentchat` bin. Sets the exit code and lets the event loop drain rather
// than calling process.exit(): exiting while undici tears down a keep-alive
// socket aborts the process on Windows with a libuv assertion.
main().then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    console.error(String(err instanceof Error ? (err.stack ?? err.message) : err))
    process.exitCode = 1
  },
)
