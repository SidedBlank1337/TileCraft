import React, { useState } from "react";
import { WORLD_TYPES, BACKGROUNDS } from "../../shared/constants.ts";
import { Api } from "../services/api.ts";
import { store } from "../state/store.ts";
import { Button, ErrorLine, Panel, TimeAgo, UseAsync } from "../components/ui.tsx";

export interface WorldCard {
  world_id: number;
  world_name: string;
  owner_name: string;
  world_type: string;
  description: string;
  current_players: number;
  player_limit: number;
  total_visits: number;
  locked: boolean;
  created_at: number;
  updated_at: number;
  last_visited_at: number | null;
  favorite: boolean;
}

function WorldRow(props: { world: WorldCard; on_join: (name: string) => void; on_favorite?: () => void; actions?: React.ReactNode }) {
  const { world } = props;
  return (
    <article className="world_card">
      <div className={`world_badge world_type_${world.world_type}`}>{world.world_type}</div>
      <div className="world_info">
        <h3>{world.world_name} {world.locked && <span className="lock_tag">locked</span>}</h3>
        <p className="muted">by {world.owner_name}{world.description ? ` — ${world.description}` : ""}</p>
        <p className="world_stats">
          <span className={world.current_players > 0 ? "online_dot" : "offline_dot"} />
          {world.current_players}/{world.player_limit} online · {world.total_visits} visits
          {world.last_visited_at ? <> · visited <TimeAgo time={world.last_visited_at} /></> : null}
        </p>
      </div>
      <div className="world_actions">
        {props.on_favorite && <Button variant="ghost" small onClick={props.on_favorite} aria-label="Favorite">{world.favorite ? "★" : "☆"}</Button>}
        {props.actions}
        <Button small onClick={() => props.on_join(world.world_name)}>Enter</Button>
      </div>
    </article>
  );
}

export function WorldBrowser(props: { on_close: () => void; on_join: (name: string) => void }) {
  const [filter, set_filter] = useState("public");
  const [search, set_search] = useState("");
  const [world_type, set_world_type] = useState("");
  const [query, set_query] = useState({ search: "", world_type: "" });
  const { data, error, reload } = UseAsync(
    () => Api<{ worlds: WorldCard[] }>("GET", `/worlds?filter=${filter}&search=${encodeURIComponent(query.search)}&world_type=${query.world_type}`),
    [filter, query]
  );
  const [direct, set_direct] = useState("");
  return (
    <Panel title="World Browser" on_close={props.on_close} wide>
      <div className="tab_row">
        {[["public", "Public"], ["favorites", "Favorites"], ["recent", "Recent"]].map(([key, label]) => (
          <button key={key} className={filter === key ? "tab tab_active" : "tab"} onClick={() => set_filter(key)}>{label}</button>
        ))}
      </div>
      <form className="toolbar" onSubmit={(event) => { event.preventDefault(); set_query({ search, world_type }); }}>
        <input placeholder="Search worlds" value={search} onChange={(event) => set_search(event.target.value)} maxLength={16} />
        <select value={world_type} onChange={(event) => set_world_type(event.target.value)}>
          <option value="">All types</option>
          {WORLD_TYPES.filter((type) => type !== "private").map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <Button type="submit" small>Search</Button>
        <Button type="button" variant="secondary" small onClick={reload}>Refresh</Button>
      </form>
      <form className="toolbar" onSubmit={(event) => { event.preventDefault(); if (direct.trim()) props.on_join(direct.trim()); }}>
        <input placeholder="Go to world by name" value={direct} onChange={(event) => set_direct(event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 16))} maxLength={16} />
        <Button type="submit" small variant="secondary">Go</Button>
      </form>
      <ErrorLine message={error} />
      <div className="world_list">
        {data?.worlds.length === 0 && <p className="muted">No worlds here yet.</p>}
        {data?.worlds.map((world) => (
          <WorldRow key={world.world_id} world={world} on_join={props.on_join} on_favorite={async () => { await Api("POST", `/worlds/${world.world_id}/favorite`); reload(); }} />
        ))}
      </div>
    </Panel>
  );
}

