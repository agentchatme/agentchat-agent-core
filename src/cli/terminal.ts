// ─── Text from the network, made safe for a terminal ────────────────────────
//
// Tool results carry peer-authored text (previews, names, bodies). Printed
// raw, an escape sequence in a peer's message could rewrite the owner's
// terminal (titles, cursor moves, hyperlinks, clipboard writes on some
// emulators). Everything the CLI prints from a response goes through this:
// ESC/CSI/OSC sequences and other C0/C1 controls are removed; newlines and
// tabs are kept.

const ESCAPES = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-Z\\-_]|\u009B[0-?]*[ -/]*[@-~]/g
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F-\u009F]/g

export function terminalSafe(text: string): string {
  return text.replace(ESCAPES, '').replace(CONTROLS, '')
}
