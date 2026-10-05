import React, { useEffect, useRef, useState } from "react";
import { HOTBAR_SLOTS } from "../../shared/constants.ts";
import { GetItem } from "../../shared/items.ts";
import { FIST_SLOT, GameEngine, type HoverInfo, type WorldMeta } from "../game/game_engine.ts";
import { game_socket } from "../services/socket.ts";
import { store, UseStore } from "../state/store.ts";
import { CONTROL_SCALES, UseUiSettings } from "../state/ui_settings.ts";
import { Coins, ConnectionBadge, ItemIcon } from "../components/ui.tsx";
import { PixelIcon } from "../components/pixel_icon.tsx";

export type PanelName =
  | "inventory" | "crafting" | "shop" | "market" | "quests" | "profile" | "friends" | "settings" | "browser" | "create_world"
  | "my_worlds" | "manage_world" | "admin" | "notifications" | "about" | "pause" | "tile_id";

// Press-and-hold button that works for mouse and touch alike.
function HoldButton(props: { className: string; label: string; on_change: (pressed: boolean) => void; children: React.ReactNode }) {
  const Set = (pressed: boolean) => (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (pressed) event.currentTarget.setPointerCapture(event.pointerId);
    props.on_change(pressed);
  };
  return (
    <button
      className={props.className}
      aria-label={props.label}
      onPointerDown={Set(true)}
      onPointerUp={Set(false)}
      onPointerCancel={Set(false)}
      onLostPointerCapture={() => props.on_change(false)}
      onContextMenu={(event) => event.preventDefault()}
    >
      {props.children}
    </button>
  );
}