export function CreateWorldPanel(props: { on_close: () => void; on_created: (name: string) => void; initial_name?: string }) {
  const [form, set_form] = useState({ world_name: props.initial_name ?? "", world_type: "public", description: "", world_size: "medium", seed: "" });
  const [error, set_error] = useState<string | null>(null);
  const [busy, set_busy] = useState(false);
  const Submit = async (event: React.FormEvent) => {
    event.preventDefault();
    set_busy(true);
    set_error(null);
    try {
      const result = await Api<{ world: WorldCard }>("POST", "/worlds", { ...form, seed: form.seed === "" ? undefined : Number(form.seed) });
      store.Toast("success", `World ${result.world.world_name} created!`);
      props.on_created(result.world.world_name);
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Could not create world.");
    } finally {
      set_busy(false);
    }
  };
  return (
    <Panel title="Create World" on_close={props.on_close}>
      <form className="form_grid" onSubmit={Submit}>
        <label className="field">World name
          <input value={form.world_name} onChange={(event) => set_form({ ...form, world_name: event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 16) })} required minLength={1} maxLength={16} pattern="[A-Z]{1,16}" placeholder="SUNNYMEADOW" />
          <small className="hint">1-16 letters (A-Z). Names are unique.</small>
        </label>
        <label className="field">World type
          <select value={form.world_type} onChange={(event) => set_form({ ...form, world_type: event.target.value })}>
            {WORLD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label className="field">Size
          <select value={form.world_size} onChange={(event) => set_form({ ...form, world_size: event.target.value })}>
            <option value="small">Small (100×60)</option>
            <option value="medium">Medium (150×80)</option>
            <option value="large">Large (200×100)</option>
          </select>
        </label>
        <label className="field">Seed (optional)
          <input value={form.seed} onChange={(event) => set_form({ ...form, seed: event.target.value.replace(/\D/g, "").slice(0, 10) })} placeholder="random" inputMode="numeric" />
        </label>
        <label className="field field_wide">Description (optional)
          <textarea value={form.description} onChange={(event) => set_form({ ...form, description: event.target.value })} maxLength={200} rows={2} />
        </label>
        <ErrorLine message={error} />
        <Button type="submit" disabled={busy}>{busy ? "Generating…" : "Create"}</Button>
      </form>
    </Panel>
  );
}

