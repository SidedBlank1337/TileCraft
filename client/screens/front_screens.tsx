import React, { useEffect, useRef, useState } from "react";
import { Api, ApiError } from "../services/api.ts";
import { game_socket } from "../services/socket.ts";
import { store, UseStore } from "../state/store.ts";
import { audio } from "../audio/audio_engine.ts";
import { Button, ErrorLine, Panel, UseAsync } from "../components/ui.tsx";
import type { PanelName } from "./game_screen.tsx";

export function Logo() {
  // Tree pixels on a 10x9 grid: L leaf, H leaf highlight, T trunk.
  const tree = ["..LLLLL...", ".LLHLLLL..", "LLLLLLHLL.", "LHLLLLLLL.", ".LLLLLLL..", "...LTL....", "....T.....", "....T.....", "...TTT...."];
  const colors: Record<string, string> = { L: "#4caf50", H: "#9be564", T: "#8a5a3b" };
  return (
    <div className="logo" aria-label="Tilecraft Realms">
      <svg className="logo_tree" viewBox="0 0 10 9" shapeRendering="crispEdges" aria-hidden>
        {tree.flatMap((row, y) => [...row].map((cell, x) => (cell === "." ? null : <rect key={`${x}_${y}`} x={x} y={y} width={1.02} height={1.02} fill={colors[cell]} />)))}
      </svg>
      <div className="logo_word">
        {"TILECRAFT".split("").map((letter, index) => <span key={index} style={{ animationDelay: `${index * 90}ms` }}>{letter}</span>)}
      </div>
      <div className="logo_ribbon">REALMS</div>
    </div>
  );
}

function Clouds() {
  return (
    <div className="front_clouds" aria-hidden>
      <span className="front_cloud cloud_a" />
      <span className="front_cloud cloud_b" />
      <span className="front_cloud cloud_c" />
    </div>
  );
}

export function TitleScreen(props: { on_play: () => void; on_options: () => void; on_about: () => void; on_quit: () => void }) {
  return (
    <div className="front_screen title_screen">
      <Clouds />
      <Logo />
      <nav className="title_buttons">
        <button className="front_button front_button_play" onClick={() => { audio.Unlock(); audio.Play("click"); props.on_play(); }}>Play Online</button>
        <button className="front_button" onClick={() => { audio.Play("click"); props.on_options(); }}>Options</button>
        <button className="front_button" onClick={() => { audio.Play("click"); props.on_about(); }}>About</button>
        <button className="front_button" onClick={() => { audio.Play("click"); props.on_quit(); }}>Quit</button>
      </nav>
      <div className="front_ground" aria-hidden />
    </div>
  );
}

export function AboutPanel(props: { on_close: () => void }) {
  return (
    <Panel title="About" on_close={props.on_close}>
      <p><b>Tilecraft Realms</b> is a multiplayer sandbox. Make worlds, dig for ore, grow trees, craft tools and trade with other players.</p>
      <p className="muted">All art and music are made in code for this game. The server checks every action, so nobody can fake coins or items.</p>
      <p className="muted">Controls: A/D to move, W or Space to jump, left click to break, right click to place, Enter to chat.</p>
    </Panel>
  );
}

