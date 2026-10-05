import React, { useEffect, useState } from "react";
import { COSMETICS, type CosmeticSlot, type Appearance } from "../../shared/cosmetics.ts";
import { GetItem } from "../../shared/items.ts";
import { Api } from "../services/api.ts";
import { game_socket } from "../services/socket.ts";
import { store, UseStore } from "../state/store.ts";
import { audio } from "../audio/audio_engine.ts";
import { ui_settings, UseUiSettings, type ControlSize } from "../state/ui_settings.ts";
import { Avatar, Button, Coins, ErrorLine, ItemIcon, Panel, TimeAgo, UseAsync } from "../components/ui.tsx";

function Progress(props: { value: number; goal: number }) {
  return (
    <div className="progress_bar" role="progressbar" aria-valuenow={props.value} aria-valuemax={props.goal}>
      <div style={{ width: `${Math.min(100, (props.value / props.goal) * 100)}%` }} />
      <span>{props.value.toLocaleString()}/{props.goal.toLocaleString()}</span>
    </div>
  );
}

export function QuestsPanel(props: { on_close: () => void }) {
  const [tab, set_tab] = useState<"quests" | "achievements" | "activities" | "events">("quests");
  const quests = UseAsync(() => Api<{ quests: any[] }>("GET", "/quests"), [tab]);
  const achievements = UseAsync(() => Api<{ achievements: any[] }>("GET", "/achievements"), [tab]);
  const events = UseStore((state) => state.events);
  const [error, set_error] = useState<string | null>(null);
  const [trivia, set_trivia] = useState<{ question: string; answers: string[] } | null>(null);
  const [trivia_result, set_trivia_result] = useState<string | null>(null);

  const Claim = async (quest_key: string) => {
    set_error(null);
    try {
      await Api("POST", "/quests/claim", { quest_key });
      quests.reload();
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Failed.");
    }
  };
  const AskTrivia = async () => {
    set_error(null);
    set_trivia_result(null);
    try {
      set_trivia(await Api("GET", "/trivia"));
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Failed.");
    }
  };
  const Answer = async (answer_index: number) => {
    const result = await Api<{ correct: boolean; correct_index: number; coins: number; expired: boolean }>("POST", "/trivia/answer", { answer_index });
    set_trivia_result(result.expired ? "Too slow! The question expired." : result.correct ? `Correct! +${result.coins} coins, +30 XP` : `Not quite — it was "${trivia?.answers[result.correct_index]}".`);
    audio.Play(result.correct ? "quest" : "error");
    set_trivia(null);
  };

  return (
    <Panel title="Journal" on_close={props.on_close} wide>
      <div className="tab_row">
        {(["quests", "achievements", "activities", "events"] as const).map((key) => <button key={key} className={tab === key ? "tab tab_active" : "tab"} onClick={() => set_tab(key)}>{key[0].toUpperCase() + key.slice(1)}</button>)}
      </div>
      <ErrorLine message={error} />
      {tab === "quests" && (
        <div className="card_list">
          {quests.data?.quests.map((quest) => (
            <article key={quest.quest_key} className={`quest_card ${quest.claimed ? "quest_done" : ""}`}>
              <div>
                <h3>{quest.name}</h3>
                <p className="muted">{quest.description}</p>
                <Progress value={quest.progress} goal={quest.goal} />
                <p className="reward_line">Reward: {quest.reward_text}</p>
              </div>
              {quest.claimed ? <span className="status_tag status_sold">Claimed</span> : <Button small disabled={!quest.completed} onClick={() => Claim(quest.quest_key)}>Claim</Button>}
            </article>
          ))}
        </div>
      )}
      {tab === "achievements" && (
        <div className="card_list achievement_grid">
          {achievements.data?.achievements.map((achievement) => (
            <article key={achievement.achievement_key} className={`achievement_card ${achievement.unlocked_at ? "achievement_unlocked" : ""}`}>
              <div className="achievement_medal">{achievement.unlocked_at ? "★" : "☆"}</div>
              <div>
                <h3>{achievement.name}</h3>
                <p className="muted">{achievement.description}</p>
                {!achievement.unlocked_at && <Progress value={achievement.progress} goal={achievement.goal} />}
                <p className="reward_line">{achievement.unlocked_at ? <>Unlocked <TimeAgo time={achievement.unlocked_at} /></> : `Reward: ${achievement.reward_text}`}</p>
              </div>
            </article>
          ))}
        </div>
      )}
      {tab === "activities" && (
        <div className="card_list">
          <article className="quest_card">
            <div>
              <h3>Trivia Stone</h3>
              <p className="muted">Answer a question about the realm for 40 coins and 30 XP. One question every 30 seconds.</p>
              {trivia && (
                <div className="trivia_box">
                  <p><b>{trivia.question}</b></p>
                  <div className="toolbar">{trivia.answers.map((answer, index) => <Button key={answer} small variant="secondary" onClick={() => Answer(index)}>{answer}</Button>)}</div>
                </div>
              )}
              {trivia_result && <p className="reward_line">{trivia_result}</p>}
            </div>
            {!trivia && <Button small onClick={AskTrivia}>Ask</Button>}
          </article>
          <article className="quest_card"><div><h3>Fishing</h3><p className="muted">Craft or buy a Reed Fishing Rod, then click Still Water in any world. Rare Star Eels sell well.</p></div></article>
          <article className="quest_card"><div><h3>Treasure hunting</h3><p className="muted">Buried Chests hide deep in the stone of every world. Break one for coins and a chance at Moon Shards.</p></div></article>
          <article className="quest_card"><div><h3>Exploration</h3><p className="muted">Whispering Shrines lie in deep caves. Click one to record the discovery for coins and XP.</p></div></article>
        </div>
      )}
      {tab === "events" && (
        <div className="card_list">
          {events.length === 0 && <p className="muted">No events running right now. Admins start events like Double XP or the Meteor Shower.</p>}
          {events.map((event) => (
            <article key={event.event_id} className="quest_card event_card">
              <div><h3>{event.name}</h3><p className="muted">{event.description}</p><p className="reward_line">Ends {new Date(event.ends_at).toLocaleString()}</p></div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}

const SLOT_LABELS: Record<CosmeticSlot, string> = { hair: "Hair", hat: "Hat", shirt: "Shirt", pants: "Pants", shoes: "Shoes", accessory: "Accessory", title: "Title" };

export function ProfilePanel(props: { on_close: () => void }) {
  const profile = UseAsync(() => Api<any>("GET", "/player"), []);
  const cosmetics = UseAsync(() => Api<{ owned: string[] }>("GET", "/cosmetics"), []);
  const player = UseStore((state) => state.player);
  const [preview, set_preview] = useState<Appearance | null>(null);
  const [error, set_error] = useState<string | null>(null);
  const appearance = preview ?? player?.appearance ?? {};
  const owned = new Set(cosmetics.data?.owned ?? []);
  if (!player) return null;
  const stats = profile.data?.stats ?? {};
  const Save = async () => {
    set_error(null);
    try {
      const result = await Api<{ appearance: Appearance }>("POST", "/cosmetics/equip", { appearance });
      store.Set({ player: { ...player, appearance: result.appearance } });
      set_preview(null);
      store.Toast("success", "Outfit saved.");
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Failed.");
    }
  };
  const Buy = async (cosmetic_key: string) => {
    set_error(null);
    try {
      await Api("POST", "/cosmetics/buy", { cosmetic_key });
      cosmetics.reload();
      audio.Play("market");
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Failed.");
    }
  };
  const playtime = profile.data?.playtime_seconds ?? 0;
  return (
    <Panel title="Profile & Wardrobe" on_close={props.on_close} wide>
      <div className="profile_layout">
        <section className="profile_card">
          <Avatar appearance={appearance} size={128} />
          <h3>{player.username}</h3>
          <p>Level {player.level} · <Coins amount={player.coins} /></p>
          <Progress value={player.xp_into_level} goal={player.xp_needed} />
          <dl className="stat_list">
            <dt>Playtime</dt><dd>{Math.floor(playtime / 3600)}h {Math.floor((playtime % 3600) / 60)}m</dd>
            <dt>Lifetime XP</dt><dd>{player.lifetime_xp.toLocaleString()}</dd>
            {[["worlds_created", "Worlds created"], ["worlds_visited", "Worlds visited"], ["blocks_broken", "Blocks broken"], ["blocks_placed", "Blocks placed"],
              ["items_collected", "Items collected"], ["trees_planted", "Trees planted"], ["trees_harvested", "Trees harvested"], ["items_crafted", "Items crafted"],
              ["fish_caught", "Fish caught"], ["trades_completed", "Trades"], ["coins_earned", "Coins earned"]].map(([key, label]) => (
              <React.Fragment key={key}><dt>{label}</dt><dd>{(stats[key] ?? 0).toLocaleString()}</dd></React.Fragment>
            ))}
          </dl>
          <h4>Achievements ({profile.data?.achievements.length ?? 0})</h4>
          <p className="muted">{profile.data?.achievements.map((entry: any) => entry.name).join(", ") || "None yet."}</p>
        </section>
        <section className="wardrobe">
          <ErrorLine message={error} />
          {(Object.keys(SLOT_LABELS) as CosmeticSlot[]).map((slot) => (
            <div key={slot} className="wardrobe_row">
              <h4>{SLOT_LABELS[slot]}</h4>
              <div className="cosmetic_options">
                {(slot === "hat" || slot === "accessory") && (
                  <button className={`cosmetic_chip ${!appearance[slot] ? "chip_active" : ""}`} onClick={() => set_preview({ ...appearance, [slot]: undefined })}>None</button>
                )}
                {COSMETICS.filter((cosmetic) => cosmetic.slot === slot).map((cosmetic) => {
                  const has = owned.has(cosmetic.cosmetic_key);
                  return (
                    <button key={cosmetic.cosmetic_key} className={`cosmetic_chip ${appearance[slot] === cosmetic.cosmetic_key ? "chip_active" : ""} ${has ? "" : "chip_locked"}`}
                      onClick={() => (has ? set_preview({ ...appearance, [slot]: cosmetic.cosmetic_key }) : cosmetic.price > 0 && Buy(cosmetic.cosmetic_key))}
                      title={has ? cosmetic.name : cosmetic.price > 0 ? `Buy for ${cosmetic.price} coins` : "Earned through quests and achievements"}>
                      <span className="chip_swatch" style={{ background: cosmetic.color }} />
                      {cosmetic.name}
                      {!has && <small>{cosmetic.price > 0 ? ` ${cosmetic.price}c` : " 🔒"}</small>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="hint">Cosmetics are visual only. Locked titles and items come from quests and achievements.</p>
          <div className="toolbar">
            <Button disabled={!preview} onClick={Save}>Save outfit</Button>
            {preview && <Button variant="ghost" onClick={() => set_preview(null)}>Revert</Button>}
          </div>
        </section>
      </div>
    </Panel>
  );
}

export function FriendsPanel(props: { on_close: () => void; on_visit: (world_name: string) => void }) {
  const friends = UseAsync(() => Api<{ friends: any[] }>("GET", "/friends"), []);
  const blocked = UseAsync(() => Api<{ blocked: any[] }>("GET", "/blocks"), []);
  const [name, set_name] = useState("");
  const [report, set_report] = useState({ username: "", reason: "" });
  const [error, set_error] = useState<string | null>(null);
  const Run = async (work: () => Promise<unknown>, success: string) => {
    set_error(null);
    try {
      await work();
      store.Toast("success", success);
      friends.reload();
      blocked.reload();
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Failed.");
    }
  };
  useEffect(() => {
    const timer = setInterval(friends.reload, 15_000);
    return () => clearInterval(timer);
  }, []);
  const list = friends.data?.friends ?? [];
  return (
    <Panel title="Friends" on_close={props.on_close} wide>
      <ErrorLine message={error} />
      <form className="toolbar" onSubmit={(event) => { event.preventDefault(); void Run(() => Api("POST", "/friends/request", { username: name }), `Friend request sent to ${name}.`); }}>
        <input placeholder="Player name" value={name} onChange={(event) => set_name(event.target.value)} required />
        <Button small type="submit">Add friend</Button>
        <Button small type="button" variant="secondary" onClick={() => name && game_socket.Send("trade_request", { username: name })}>Trade</Button>
        <Button small type="button" variant="secondary" onClick={() => name && Run(() => Api("POST", "/blocks", { username: name, blocked: true }), `${name} is blocked.`)}>Block</Button>
      </form>
      <div className="mini_table">
        {list.length === 0 && <p className="muted">No friends yet. Add someone you met in a world!</p>}
        {list.map((friend) => (
          <div key={friend.player_id} className="row_line">
            <span>
              <span className={friend.online ? "online_dot" : "offline_dot"} />
              <b>{friend.username}</b> <span className="muted">lv {friend.level}</span>
              {friend.status === "pending" && <span className="muted"> · {friend.direction === "incoming" ? "wants to be friends" : "request sent"}</span>}
              {friend.current_world && <span className="muted"> · in {friend.current_world}</span>}
            </span>
            <span className="toolbar">
              {friend.status === "pending" && friend.direction === "incoming" && <>
                <Button small onClick={() => Run(() => Api("POST", "/friends/respond", { username: friend.username, accept: true }), "Friend added!")}>Accept</Button>
                <Button small variant="ghost" onClick={() => Run(() => Api("POST", "/friends/respond", { username: friend.username, accept: false }), "Declined.")}>Decline</Button>
              </>}
              {friend.current_world && <Button small onClick={() => props.on_visit(friend.current_world)}>Visit</Button>}
              {friend.online && <Button small variant="secondary" onClick={() => game_socket.Send("trade_request", { username: friend.username })}>Trade</Button>}
              {friend.status === "accepted" && <Button small variant="ghost" onClick={() => Run(() => Api("POST", "/friends/remove", { username: friend.username }), "Friend removed.")}>Remove</Button>}
            </span>
          </div>
        ))}
      </div>
      <div className="sub_section">
        <h3>Blocked players</h3>
        {blocked.data?.blocked.length === 0 && <p className="muted">Nobody blocked.</p>}
        {blocked.data?.blocked.map((entry) => (
          <div key={entry.player_id} className="row_line"><span>{entry.username}</span><Button small variant="ghost" onClick={() => Run(() => Api("POST", "/blocks", { username: entry.username, blocked: false }), "Unblocked.")}>Unblock</Button></div>
        ))}
      </div>
      <form className="sub_section" onSubmit={(event) => { event.preventDefault(); void Run(() => Api("POST", "/reports", report), "Report sent to the moderators."); }}>
        <h3>Report a player</h3>
        <div className="toolbar">
          <input placeholder="Player name" value={report.username} onChange={(event) => set_report({ ...report, username: event.target.value })} required />
          <input placeholder="What happened?" value={report.reason} onChange={(event) => set_report({ ...report, reason: event.target.value })} required minLength={3} maxLength={300} />
          <Button small variant="danger" type="submit">Report</Button>
        </div>
      </form>
    </Panel>
  );
}

export function SettingsPanel(props: { on_close: () => void; on_logout: () => void; logged_in?: boolean }) {
  const [, force] = useState(0);
  useEffect(() => audio.Subscribe(() => force((value) => value + 1)), []);
  const settings = audio.settings;
  const ui = UseUiSettings();
  const Save = (patch: Partial<typeof settings>) => {
    audio.Update(patch);
    void Api("POST", "/player/settings", { settings: { ...audio.settings } }).catch(() => undefined);
  };
  const Slider = (key: "master_volume" | "music_volume" | "sfx_volume", label: string) => (
    <label className="field">{label} ({Math.round(settings[key] * 100)}%)
      <input type="range" min={0} max={1} step={0.05} value={settings[key]} onChange={(event) => Save({ [key]: Number(event.target.value) })} />
    </label>
  );
  return (
    <Panel title="Settings" on_close={props.on_close}>
      <div className="form_grid">
        {Slider("master_volume", "Master volume")}
        {Slider("music_volume", "Music volume")}
        {Slider("sfx_volume", "Effects volume")}
        <label className="check_field"><input type="checkbox" checked={settings.muted} onChange={(event) => Save({ muted: event.target.checked })} />Mute all</label>
        <div className="sub_section">
          <h3>Music</h3>
          <p className="muted">Now playing: {audio.track_name}</p>
          <div className="toolbar">
            <Button small onClick={() => { audio.Unlock(); if (audio.playing) Save({ music_enabled: false }); else Save({ music_enabled: true }); }}>{audio.playing ? "Pause" : "Play"}</Button>
            <Button small variant="secondary" onClick={() => audio.NextTrack()}>Next track</Button>
          </div>
        </div>
        <div className="sub_section">
          <h3>On-screen buttons</h3>
          <label className="field">Button size preset
            <select value={ui.control_size} onChange={(event) => ui_settings.Update({ control_size: event.target.value as ControlSize })}>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
              <option value="extra_large">Extra large</option>
            </select>
          </label>
        </div>
        <div className="sub_section">
          <h3>Controls</h3>
          <p className="muted">A/D or ←/→ move · W/Space jump · Left click break/harvest/fish · Right click place/inspect · F or the round button punches/places in front of you · 0 fist · 1-9 hotbar · Esc menu · E inventory · C craft · Enter chat · Esc close</p>
        </div>
        {props.logged_in !== false && <Button variant="danger" onClick={props.on_logout}>Log out</Button>}
      </div>
    </Panel>
  );
}

export function TradeWindow() {
  const trade = UseStore((state) => state.trade);
  const invite = UseStore((state) => state.trade_invite);
  const me = UseStore((state) => state.player);
  const inventory = UseStore((state) => state.inventory);
  const [offer, set_offer] = useState<{ item_id: number; quantity: number }[]>([]);
  const [coins, set_coins] = useState(0);
  const [picker, set_picker] = useState({ item_id: 0, quantity: 1 });

  useEffect(() => {
    if (!trade) {
      set_offer([]);
      set_coins(0);
    }
  }, [trade?.trade_id]);

  if (invite && !trade) {
    return (
      <div className="trade_invite pixel_panel">
        <p><b>{invite.from_username}</b> wants to trade.</p>
        <div className="toolbar">
          <Button small onClick={() => game_socket.Send("trade_respond", { trade_id: invite.trade_id, accept: true })}>Accept</Button>
          <Button small variant="ghost" onClick={() => { game_socket.Send("trade_respond", { trade_id: invite.trade_id, accept: false }); store.Set({ trade_invite: null }); }}>Decline</Button>
        </div>
      </div>
    );
  }
  if (!trade || !me) return null;
  const mine = trade.sides.find((side) => side.player_id === me.player_id)!;
  const theirs = trade.sides.find((side) => side.player_id !== me.player_id)!;
  const totals = new Map<number, number>();
  for (const slot of inventory) totals.set(slot.item_id, (totals.get(slot.item_id) ?? 0) + slot.quantity);
  const Push = (items: typeof offer, coin_amount: number) => game_socket.Send("trade_offer", { trade_id: trade.trade_id, items, coins: coin_amount });
  const SideView = (side: typeof mine, label: string) => (
    <div className={`trade_side ${side.confirmed ? "trade_side_ready" : ""}`}>
      <h3>{label} {side.confirmed && <span className="status_tag status_sold">Ready</span>}</h3>
      <div className="trade_items">
        {side.items.length === 0 && side.coins === 0 && <p className="muted">Nothing offered.</p>}
        {side.items.map((item) => <span key={item.item_id} className="trade_item"><ItemIcon item_id={item.item_id} quantity={item.quantity} />{GetItem(item.item_id)?.name}</span>)}
        {side.coins > 0 && <span className="trade_item"><Coins amount={side.coins} /></span>}
      </div>
    </div>
  );
  return (
    <div className="panel_backdrop">
      <section className="pixel_panel trade_window" role="dialog" aria-label="Trade">
        <header className="panel_header"><h2>Trading with {theirs.username}</h2></header>
        <div className="trade_columns">
          {SideView(mine, "Your offer")}
          {SideView(theirs, `${theirs.username}'s offer`)}
        </div>
        {trade.status === "locked" ? <p className="hint">Completing trade…</p> : (
          <>
            <div className="toolbar">
              <select value={picker.item_id} onChange={(event) => set_picker({ ...picker, item_id: Number(event.target.value) })}>
                <option value={0}>Choose item…</option>
                {[...totals.entries()].map(([item_id, total]) => <option key={item_id} value={item_id}>{GetItem(item_id)?.name} ({total})</option>)}
              </select>
              <input className="tiny_input" type="number" min={1} value={picker.quantity} onChange={(event) => set_picker({ ...picker, quantity: Math.max(1, Math.floor(Number(event.target.value) || 1)) })} />
              <Button small disabled={!picker.item_id} onClick={() => {
                const next = [...offer.filter((item) => item.item_id !== picker.item_id), { item_id: picker.item_id, quantity: Math.min(picker.quantity, totals.get(picker.item_id) ?? 0) }];
                set_offer(next);
                Push(next, coins);
              }}>Add</Button>
              <Button small variant="ghost" onClick={() => { set_offer([]); Push([], coins); }}>Clear items</Button>
            </div>
            <div className="toolbar">
              <label className="inline_field">Coins
                <input type="number" min={0} max={me.coins} value={coins} onChange={(event) => set_coins(Math.max(0, Math.min(me.coins, Math.floor(Number(event.target.value) || 0))))} />
              </label>
              <Button small variant="secondary" onClick={() => Push(offer, coins)}>Update coins</Button>
            </div>
            <p className="hint">Any change resets both confirmations. Check the other offer before accepting.</p>
            <div className="toolbar">
              <Button disabled={mine.confirmed} onClick={() => game_socket.Send("trade_confirm", { trade_id: trade.trade_id })}>{mine.confirmed ? "Waiting for partner…" : "Accept trade"}</Button>
              <Button variant="danger" onClick={() => game_socket.Send("trade_cancel", { trade_id: trade.trade_id })}>Cancel</Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export function NotificationsPanel(props: { on_close: () => void }) {
  const notifications = UseAsync(() => Api<{ notifications: any[] }>("GET", "/notifications"), []);
  useEffect(() => {
    void Api("POST", "/notifications/read").then(() => store.Set({ unread_notifications: 0 }));
  }, []);
  return (
    <Panel title="Notifications" on_close={props.on_close}>
      <div className="mini_table">
        {notifications.data?.notifications.length === 0 && <p className="muted">Nothing yet.</p>}
        {notifications.data?.notifications.map((entry) => (
          <div key={entry.notification_id} className={`row_line ${entry.read_at ? "" : "unread_row"}`}>
            <span>{entry.message}</span>
            <small className="muted"><TimeAgo time={entry.created_at} /></small>
          </div>
        ))}
      </div>
    </Panel>
  );
}
