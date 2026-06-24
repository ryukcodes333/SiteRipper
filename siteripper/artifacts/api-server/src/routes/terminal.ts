import { type IncomingMessage } from "http";
import { spawn } from "child_process";
import { WebSocketServer, type WebSocket } from "ws";

export function createTerminalWss() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    const shell = spawn("/bin/sh", [], {
      env: { ...process.env, TERM: "xterm-256color", HOME: "/tmp" },
      cwd: "/tmp",
    });

    shell.stdout.on("data", (d: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "out", data: d.toString() }));
    });
    shell.stderr.on("data", (d: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "out", data: d.toString() }));
    });
    shell.on("exit", (code) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "exit", code }));
      ws.close();
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; data?: string };
        if (msg.type === "input" && msg.data) shell.stdin.write(msg.data);
        if (msg.type === "resize") { /* PTY resize not supported without node-pty */ }
      } catch {}
    });

    ws.on("close", () => shell.kill());
  });

  return {
    wss,
    handleUpgrade(req: IncomingMessage, socket: import("net").Socket, head: Buffer) {
      if (req.url?.startsWith("/api/terminal")) {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
        return true;
      }
      return false;
    },
  };
}