export function LoginScreen(props: { on_back: () => void; on_logged_in: () => void }) {
  const [has_tile_id, set_has_tile_id] = useState(false);
  const [form, set_form] = useState({ name: "", tile_id: "", password: "" });
  const [error, set_error] = useState<string | null>(null);
  const [busy, set_busy] = useState(false);
  const Update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => set_form({ ...form, [key]: event.target.value });

  const Connect = async (event: React.FormEvent) => {
    event.preventDefault();
    set_error(null);
    set_busy(true);
    try {
      const result = has_tile_id
        ? await Api("POST", "/auth/login", { login: form.tile_id, password: form.password })
        : await Api("POST", "/auth/guest", { name: form.name });
      store.Set({ player: result.player });
      props.on_logged_in();
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Could not connect.");
      audio.Play("error");
    } finally {
      set_busy(false);
    }
  };

  return (
    <div className="front_screen front_dark">
      <form className="front_sheet login_sheet" onSubmit={Connect}>
        <div className="login_fields">
          <label className={`front_field ${has_tile_id ? "front_field_off" : ""}`}>Name:
            <input value={form.name} onChange={Update("name")} disabled={has_tile_id} required={!has_tile_id} minLength={3} maxLength={12} pattern="[A-Za-z0-9_]{3,12}" title="3-12 letters, numbers or underscores" autoFocus />
          </label>
          <div className="login_tile_id">
            <label className="front_check">
              <input type="checkbox" checked={has_tile_id} onChange={(event) => { set_has_tile_id(event.target.checked); set_error(null); }} />
              I have a TileID
            </label>
            <label className={`front_field ${has_tile_id ? "" : "front_field_off"}`}>TileID:
              <input value={form.tile_id} onChange={Update("tile_id")} disabled={!has_tile_id} required={has_tile_id} autoComplete="username" maxLength={16} />
            </label>
            <label className={`front_field ${has_tile_id ? "" : "front_field_off"}`}>Password:
              <input type="password" value={form.password} onChange={Update("password")} disabled={!has_tile_id} required={has_tile_id} autoComplete="current-password" maxLength={128} />
            </label>
          </div>
        </div>
        <div className="front_text">
          <p>Enter your name, then click <em>Connect</em> to go online.</p>
          <p>A <em>TileID</em> saves your worlds, items and coins on the server so you can play from any device, and lets you build, break and trade. To get one, <em>Connect</em> without it, then choose <em>Create a TileID</em> from the ⋮ menu. It's free!</p>
        </div>
        <ErrorLine message={error} />
        <div className="front_actions">
          <button type="button" className="front_button front_button_big" onClick={() => { audio.Play("click"); props.on_back(); }}>Back</button>
          <button type="submit" className="front_button front_button_big" disabled={busy}>{busy ? "…" : "Connect"}</button>
        </div>
      </form>
    </div>
  );
}

export function TileIdPanel(props: { on_close: () => void }) {
  const player = UseStore((state) => state.player);
  const [form, set_form] = useState({ tile_id: player?.username ?? "", email: "", password: "", confirm_password: "" });
  const [error, set_error] = useState<string | null>(null);
  const [busy, set_busy] = useState(false);
  const Update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => set_form({ ...form, [key]: event.target.value });
  const Submit = async (event: React.FormEvent) => {
    event.preventDefault();
    set_error(null);
    set_busy(true);
    try {
      const result = await Api("POST", "/auth/upgrade", form);
      store.Set({ player: result.player });
      store.Toast("success", `Your TileID ${result.player.username} is ready. You can now build, break and trade!`);
      audio.Play("achievement");
      props.on_close();
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Could not create the TileID.");
    } finally {
      set_busy(false);
    }
  };
  return (
    <Panel title="Create a TileID" on_close={props.on_close}>
      <form className="form_grid" onSubmit={Submit}>
        <p className="hint field_wide">Your progress as a guest is kept. After this you log in with your TileID and password.</p>
        <label className="field">TileID
          <input value={form.tile_id} onChange={Update("tile_id")} required minLength={3} maxLength={16} pattern="[A-Za-z0-9_]{3,16}" title="3-16 letters, numbers or underscores" autoComplete="username" />
        </label>
        <label className="field">Email
          <input type="email" value={form.email} onChange={Update("email")} required maxLength={254} autoComplete="email" />
        </label>
        <label className="field">Password
          <input type="password" value={form.password} onChange={Update("password")} required minLength={8} maxLength={128} autoComplete="new-password" />
        </label>
        <label className="field">Confirm password
          <input type="password" value={form.confirm_password} onChange={Update("confirm_password")} required autoComplete="new-password" />
        </label>
        <p className="hint field_wide">Passwords need at least 8 characters with a letter and a number.</p>
        <ErrorLine message={error} />
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create TileID"}</Button>
      </form>
    </Panel>
  );
}

type LogKind = "system" | "error" | "success" | "world" | "private";

interface LogLine {
  line_id: number;
  time: string;
  kind: LogKind;
  text: string;
}

function Clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