export function MyWorlds(props: { on_close: () => void; on_join: (name: string) => void; on_manage: (world_id: number) => void; on_create: () => void }) {
  const { data, error, reload } = UseAsync(() => Api<{ worlds: WorldCard[] }>("GET", "/worlds?filter=mine"), []);
  const invitations = UseAsync(() => Api<{ invitations: { invitation_id: number; world_name: string; inviter_name: string; created_at: number }[] }>("GET", "/invitations"), []);
  const [deleting, set_deleting] = useState<WorldCard | null>(null);
  const [confirm_name, set_confirm_name] = useState("");
  const [delete_error, set_delete_error] = useState<string | null>(null);
  const Delete = async () => {
    if (!deleting) return;
    try {
      await Api("DELETE", `/worlds/${deleting.world_id}`, { confirm_name });
      store.Toast("info", `${deleting.world_name} was deleted.`);
      set_deleting(null);
      set_confirm_name("");
      reload();
    } catch (caught) {
      set_delete_error(caught instanceof Error ? caught.message : "Delete failed.");
    }
  };
  return (
    <Panel title="My Worlds" on_close={props.on_close} wide>
      <div className="toolbar"><Button onClick={props.on_create}>+ Create World</Button></div>
      <ErrorLine message={error} />
      {invitations.data && invitations.data.invitations.length > 0 && (
        <div className="sub_section">
          <h3>Invitations</h3>
          {invitations.data.invitations.map((invite) => (
            <div key={invite.invitation_id} className="row_line">
              <span><b>{invite.world_name}</b> from {invite.inviter_name}</span>
              <span>
                <Button small onClick={async () => { await Api("POST", `/invitations/${invite.invitation_id}`, { accept: true }); invitations.reload(); props.on_join(invite.world_name); }}>Accept & go</Button>
                <Button small variant="ghost" onClick={async () => { await Api("POST", `/invitations/${invite.invitation_id}`, { accept: false }); invitations.reload(); }}>Decline</Button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="world_list">
        {data?.worlds.length === 0 && <p className="muted">You have not created a world yet.</p>}
        {data?.worlds.map((world) => (
          <WorldRow key={world.world_id} world={world} on_join={props.on_join}
            actions={<>
              <Button small variant="secondary" onClick={() => props.on_manage(world.world_id)}>Manage</Button>
              <Button small variant="danger" onClick={() => { set_deleting(world); set_delete_error(null); }}>Delete</Button>
            </>}
          />
        ))}
      </div>
      {deleting && (
        <div className="confirm_box">
          <p>Delete <b>{deleting.world_name}</b> forever? Everything built there is lost. Type the name to confirm.</p>
          <input value={confirm_name} onChange={(event) => set_confirm_name(event.target.value.toUpperCase())} placeholder={deleting.world_name} />
          <ErrorLine message={delete_error} />
          <div className="toolbar">
            <Button variant="danger" disabled={confirm_name !== deleting.world_name} onClick={Delete}>Delete world</Button>
            <Button variant="ghost" onClick={() => set_deleting(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function WorldManagePanel(props: { world_id: number; on_close: () => void }) {
  const world = UseAsync(() => Api<{ world: any; access: any }>("GET", `/worlds/${props.world_id}`), [props.world_id]);
  const permissions = UseAsync(() => Api<{ permissions: any[]; invitations: any[] }>("GET", `/worlds/${props.world_id}/permissions`), [props.world_id]);
  const [error, set_error] = useState<string | null>(null);
  const [edit, set_edit] = useState<Record<string, any> | null>(null);
  const [role_form, set_role_form] = useState({ username: "", role: "builder" });
  const [invite_name, set_invite_name] = useState("");
  const [kick_name, set_kick_name] = useState("");
  const current = world.data?.world;
  const form = edit ?? (current ? {
    world_name: current.world_name, description: current.description, world_type: current.world_type, player_limit: current.player_limit,
    locked: current.locked, background: current.background, settings: current.settings
  } : null);

  const Run = async (work: () => Promise<unknown>, success: string) => {
    set_error(null);
    try {
      await work();
      store.Toast("success", success);
      world.reload();
      permissions.reload();
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Failed.");
    }
  };

  if (!form) return <Panel title="Manage World" on_close={props.on_close}><ErrorLine message={world.error} /><p className="muted">Loading…</p></Panel>;
  const is_owner = world.data?.access.role === "owner";
  const Toggle = (key: string, label: string) => (
    <label className="check_field">
      <input type="checkbox" checked={!!form.settings[key]} onChange={(event) => set_edit({ ...form, settings: { ...form.settings, [key]: event.target.checked } })} />
      {label}
    </label>
  );
  return (
    <Panel title={`Manage ${current.world_name}`} on_close={props.on_close} wide>
      <ErrorLine message={error} />
      <div className="manage_grid">
        <section className="sub_section">
          <h3>Details</h3>
          <label className="field">Name {!is_owner && <small>(owner only)</small>}
            <input value={form.world_name} disabled={!is_owner} onChange={(event) => set_edit({ ...form, world_name: event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 16) })} maxLength={16} />
          </label>
          <label className="field">Description
            <textarea value={form.description} onChange={(event) => set_edit({ ...form, description: event.target.value })} maxLength={200} rows={2} />
          </label>
          <label className="field">Type
            <select value={form.world_type} onChange={(event) => set_edit({ ...form, world_type: event.target.value })}>
              {WORLD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <label className="field">Sky
            <select value={form.background} onChange={(event) => set_edit({ ...form, background: event.target.value })}>
              {BACKGROUNDS.map((background) => <option key={background} value={background}>{background}</option>)}
            </select>
          </label>
          <label className="field">Player limit
            <input type="number" min={1} max={100} value={form.player_limit} onChange={(event) => set_edit({ ...form, player_limit: Number(event.target.value) })} />
          </label>
          {current.seed !== undefined && <p className="muted">Seed: {current.seed}</p>}
        </section>
        <section className="sub_section">
          <h3>Rules</h3>
          <label className="check_field"><input type="checkbox" checked={!!form.locked} onChange={(event) => set_edit({ ...form, locked: event.target.checked })} />Locked (only builders+ may enter)</label>
          {Toggle("members_can_build", "Members can build")}
          {Toggle("visitors_can_build", "Visitors can build")}
          {Toggle("allow_drops", "Item drops on the ground")}
          {Toggle("chat_enabled", "World chat enabled")}
          <p className="hint">Spawn point: stand where you want it and type /setspawn in chat.</p>
          <div className="toolbar">
            <Button onClick={() => Run(() => Api("PATCH", `/worlds/${props.world_id}`, edit ?? {}).then(() => set_edit(null)), "World saved.")}>Save changes</Button>
            <Button variant="secondary" onClick={() => Run(() => Api("PATCH", `/worlds/${props.world_id}`, { reset_settings: true }).then(() => set_edit(null)), "Rules reset to defaults.")}>Reset rules</Button>
          </div>
        </section>
        <section className="sub_section">
          <h3>Permissions</h3>
          <form className="toolbar" onSubmit={(event) => { event.preventDefault(); void Run(() => Api("POST", `/worlds/${props.world_id}/permissions`, role_form), `${role_form.username} is now ${role_form.role}.`); }}>
            <input placeholder="Player name" value={role_form.username} onChange={(event) => set_role_form({ ...role_form, username: event.target.value })} required />
            <select value={role_form.role} onChange={(event) => set_role_form({ ...role_form, role: event.target.value })}>
              {(is_owner ? ["admin", "builder", "member", "visitor", "banned"] : ["builder", "member", "visitor", "banned"]).map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
            <Button small type="submit">Set</Button>
          </form>
          <div className="mini_table">
            {permissions.data?.permissions.length === 0 && <p className="muted">Everyone else is a visitor.</p>}
            {permissions.data?.permissions.map((entry) => (
              <div key={entry.player_id} className="row_line">
                <span>{entry.username} <span className={`role_tag role_${entry.role}`}>{entry.role}</span></span>
                <Button small variant="ghost" onClick={() => Run(() => Api("POST", `/worlds/${props.world_id}/permissions`, { username: entry.username, role: "visitor" }), "Permission removed.")}>Remove</Button>
              </div>
            ))}
          </div>
        </section>
        <section className="sub_section">
          <h3>Invite & kick</h3>
          <form className="toolbar" onSubmit={(event) => { event.preventDefault(); void Run(() => Api("POST", `/worlds/${props.world_id}/invite`, { username: invite_name }), `Invited ${invite_name}.`); }}>
            <input placeholder="Invite player" value={invite_name} onChange={(event) => set_invite_name(event.target.value)} required />
            <Button small type="submit">Invite</Button>
          </form>
          <div className="mini_table">
            {permissions.data?.invitations.map((invite) => (
              <div key={invite.invitation_id} className="row_line">
                <span>{invite.username} <span className="muted">{invite.status}</span></span>
                {invite.status === "pending" && <Button small variant="ghost" onClick={() => Run(() => Api("POST", `/worlds/${props.world_id}/invitations/${invite.invitation_id}/revoke`), "Invitation revoked.")}>Revoke</Button>}
              </div>
            ))}
          </div>
          <form className="toolbar" onSubmit={(event) => { event.preventDefault(); void Run(() => Api("POST", `/worlds/${props.world_id}/kick`, { username: kick_name }), `Kicked ${kick_name}.`); }}>
            <input placeholder="Kick player" value={kick_name} onChange={(event) => set_kick_name(event.target.value)} required />
            <Button small variant="danger" type="submit">Kick</Button>
          </form>
        </section>
      </div>
    </Panel>
  );
}
