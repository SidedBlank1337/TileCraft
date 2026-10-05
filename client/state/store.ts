import { useSyncExternalStore } from "react";
import type { InventorySlot, PlayerSelfView, TradeStateView } from "../../shared/protocol.ts";

export type ConnectionStatus = "offline" | "connecting" | "connected" | "reconnecting" | "lost";

export interface ToastEntry {
  toast_id: number;
  kind: string;
  message: string;
}

export interface ChatEntry {
  message_id: number;
  channel: string;
  body: string;
  sender_name: string;
  sender_id: number;
  recipient_name?: string;
  created_at: number;
}

export interface GameEvent {
  event_id: number;
  event_key: string;
  name: string;
  description: string;
  ends_at: number;
}

export interface StoreState {
  player: PlayerSelfView | null;
  inventory: InventorySlot[];
  selected_slot: number;
  connection: ConnectionStatus;
  toasts: ToastEntry[];
  chat: ChatEntry[];
  trade: TradeStateView | null;
  trade_invite: { trade_id: string; from_username: string } | null;
  events: GameEvent[];
  current_world: string | null;
  unread_notifications: number;
}

const INITIAL: StoreState = {
  player: null, inventory: [], selected_slot: -1, connection: "offline", toasts: [], chat: [], trade: null,
  trade_invite: null, events: [], current_world: null, unread_notifications: 0
};

let state: StoreState = INITIAL;
const listeners = new Set<() => void>();
let toast_counter = 0;

export const store = {
  Get: () => state,
  Set(patch: Partial<StoreState> | ((current: StoreState) => Partial<StoreState>)) {
    const next = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  },
  Subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  Reset() {
    state = INITIAL;
    for (const listener of listeners) listener();
  },
  Toast(kind: string, message: string) {
    const toast_id = ++toast_counter;
    store.Set((current) => ({ toasts: [...current.toasts.slice(-3), { toast_id, kind, message }] }));
    setTimeout(() => store.Set((current) => ({ toasts: current.toasts.filter((toast) => toast.toast_id !== toast_id) })), 4200);
  },
  AddChat(entry: ChatEntry) {
    store.Set((current) => ({ chat: [...current.chat.filter((existing) => existing.message_id === 0 || existing.message_id !== entry.message_id), entry].slice(-120) }));
  }
};

export function UseStore<T>(selector: (current: StoreState) => T): T {
  return useSyncExternalStore(store.Subscribe, () => selector(state));
}