// Every line here reflects a real step of the HTTP check and WebSocket handshake.
export function ConnectingScreen(props: { on_ready: () => void; on_cancel: () => void }) {
  const [lines, set_lines] = useState<LogLine[]>([]);
  const [tab, set_tab] = useState<"all" | "world" | "private" | "system">("all");
  const counter = useRef(0);
  const log_ref = useRef<HTMLDivElement>(null);
  const username = UseStore((state) => state.player?.username);

  const Add = (kind: LogKind, text: string) => {
    counter.current++;
    const line: LogLine = { line_id: counter.current, time: Clock(), kind, text };
    set_lines((current) => [...current, line].slice(-200));
  };

  useEffect(() => {
    let finished = false;
    let ready_timer: number | null = null;
    const offs: (() => void)[] = [];
    Add("system", "Getting server address...");
    fetch("/health")
      .then((response) => response.json())
      .then((health) => {
        if (finished) return;
        Add("system", `Located server (${health.online_players} online, ${health.live_worlds} live worlds), connecting...`);
        Add("system", `Logging on ${username}...`);
        if (game_socket.connected) {
          Add("success", "Already connected to the server.");
          ready_timer = window.setTimeout(props.on_ready, 900);
        } else game_socket.Connect();
      })
      .catch(() => Add("error", "Could not reach the server. Retrying..."));

    offs.push(game_socket.On("hello", (data) => {
      Add("success", `Welcome back, ${data.player.username}! Level ${data.player.level}, ${data.player.coins.toLocaleString()} coins, ${data.inventory.length} item stacks.`);
      for (const event of data.events ?? []) Add("world", `Event running: ${event.name} — ${event.description}`);
      Add("system", "Loading the world list...");
      ready_timer = window.setTimeout(() => !finished && props.on_ready(), 1200);
    }));
    offs.push(game_socket.On("chat_message", (data) => Add(data.channel === "private" ? "private" : "world", `${data.channel === "private" ? "[PM] " : ""}${data.sender_name}: ${data.body}`)));
    offs.push(game_socket.On("notification", (data) => Add("system", data.message)));
    offs.push(game_socket.On("kicked", (data) => Add("error", data.message)));
    offs.push(game_socket.On("session_expired", () => Add("error", "Your session expired. Please log in again.")));
    let previous = store.Get().connection;
    const off_store = store.Subscribe(() => {
      const connection = store.Get().connection;
      if (connection === previous) return;
      previous = connection;
      if (connection === "reconnecting") Add("error", "Disconnected?! Will attempt to reconnect...");
      if (connection === "lost") Add("error", "Connection lost. Press Cancel and try again.");
    });
    return () => {
      finished = true;
      if (ready_timer) clearTimeout(ready_timer);
      offs.forEach((off) => off());
      off_store();
    };
  }, []);

  useEffect(() => {
    log_ref.current?.scrollTo({ top: log_ref.current.scrollHeight });
  }, [lines.length, tab]);

  const visible = lines.filter((line) => tab === "all" || (tab === "system" ? ["system", "error", "success"].includes(line.kind) : line.kind === tab));
  return (
    <div className="front_screen front_dark">
      <section className="log_window">
        <div className="log_tabs" role="tablist">
          {([["all", "All"], ["world", "World"], ["private", "Private"], ["system", "System"]] as const).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={`log_tab log_tab_${key} ${tab === key ? "log_tab_active" : ""}`} onClick={() => set_tab(key)}>{label}</button>
          ))}
        </div>
        <div className="log_lines" ref={log_ref} aria-live="polite">
          {visible.map((line) => (
            <p key={line.line_id} className={`log_line log_${line.kind}`}>
              <span className="log_icon" aria-hidden>i</span>
              <span className="log_time">[{line.time}]</span> {line.text}
            </p>
          ))}
        </div>
      </section>
      <div className="front_actions front_actions_left">
        <button className="front_button front_button_big" onClick={() => { audio.Play("click"); props.on_cancel(); }}>Cancel</button>
      </div>
    </div>
  );
}

interface WorldChip {
  world_id: number;
  world_name: string;
  current_players: number;
  total_visits: number;
  world_type: string;
}

const FILTERS = [["public", "Popular Worlds"], ["recent", "Recent Worlds"], ["mine", "My Worlds"], ["favorites", "Favorite Worlds"]] as const;

