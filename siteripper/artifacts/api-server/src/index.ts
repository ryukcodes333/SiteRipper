import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { createTerminalWss } from "./routes/terminal";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

const server = http.createServer(app);
const terminal = createTerminalWss();

server.on("upgrade", (req, socket, head) => {
  if (!terminal.handleUpgrade(req, socket as import("net").Socket, head)) {
    socket.destroy();
  }
});

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
