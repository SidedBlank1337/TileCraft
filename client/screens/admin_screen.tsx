import React, { useState } from "react";
import { Api } from "../services/api.ts";
import { store } from "../state/store.ts";
import { Button, ErrorLine, Panel, TimeAgo, UseAsync } from "../components/ui.tsx";

export function AdminPanel(props: { on_close: () => void }) {
  const [tab, set_tab] = useState<"overview" | "players" | "worlds" | "economy" | "security" | "reports" | "events" | "logs">("overview");
  const [search, set_search] = useState("");
  const [applied, set_applied] = useState("");
  const [selected, set_selected] = useState<string | null>(null);
  const [error, set_error] = useState<string | null>(null);
  const [form, set_form] = useState({ item: "stone_block", quantity: 10, delta: 100, hours: 24, minutes: 30, reason: "" });
  const overview = UseAsync(() => Api<any>("GET", "/admin/overview"), [tab]);
  const players = UseAsync(() => Api<{ players: any[] }>("GET", `/admin/players?search=${encodeURIComponent(applied)}`), [applied, tab]);
  const worlds = UseAsync(() => Api<{ worlds: any[] }>("GET", `/admin/worlds?search=${encodeURIComponent(applied)}`), [applied, tab]);
  const detail = UseAsync(() => (selected ? Api<any>("GET", `/admin/players/${encodeURIComponent(selected)}`) : Promise.resolve(null)), [selected]);
  const transactions = UseAsync(() => (tab === "economy" ? Api<{ transactions: any[] }>("GET", "/admin/transactions") : Promise.resolve(null)), [tab]);
  const security = UseAsync(() => (tab === "security" ? Api<{ logs: any[] }>("GET", "/admin/security") : Promise.resolve(null)), [tab]);
  const reports = UseAsync(() => (tab === "reports" ? Api<{ reports: any[] }>("GET", "/admin/reports") : Promise.resolve(null)), [tab]);
  const events = UseAsync(() => (tab === "events" ? Api<{ definitions: any[]; active: any[] }>("GET", "/admin/events") : Promise.resolve(null)), [tab]);
  const logs = UseAsync(() => (tab === "logs" ? Api<{ logs: any[] }>("GET", "/admin/logs") : Promise.resolve(null)), [tab]);
  const [event_minutes, set_event_minutes] = useState(60);

  const Run = async (path: string, body: unknown, success: string) => {
    set_error(null);
    try {
      await Api("POST", path, body);
      store.Toast("success", success);
      detail.reload();
      players.reload();
      worlds.reload();
      events.reload();
      reports.reload();
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Failed.");
    }
  };

  return (
    <Panel title="Admin Console" on_close={props.on_close} wide>
      <div className="tab_row">
        {(["overview", "players", "worlds", "economy", "security", "reports", "events", "logs"] as const).map((key) => (
          <button key={key} className={tab === key ? "tab tab_active" : "tab"} onClick={() => set_tab(key)}>{key}</button>
        ))}
      </div>
      <ErrorLine message={error} />
      {tab === "overview" && overview.data && (
        <dl className="stat_list stat_list_wide">
          {["users", "worlds", "online_players", "live_worlds", "active_listings", "coins_in_circulation", "security_events_24h", "open_reports"].map((key) => (
            <React.Fragment key={key}><dt>{key.replace(/_/g, " ")}</dt><dd>{Number(overview.data[key] ?? 0).toLocaleString()}</dd></React.Fragment>
          ))}
        </dl>
      )}
      {(tab === "players" || tab === "worlds") && (
        <form className="toolbar" onSubmit={(event) => { event.preventDefault(); set_applied(search); }}>
          <input placeholder={`Search ${tab}`} value={search} onChange={(event) => set_search(event.target.value)} />
          <Button small type="submit">Search</Button>
        </form>
      )}
      {tab === "players" && (
        <div className="manage_grid">
          <div className="mini_table">
            {players.data?.players.map((player) => (
              <div key={player.player_id} className={`row_line ${selected === player.username ? "unread_row" : ""}`}>
                <span><b>{player.username}</b> lv {player.level} · {player.coins} coins {player.is_admin ? <span className="role_tag role_admin">admin</span> : null} {player.banned_until > Date.now() ? <span className="role_tag role_banned">banned</span> : null}</span>
                <Button small variant="secondary" onClick={() => set_selected(player.username)}>Inspect</Button>
              </div>
            ))}
          </div>
          {selected && detail.data && (
            <div className="sub_section">
              <h3>{selected} {detail.data.online_world && <span className="muted">in {detail.data.online_world}</span>}</h3>
              <div className="toolbar">
                <input className="small_input" value={form.item} onChange={(event) => set_form({ ...form, item: event.target.value })} placeholder="item key or id" />
                <input className="tiny_input" type="number" value={form.quantity} onChange={(event) => set_form({ ...form, quantity: Number(event.target.value) })} />
                <Button small onClick={() => Run("/admin/give-item", { username: selected, item: form.item, quantity: form.quantity }, "Item given.")}>Give</Button>
                <Button small variant="secondary" onClick={() => Run("/admin/take-item", { username: selected, item: form.item, quantity: form.quantity }, "Item removed.")}>Take</Button>
              </div>
              <div className="toolbar">
                <input className="tiny_input" type="number" value={form.delta} onChange={(event) => set_form({ ...form, delta: Number(event.target.value) })} />
                <Button small onClick={() => Run("/admin/coins", { username: selected, delta: form.delta }, "Coins adjusted.")}>Add coins</Button>
                <Button small variant="secondary" onClick={() => Run("/admin/coins", { username: selected, delta: -Math.abs(form.delta) }, "Coins removed.")}>Remove coins</Button>
              </div>
              <div className="toolbar">
                <input className="tiny_input" type="number" value={form.hours} onChange={(event) => set_form({ ...form, hours: Number(event.target.value) })} title="hours" />
                <input className="small_input" placeholder="reason" value={form.reason} onChange={(event) => set_form({ ...form, reason: event.target.value })} />
                <Button small variant="danger" onClick={() => Run("/admin/ban", { username: selected, hours: form.hours, reason: form.reason }, "Banned.")}>Ban</Button>
                <Button small variant="secondary" onClick={() => Run("/admin/unban", { username: selected }, "Unbanned.")}>Unban</Button>
              </div>
              <div className="toolbar">
                <Button small variant="secondary" onClick={() => Run("/admin/kick", { username: selected }, "Kicked.")}>Kick</Button>
                <Button small variant="secondary" onClick={() => Run("/admin/mute", { username: selected, minutes: form.minutes }, "Muted 30 min.")}>Mute</Button>
                <Button small variant="secondary" onClick={() => Run("/admin/mute", { username: selected, minutes: 0 }, "Unmuted.")}>Unmute</Button>
                <Button small variant="secondary" onClick={() => Run("/admin/teleport", { to_username: selected }, "Teleported to player.")}>Teleport to</Button>
                <Button small variant="secondary" onClick={() => Run("/admin/set-admin", { username: selected, is_admin: !detail.data.player.is_admin }, "Admin role updated.")}>{detail.data.player.is_admin ? "Revoke admin" : "Make admin"}</Button>
              </div>
              <h4>Stats</h4>
              <p className="muted small_text">{Object.entries(detail.data.stats).map(([key, value]) => `${key}: ${value}`).join(" · ")}</p>
              <h4>Recent transactions</h4>
              <div className="mini_table scroll_box">
                {detail.data.transactions.map((row: any) => <div key={row.transaction_id} className="row_line small_text"><span>{row.type} {row.amount > 0 ? "+" : ""}{row.amount} {row.item_id ? `item ${row.item_id}×${row.quantity}` : ""}</span><TimeAgo time={row.created_at} /></div>)}
              </div>
              <h4>Security events</h4>
              <div className="mini_table scroll_box">
                {detail.data.security.length === 0 && <p className="muted">Clean.</p>}
                {detail.data.security.map((row: any) => <div key={row.security_log_id} className="row_line small_text"><span>{row.kind} {row.details}</span><TimeAgo time={row.created_at} /></div>)}
              </div>
            </div>
          )}
        </div>
      )}
      {tab === "worlds" && (
        <div className="mini_table">
          {worlds.data?.worlds.map((world) => (
            <div key={world.world_id} className="row_line">
              <span><b>{world.world_name}</b> by {world.owner_name} · {world.world_type} · {world.current_players} online · {world.total_visits} visits · {world.tree_count} trees · {world.drop_count} drops</span>
              <Button small variant={world.locked ? "secondary" : "danger"} onClick={() => Run("/admin/world-lock", { world_name: world.world_name, locked: !world.locked }, world.locked ? "Unlocked." : "Locked.")}>{world.locked ? "Unlock" : "Lock"}</Button>
            </div>
          ))}
        </div>
      )}
      {tab === "economy" && (
        <div className="mini_table scroll_box tall_box">
          {transactions.data?.transactions.map((row) => (
            <div key={row.transaction_id} className="row_line small_text">
              <span><b>{row.username}</b> {row.type} {row.amount > 0 ? "+" : ""}{row.amount} → {row.balance_after ?? "-"} {row.item_id ? `(item ${row.item_id}×${row.quantity})` : ""} {row.reference_id ?? ""}</span>
              <TimeAgo time={row.created_at} />
            </div>
          ))}
        </div>
      )}
      {tab === "security" && (
        <div className="mini_table scroll_box tall_box">
          {security.data?.logs.map((row) => (
            <div key={row.security_log_id} className="row_line small_text"><span><b>{row.kind}</b> player {row.player_id ?? "?"} {row.details}</span><TimeAgo time={row.created_at} /></div>
          ))}
        </div>
      )}
      {tab === "reports" && (
        <div className="mini_table">
          {reports.data?.reports.length === 0 && <p className="muted">No reports.</p>}
          {reports.data?.reports.map((row) => (
            <div key={row.report_id} className="row_line">
              <span><b>{row.reporter_name}</b> → <b>{row.target_name}</b>: {row.reason} <span className="muted">{row.status}</span></span>
              {row.status === "open" && <Button small onClick={() => Run(`/admin/reports/${row.report_id}/close`, {}, "Closed.")}>Close</Button>}
            </div>
          ))}
        </div>
      )}
      {tab === "events" && events.data && (
        <>
          <div className="toolbar"><label className="inline_field">Duration (minutes)<input type="number" min={1} value={event_minutes} onChange={(event) => set_event_minutes(Number(event.target.value))} /></label></div>
          <div className="mini_table">
            {events.data.definitions.map((definition) => (
              <div key={definition.event_key} className="row_line">
                <span><b>{definition.name}</b> <span className="muted">{definition.description}</span></span>
                <Button small onClick={() => Run("/admin/events/start", { event_key: definition.event_key, duration_minutes: event_minutes }, `${definition.name} started.`)}>Start</Button>
              </div>
            ))}
          </div>
          <h3>Active</h3>
          {events.data.active.map((active) => (
            <div key={active.event_id} className="row_line"><span>{active.name} until {new Date(active.ends_at).toLocaleTimeString()}</span><Button small variant="danger" onClick={() => Run(`/admin/events/${active.event_id}/stop`, {}, "Stopped.")}>Stop</Button></div>
          ))}
        </>
      )}
      {tab === "logs" && (
        <div className="mini_table scroll_box tall_box">
          {logs.data?.logs.map((row) => <div key={row.admin_log_id} className="row_line small_text"><span><b>{row.admin_name ?? "system"}</b> {row.action} {row.target} {row.details}</span><TimeAgo time={row.created_at} /></div>)}
        </div>
      )}
    </Panel>
  );
}