export function WorldSelectScreen(props: { on_enter: (name: string) => void; on_create: (name: string) => void; on_back: () => void; on_open: (panel: PanelName) => void }) {
  const [name, set_name] = useState("");
  const [filter_index, set_filter_index] = useState(0);
  const [error, set_error] = useState<string | null>(null);
  const [missing, set_missing] = useState<string | null>(null);
  const player = UseStore((state) => state.player);
  const chat = UseStore((state) => state.chat);
  const [filter, filter_label] = FILTERS[filter_index];
  const worlds = UseAsync(() => Api<{ worlds: WorldChip[] }>("GET", `/worlds?filter=${filter}`), [filter]);
  const health = UseAsync(() => fetch("/health").then((response) => response.json() as Promise<{ online_players: number }>), []);
  const recent_global = chat.filter((entry) => entry.channel === "global").slice(-2);

  useEffect(() => {
    const timer = setInterval(() => { worlds.reload(); health.reload(); }, 10_000);
    return () => clearInterval(timer);
  }, [filter]);

  const Enter = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const target = name.trim().toUpperCase();
    set_error(null);
    set_missing(null);
    if (!target) return set_error("Type a world name or pick one below.");
    try {
      await Api("GET", `/worlds/by-name/${encodeURIComponent(target)}`);
      props.on_enter(target);
    } catch (caught) {
      if (!(caught instanceof ApiError && caught.status === 404)) return set_error(caught instanceof Error ? caught.message : "Could not find that world.");
      if (player?.is_guest) return set_missing(target);
      // Unknown world: create it with the default preset, then enter.
      try {
        await Api("POST", "/worlds", { world_name: target, world_type: "public", world_size: "medium" });
        store.Toast("success", `${target} was created for you!`);
        props.on_enter(target);
      } catch (create_error) {
        set_error(create_error instanceof Error ? create_error.message : "Could not create that world.");
      }
    }
  };

  const chips = [...(worlds.data?.worlds ?? [])].sort((a, b) => b.current_players - a.current_players || b.total_visits - a.total_visits);
  return (
    <div className="front_screen front_dark">
      <section className="select_banner">
        <p><span className="tag_s">[S]</span> Where would you like to go? ({health.data?.online_players ?? "…"} online)</p>
        {recent_global.map((entry) => (
          <p key={entry.message_id}><span className="tag_g">[G]</span> <b>{entry.sender_name}</b>: {entry.body}</p>
        ))}
        {player && <p className="muted">Logged on as {player.username} · level {player.level} · {player.coins.toLocaleString()} coins</p>}
      </section>
      <form className="select_sheet" onSubmit={Enter}>
        <p className="select_hint">{missing ? `${missing} doesn't exist yet. Create a TileID to make new worlds.` : "Pick a world, or type a name and press Enter World. New names become new worlds."}</p>
        <label className="front_field select_name">World Name:
          <input value={name} onChange={(event) => { set_name(event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 16)); set_missing(null); }} maxLength={16} placeholder="SUNNYMEADOW" title="1-16 letters" />
        </label>
        <ErrorLine message={error ?? worlds.error} />
        <div className="world_chips">
          <button type="button" className="world_chip chip_filter" onClick={() => set_filter_index((filter_index + 1) % FILTERS.length)} title="Change list">Showing: {filter_label}</button>
          {chips.length === 0 && worlds.data && <span className="muted chip_empty">No worlds here yet.</span>}
          {chips.map((world) => (
            <button
              type="button"
              key={world.world_id}
              className={`world_chip ${world.current_players > 0 ? "chip_live" : "chip_quiet"} ${world.total_visits > 20 ? "chip_large" : world.total_visits < 3 ? "chip_small" : ""}`}
              onClick={() => { set_name(world.world_name); set_missing(null); }}
              onDoubleClick={() => props.on_enter(world.world_name)}
              title={`${world.world_type} · ${world.total_visits} visits`}
            >
              {world.world_name}{world.current_players > 0 ? ` (${world.current_players})` : ""}
            </button>
          ))}
        </div>
        <nav className="select_links">
          {([["profile", "Profile"], ["inventory", "Inventory"], ["shop", "Shop"], ["market", "Market"], ["crafting", "Crafting"], ["quests", "Quests"], ["friends", "Friends"], ["notifications", "Inbox"], ["my_worlds", "Manage Worlds"], ["settings", "Options"]] as const).map(([panel, label]) => (
            <Button key={panel} type="button" small variant="secondary" onClick={() => props.on_open(panel)}>{label}</Button>
          ))}
          {player?.is_admin && <Button type="button" small variant="secondary" onClick={() => props.on_open("admin")}>Admin</Button>}
          {player?.is_guest && <Button type="button" small onClick={() => props.on_open("tile_id")}>Create a TileID</Button>}
        </nav>
        <div className="front_actions">
          <button type="button" className="front_button front_button_big" onClick={() => { audio.Play("click"); props.on_back(); }}>Back</button>
          <button type="button" className="front_button front_button_big front_button_create" onClick={() => { audio.Play("click"); props.on_create(name.trim().toUpperCase()); }}>Create World</button>
          <button type="submit" className="front_button front_button_big">Enter World</button>
        </div>
      </form>
    </div>
  );
}
