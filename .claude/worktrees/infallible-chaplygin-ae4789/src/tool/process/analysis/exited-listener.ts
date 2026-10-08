// A command that said it was listening on a port and then exited is not serving anything: whatever answers on that
// port now is another program. Express 5, for one, hands a failed listen (port in use) to the callback, so an app that
// ignores it prints "listening" and exits 0 without a word about the error.

import net from 'node:net';

/**
 * The port a line of output says the program is listening on: "listening on port 3000", "running at
 * http://localhost:3000". A bare ":45" (a clock, file:line) or "running" alone (a status) is no such claim.
 */
export function claimedListeningPort(output: string): number | null {
  const m = /\b(?:listening|serving|running|ready|started)\b[^\n]{0,40}?\b(?:on|at)\b[^\n]{0,40}?(?:\bport\s*:?\s*(\d{2,5})\b|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b)/i.exec(output);
  const port = Number(m?.[1] ?? m?.[2]);
  return port > 0 && port < 65536 ? port : null;
}

/** Whether something accepts connections on the port, on either loopback address. */
export async function portAnswers(port: number, timeoutMs = 500): Promise<boolean> {
  const tryHost = (host: string) => new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answered: boolean) => { socket.destroy(); resolve(answered); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  const [v4, v6] = await Promise.all([tryHost('127.0.0.1'), tryHost('::1')]);
  return v4 || v6;
}

/**
 * For a finished command: what the person and the model need to know when it claimed a port, or null. A command that
 * names a URL in its own arguments (curl, wget) is a client of that address: what it printed came from the server.
 */
export async function exitedListenerNote(command: string, output: string): Promise<{ display: string; modelNote: string } | null> {
  if (/\bhttps?:\/\//i.test(command)) return null;
  const port = claimedListeningPort(output);
  if (!port) return null;
  if (await portAnswers(port)) {
    return {
      display: `Not running: it exited. Port ${port} is held by another program.`,
      modelNote:
        `This command printed that it was listening on port ${port}, but it has exited, so it is not serving anything. ` +
        `Something else already answers on port ${port} — often an earlier copy of this same app still running — and this ` +
        `start most likely failed to bind there without reporting it, so what answers on ${port} may be old code. ` +
        `Tell the user port ${port} is taken; run it on a free port (e.g. PORT=${port + 1}) or ask them to stop the other program.`,
    };
  }
  return {
    display: `Not running: it exited, so nothing is listening on port ${port}.`,
    modelNote:
      `This command printed that it was listening on port ${port}, but it has exited, so nothing is serving there now. ` +
      'To keep a server running, start it with start_subprocess.',
  };
}
