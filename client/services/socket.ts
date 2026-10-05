import { store } from "../state/store.ts";
import type { ClientEventName } from "../../shared/protocol.ts";
import { audio } from "../audio/audio_engine.ts";
import { GetItem } from "../../shared/items.ts";

type Handler = (data: any) => void;

const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000];

// Single shared connection. The server is authoritative, so reconnecting simply
// re-joins the last world and receives a fresh world_state; nothing is replayed.
class GameSocket {
  private socket: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private attempts = 0;
  private wanted = false;
  private reconnect_timer: number | null = null;
  rejoin_world: string | null = null;
  last_world_state: any = null;

  On(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private Emit(event: string, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }

  Connect(): void {
    this.wanted = true;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    store.Set({ connection: this.attempts === 0 ? "connecting" : "reconnecting" });
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      store.Set({ connection: "connected" });
      if (this.rejoin_world) this.Send("join_world", { world_name: this.rejoin_world });
    };
    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data as string) as { event: string; data: unknown };
        if (parsed.event === "world_state") this.last_world_state = parsed.data;
        if (parsed.event === "world_left" || parsed.event === "kicked") this.last_world_state = null;
        this.Emit(parsed.event, parsed.data);
      } catch {
        // Ignore malformed frames from the server rather than crash the UI.
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.wanted || event.code === 4001 || event.code === 4003) {
        store.Set({ connection: event.code === 4001 ? "lost" : "offline" });
        return;
      }
      if (event.code === 4002) {
        store.Set({ connection: "offline" });
        this.Emit("session_expired", {});
        return;
      }
      this.attempts++;
      store.Set({ connection: this.attempts > RECONNECT_DELAYS.length ? "lost" : "reconnecting" });
      const delay = RECONNECT_DELAYS[Math.min(this.attempts - 1, RECONNECT_DELAYS.length - 1)];
      this.reconnect_timer = window.setTimeout(() => this.Connect(), delay);
    };
  }

  Disconnect(): void {
    this.wanted = false;
    this.rejoin_world = null;
    if (this.reconnect_timer) clearTimeout(this.reconnect_timer);
    this.socket?.close(1000);
    this.socket = null;
    store.Set({ connection: "offline" });
  }

  Send(event: ClientEventName, data: Record<string, unknown> = {}): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ event, data }));
    return true;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}

export const game_socket = new GameSocket();

// Global (non-world) handlers live here so they work in menus too.
export function InstallGlobalHandlers(): void {
  game_socket.On("hello", (data) => store.Set({ player: data.player, inventory: data.inventory, events: data.events }));
  game_socket.On("player_update", (data) => {
    const previous = store.Get().player;
    if (previous && data.level > previous.level) audio.Play("level_up");
    store.Set({ player: data });
  });
  game_socket.On("inventory_update", (data) => store.Set({ inventory: data.slots }));
  game_socket.On("notification", (data) => {
    store.Toast(data.kind, data.message);
    store.Set((current) => ({ unread_notifications: current.unread_notifications + (data.notification_id ? 1 : 0) }));
    if (data.kind === "achievement") audio.Play("achievement");
    else if (data.kind === "quest") audio.Play("quest");
    else if (data.kind === "level_up") audio.Play("level_up");
    else if (data.kind === "market_sale") audio.Play("market");
    else audio.Play("notification");
  });
  game_socket.On("item_obtained", (data) => {
    audio.Play("pickup");
    store.Toast("item", `+${data.quantity} ${GetItem(data.item_id)?.name ?? "item"}`);
  });
  game_socket.On("chat_history", (data) => store.Set({ chat: data.messages }));
  game_socket.On("chat_message", (data) => store.AddChat(data));
  game_socket.On("error", (data) => {
    if (data.code === "rate_limited" || data.code === "protocol" || data.message) store.Toast("error", data.message ?? "Action rejected.");
    audio.Play("error");
  });
  game_socket.On("trade_request", (data) => {
    store.Set({ trade_invite: data });
    audio.Play("trade");
  });
  game_socket.On("trade_update", (data) => store.Set({ trade: data.status === "pending" ? null : data, trade_invite: data.status === "pending" ? store.Get().trade_invite : null }));
  game_socket.On("trade_closed", (data) => {
    store.Set({ trade: null, trade_invite: null });
    store.Toast(data.completed ? "success" : "info", data.completed ? "Trade completed!" : `Trade closed: ${data.reason}`);
    if (data.completed) audio.Play("trade");
  });
  game_socket.On("event_update", (data) => store.Set({ events: data.events }));
  game_socket.On("kicked", (data) => {
    store.Toast("error", data.message);
    store.Set({ current_world: null });
    game_socket.rejoin_world = null;
  });
  game_socket.On("fish_result", (data) => {
    store.Toast(data.caught ? "success" : "info", data.message);
    if (data.caught) audio.Play("pickup");
  });
}
