import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { CreateGameServer, type GameServer } from "../server/app.ts";
import { Database } from "../server/database/database.ts";
import { CreateServices, type Services } from "../server/service_container.ts";

process.env.NODE_ENV = "test";

export async function CreateTestServices(): Promise<Services> {
  const db = await Database.Open(":memory:");
  return CreateServices(db);
}

let user_counter = 0;

export async function CreateTestPlayer(services: Services, name?: string, coins?: number): Promise<{ player_id: number; username: string }> {
  user_counter++;
  const username = name ?? `tester_${user_counter}`;
  const { user_id } = await services.auth_service.Register({ username, email: `${username}@example.com`, password: "password123", confirm_password: "password123" });
  if (coins !== undefined) await services.db.Run("UPDATE players SET coins = ? WHERE player_id = ?", coins, user_id);
  return { player_id: user_id, username };
}

export interface TestServer {
  game: GameServer;
  base_url: string;
  Stop(): Promise<void>;
}

export async function StartTestServer(database_path = ":memory:"): Promise<TestServer> {
  const game = await CreateGameServer({ database_path, static_dir: null, secure_cookies: false, allowed_origins: [] });
  await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", () => resolve()));
  const port = (game.server.address() as AddressInfo).port;
  return { game, base_url: `http://127.0.0.1:${port}`, Stop: () => game.Stop() };
}

export class ApiClient {
  cookie = "";

  constructor(private base_url: string) {}

  async Call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const response = await fetch(`${this.base_url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set_cookie = response.headers.get("set-cookie");
    if (set_cookie) this.cookie = set_cookie.split(";")[0];
    return { status: response.status, json: await response.json().catch(() => null) };
  }

  async RegisterAndLogin(username: string): Promise<void> {
    const registered = await this.Call("POST", "/api/auth/register", { username, email: `${username}@example.com`, password: "password123", confirm_password: "password123" });
    if (registered.status !== 200) throw new Error(`register failed ${JSON.stringify(registered.json)}`);
    const login = await this.Call("POST", "/api/auth/login", { login: username, password: "password123" });
    if (login.status !== 200) throw new Error(`login failed ${JSON.stringify(login.json)}`);
  }
}

export class SocketClient {
  socket: WebSocket;
  messages: { event: string; data: any }[] = [];
  private waiters: { event: string; predicate: (data: any) => boolean; resolve: (data: any) => void }[] = [];

  constructor(url: string, cookie: string) {
    this.socket = new WebSocket(url, { headers: { cookie } });
    this.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.event === message.event && waiter.predicate(message.data)) {
          waiter.resolve(message.data);
          return false;
        }
        return true;
      });
    });
  }

  Open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
      this.socket.once("unexpected-response", (_request, response) => reject(new Error(`status ${response.statusCode}`)));
    });
  }

  Send(event: string, data: unknown = {}): void {
    this.socket.send(JSON.stringify({ event, data }));
  }

  Wait(event: string, predicate: (data: any) => boolean = () => true, timeout_ms = 3000): Promise<any> {
    const existing = this.messages.find((message) => message.event === event && predicate(message.data));
    if (existing) return Promise.resolve(existing.data);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout_ms);
      this.waiters.push({ event, predicate, resolve: (data) => { clearTimeout(timer); resolve(data); } });
    });
  }

  Clear(): void {
    this.messages = [];
  }

  Close(): void {
    this.socket.close();
  }
}

export function Sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