function Hotbar(props: { on_open_bag: () => void }) {
  const inventory = UseStore((state) => state.inventory);
  const selected = UseStore((state) => state.selected_slot);
  const by_slot = new Map(inventory.map((slot) => [slot.slot_index, slot]));
  return (
    <div className="hotbar_wrap">
      <button className="hud_tab" onClick={props.on_open_bag} aria-label="Open inventory"><span /><span /><span /></button>
      <div className="hotbar" role="toolbar" aria-label="Hotbar">
        <button className={`hotbar_slot ${selected === FIST_SLOT ? "slot_selected" : ""}`} onClick={() => store.Set({ selected_slot: FIST_SLOT })} aria-label="Fist">
          <span className="fist_icon"><PixelIcon name="fist" size={28} /></span>
        </button>
        {Array.from({ length: HOTBAR_SLOTS }, (_, index) => {
          const slot = by_slot.get(index);
          return (
            <button key={index} className={`hotbar_slot ${index === selected ? "slot_selected" : ""}`} onClick={() => store.Set({ selected_slot: index })} aria-label={slot ? GetItem(slot.item_id)?.name : `Empty slot ${index + 1}`}>
              {slot && <ItemIcon item_id={slot.item_id} quantity={slot.quantity} />}
              <span className="slot_number">{index + 1}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChatLog(props: { expanded: boolean; set_expanded: (value: boolean) => void; input_ref: React.RefObject<HTMLInputElement | null>; on_focus_change: (focused: boolean) => void }) {
  const chat = UseStore((state) => state.chat);
  const [channel, set_channel] = useState<"world" | "global" | "private">("world");
  const [to, set_to] = useState("");
  const [text, set_text] = useState("");
  const log_ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    log_ref.current?.scrollTo({ top: log_ref.current.scrollHeight });
  }, [chat.length, props.expanded]);
  const Send = (event: React.FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    game_socket.Send("chat_send", { channel, text: body, to_username: channel === "private" ? to : undefined });
    set_text("");
  };
  const lines = props.expanded ? chat : chat.slice(-2);
  return (
    <div className={`top_log ${props.expanded ? "top_log_open" : ""}`}>
      <div className="top_log_lines" ref={log_ref}>
        {lines.length === 0 && <p className="chat_line muted">Press Enter or the chat button to talk.</p>}
        {lines.map((entry, index) => (
          <p key={`${entry.message_id}_${index}`} className={`chat_line chat_${entry.channel}`}>
            <span className="chat_channel">{entry.channel === "private" ? (entry.recipient_name ? `to ${entry.recipient_name}` : "pm") : entry.channel}</span>
            <b>{entry.sender_name}:</b> {entry.body}
          </p>
        ))}
      </div>
      {props.expanded && (
        <form className="chat_form" onSubmit={Send}>
          <select value={channel} onChange={(event) => set_channel(event.target.value as typeof channel)} aria-label="Chat channel">
            <option value="world">World</option>
            <option value="global">Global</option>
            <option value="private">Private</option>
          </select>
          {channel === "private" && <input className="chat_to" placeholder="to" value={to} onChange={(event) => set_to(event.target.value)} maxLength={16} />}
          <input
            ref={props.input_ref}
            value={text}
            maxLength={160}
            placeholder="Press Enter to chat, /help"
            onChange={(event) => set_text(event.target.value)}
            onFocus={() => props.on_focus_change(true)}
            onBlur={() => props.on_focus_change(false)}
            onKeyDown={(event) => event.key === "Escape" && (event.target as HTMLInputElement).blur()}
          />
        </form>
      )}
      <button className="hud_tab top_log_tab" onClick={() => props.set_expanded(!props.expanded)} aria-label={props.expanded ? "Collapse chat" : "Expand chat"}><span /><span /><span /></button>
    </div>
  );
}

function SideButton(props: { icon: string; label: string; on_click: () => void; badge?: number }) {
  return (
    <button className="side_button" onClick={props.on_click} aria-label={props.label} title={props.label}>
      <PixelIcon name={props.icon} size={26} />
      {props.badge ? <span className="side_badge">{props.badge}</span> : null}
    </button>
  );
}

export function GameScreen(props: { panel_open: boolean; on_open: (panel: PanelName, world_id?: number) => void; on_leave: () => void }) {
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const chat_ref = useRef<HTMLInputElement>(null);
  const [engine, set_engine] = useState<GameEngine | null>(null);
  const [meta, set_meta] = useState<WorldMeta | null>(null);
  const [hover, set_hover] = useState<HoverInfo | null>(null);
  const [chat_open, set_chat_open] = useState(false);
  const chat_focused = useRef(false);
  const panel_open = useRef(props.panel_open);
  panel_open.current = props.panel_open;
  const player = UseStore((state) => state.player);
  const events = UseStore((state) => state.events);
  const unread = UseStore((state) => state.unread_notifications);
  const selected = UseStore((state) => state.selected_slot);
  const { control_size } = UseUiSettings();

  useEffect(() => {
    const created = new GameEngine(canvas_ref.current!, () => chat_focused.current || panel_open.current || !!store.Get().trade);
    created.on_meta = set_meta;
    created.on_hover = set_hover;
    if (created.meta) set_meta(created.meta);
    set_engine(created);
    return () => created.Destroy();
  }, []);

  const OpenChat = () => {
    set_chat_open(true);
    setTimeout(() => chat_ref.current?.focus(), 0);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (chat_focused.current || panel_open.current) return;
      const key = event.key.toLowerCase();
      if (key === "enter") {
        event.preventDefault();
        OpenChat();
      } else if (key === "e") props.on_open("inventory");
      else if (key === "c") props.on_open("crafting");
      else if (key === "j") props.on_open("quests");
      else if (key === "escape") props.on_open("pause");
      else if (key === "f" && engine) engine.mobile.action = true;
    };
    const release = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "f" && engine) engine.mobile.action = false;
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("keyup", release);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keyup", release);
    };
  }, [props.on_open, engine]);

  const Press = (key: "left" | "right" | "jump" | "action") => (pressed: boolean) => {
    if (engine) engine.mobile[key] = pressed;
  };

  return (
    <div className="game_screen" style={{ "--hud_scale": CONTROL_SCALES[control_size] } as React.CSSProperties}>
      <canvas ref={canvas_ref} className="game_canvas" />

      <div className="hud_status">
        <b>{meta?.world_name ?? "…"}</b>
        {meta && <span className={`role_tag role_${meta.your_role}`}>{meta.your_role}</span>}
        {player?.is_guest && <span className="role_tag role_visitor">guest</span>}
        <ConnectionBadge />
        {player && (
          <div className="hud_stats">
            <span className="level_chip">Lv {player.level}</span>
            <div className="xp_bar" title={`${player.xp_into_level}/${player.xp_needed} XP`}><div style={{ width: `${(player.xp_into_level / player.xp_needed) * 100}%` }} /></div>
          </div>
        )}
        {events.length > 0 && <div className="event_banner">★ {events.map((event) => event.name).join(" · ")}</div>}
      </div>

      <ChatLog expanded={chat_open} set_expanded={set_chat_open} input_ref={chat_ref} on_focus_change={(focused) => (chat_focused.current = focused)} />

      <nav className="side_column" aria-label="Game menu">
        <SideButton icon="dots" label="Menu" on_click={() => props.on_open("pause")} />
        <SideButton icon="chat" label="Chat" on_click={OpenChat} />
        <SideButton icon="face" label="Profile & wardrobe" on_click={() => props.on_open("profile")} />
        <SideButton icon="book" label="Quests & achievements" on_click={() => props.on_open("quests")} />
        <SideButton icon="bag" label="Inventory" on_click={() => props.on_open("inventory")} />
        <SideButton icon="hammer" label="Crafting" on_click={() => props.on_open("crafting")} />
        <SideButton icon="cart" label="Shop" on_click={() => props.on_open("shop")} />
        <SideButton icon="scale" label="Marketplace" on_click={() => props.on_open("market")} />
        <SideButton icon="people" label="Friends" on_click={() => props.on_open("friends")} />
        <SideButton icon="inbox" label="Inbox" badge={unread} on_click={() => props.on_open("notifications")} />
        {meta?.can_manage && <SideButton icon="flag" label="Manage world" on_click={() => props.on_open("manage_world", meta.world_id)} />}
        {player?.is_admin && <SideButton icon="shield" label="Admin" on_click={() => props.on_open("admin")} />}
        {player && <div className="side_coins"><Coins amount={player.coins} /></div>}
      </nav>

      {hover && (
        <div className={`hover_hint ${hover.in_range ? "" : "hover_far"}`}>
          {hover.label} <span className="muted">({hover.tile_x}, {hover.tile_y})</span>
        </div>
      )}

      <div className="move_pad">
        <HoldButton className="pad_button" label="Move left" on_change={Press("left")}><PixelIcon name="left" size={40} /></HoldButton>
        <HoldButton className="pad_button" label="Move right" on_change={Press("right")}><PixelIcon name="right" size={40} /></HoldButton>
      </div>
      <Hotbar on_open_bag={() => props.on_open("inventory")} />
      <div className="action_pad">
        <HoldButton className="round_button jump_button" label="Jump" on_change={Press("jump")}><PixelIcon name="up" size={40} /></HoldButton>
        <HoldButton className="round_button action_button" label={selected === FIST_SLOT ? "Punch" : "Place"} on_change={Press("action")}>
          <PixelIcon name={selected === FIST_SLOT ? "fist" : "place"} size={52} />
        </HoldButton>
      </div>
    </div>
  );
}

export function PauseMenu(props: { is_guest: boolean; on_continue: () => void; on_options: () => void; on_tile_id: () => void; on_quit: () => void }) {
  return (
    <div className="panel_backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.on_continue()}>
      <nav className="pause_menu" aria-label="Pause menu">
        <button className="front_button pause_button pause_continue" onClick={props.on_continue} autoFocus>Continue</button>
        <button className="front_button pause_button" onClick={props.on_options}>Options</button>
        {props.is_guest && <button className="front_button pause_button pause_tile_id" onClick={props.on_tile_id}>Create a TileID</button>}
        <button className="front_button pause_button pause_quit" onClick={props.on_quit}>Quit World</button>
      </nav>
    </div>
  );
}
