import { io, Socket } from "socket.io-client";
type SocketCallbacks = {
  onConnect?: (id: string, socket: Socket) => void;
  onDisconnect?: (reason: string) => void;
  onError?: (err: unknown) => void;
  onMessage?: (data: unknown) => void;
};
export type ConnectOptions = {
  baseUrl?: string;
  auth?: {
    role: "editor" | "viewer";
    token?: string;
  };
  callbacks?: SocketCallbacks;
};
export function connectSocket(opts: ConnectOptions = {}) {
  const { baseUrl, auth, callbacks } = opts;
  const socket = io(baseUrl, {
    auth,
    transports: ["websocket"],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 15000,
  });
  socket.on("connect", () => callbacks?.onConnect?.(socket.id!, socket));
  socket.on("disconnect", (reason) => callbacks?.onDisconnect?.(String(reason)));
  socket.on("error", (err) => callbacks?.onError?.(err));
  socket.on("message", (data) => callbacks?.onMessage?.(data));
  return socket;
}
