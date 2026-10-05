import React, { useMemo, useState } from "react";
import { GetItem, ITEM_LIST } from "../../shared/items.ts";
import { INVENTORY_SLOTS, HOTBAR_SLOTS, MARKET_FEE_RATE } from "../../shared/constants.ts";
import type { RecipeDefinition } from "../../shared/recipes.ts";
import { Api, RequestId } from "../services/api.ts";
import { game_socket } from "../services/socket.ts";
import { store, UseStore } from "../state/store.ts";
import { audio } from "../audio/audio_engine.ts";
import { Button, Coins, ErrorLine, ItemIcon, Panel, TimeAgo, UseAsync } from "../components/ui.tsx";

function UseAction() {
  const [error, set_error] = useState<string | null>(null);
  const [busy, set_busy] = useState(false);
  const Run = async (work: () => Promise<unknown>, success?: string, sound?: Parameters<typeof audio.Play>[0]) => {
    set_error(null);
    set_busy(true);
    try {
      await work();
      if (success) store.Toast("success", success);
      if (sound) audio.Play(sound);
    } catch (caught) {
      set_error(caught instanceof Error ? caught.message : "Failed.");
      audio.Play("error");
    } finally {
      set_busy(false);
    }
  };
  return { error, busy, Run };
}

export function InventoryPanel(props: { on_close: () => void; in_world: boolean }) {
  const inventory = UseStore((state) => state.inventory);
  const selected_slot = UseStore((state) => state.selected_slot);
  const [focus, set_focus] = useState<number | null>(null);
  const [drag_from, set_drag_from] = useState<number | null>(null);
  const [amount, set_amount] = useState(1);
  const [list_price, set_list_price] = useState(10);
  const { error, busy, Run } = UseAction();
  const by_slot = new Map(inventory.map((slot) => [slot.slot_index, slot]));
  const focused = focus !== null ? by_slot.get(focus) : undefined;
  const focused_item = focused ? GetItem(focused.item_id) : undefined;

  const Move = (from: number, to: number) => Run(() => Api("POST", "/inventory/move", { from_slot: from, to_slot: to }));

  const Slot = (slot_index: number) => {
    const slot = by_slot.get(slot_index);
    return (
      <button
        key={slot_index}
        className={`inventory_slot ${focus === slot_index ? "slot_focus" : ""} ${slot_index === selected_slot ? "slot_selected" : ""}`}
        draggable={!!slot}
        onDragStart={() => set_drag_from(slot_index)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={() => {
          if (drag_from !== null && drag_from !== slot_index) void Move(drag_from, slot_index);
          set_drag_from(null);
        }}
        onClick={() => {
          // Tap-to-move for touch screens: tap a filled slot, then tap a target.
          if (focus !== null && focus !== slot_index && by_slot.get(focus) && !slot) {
            void Move(focus, slot_index);
            set_focus(null);
            return;
          }
          set_focus(slot ? slot_index : null);
          set_amount(1);
          if (slot_index < HOTBAR_SLOTS) store.Set({ selected_slot: slot_index });
        }}
      >
        {slot && <ItemIcon item_id={slot.item_id} quantity={slot.quantity} />}
        {slot_index < HOTBAR_SLOTS && <span className="slot_number">{slot_index + 1}</span>}
      </button>
    );
  };

  return (
    <Panel title="Inventory" on_close={props.on_close} wide>
      <p className="hint">Drag to move or merge stacks. Slots 1-9 are your hotbar. On touch: tap an item, then tap an empty slot.</p>
      <div className="inventory_grid hotbar_row">{Array.from({ length: HOTBAR_SLOTS }, (_, index) => Slot(index))}</div>
      <div className="inventory_grid">{Array.from({ length: INVENTORY_SLOTS - HOTBAR_SLOTS }, (_, index) => Slot(index + HOTBAR_SLOTS))}</div>
      <div className="toolbar">
        <Button small variant="secondary" disabled={busy} onClick={() => Run(() => Api("POST", "/inventory/sort"), "Backpack sorted.")}>Sort backpack</Button>
      </div>
      <ErrorLine message={error} />
      {focused && focused_item && (
        <div className="item_detail">
          <ItemIcon item_id={focused.item_id} size={48} />
          <div>
            <h3 className={`rarity_text_${focused_item.rarity}`}>{focused_item.name}</h3>
            <p className="muted">{focused_item.rarity} {focused_item.kind} · sells for <Coins amount={focused_item.sell_price} /></p>
            {focused_item.description && <p>{focused_item.description}</p>}
            <div className="toolbar">
              <label className="inline_field">Amount
                <input type="number" min={1} max={focused.quantity} value={amount} onChange={(event) => set_amount(Math.max(1, Math.min(focused.quantity, Number(event.target.value) || 1)))} />
              </label>
              {focused_item.kind === "consumable" && <Button small onClick={() => Run(() => Api("POST", "/inventory/use", { slot_index: focused.slot_index }), `Used ${focused_item.name}.`, "pickup")}>Use</Button>}
              {focused.quantity > 1 && <Button small variant="secondary" disabled={amount >= focused.quantity} onClick={() => Run(() => Api("POST", "/inventory/split", { slot_index: focused.slot_index, quantity: amount }))}>Split</Button>}
              {props.in_world && <Button small variant="secondary" onClick={() => { game_socket.Send("item_drop", { slot_index: focused.slot_index, quantity: amount }); set_focus(null); }}>Drop</Button>}
              <Button small variant="secondary" onClick={() => Run(() => Api("POST", "/shop/sell", { item_id: focused.item_id, quantity: amount, request_id: RequestId() }), `Sold for ${focused_item.sell_price * amount} coins.`, "market")}>Sell to shop</Button>
            </div>
            <div className="toolbar">
              <label className="inline_field">Unit price
                <input type="number" min={1} value={list_price} onChange={(event) => set_list_price(Math.max(1, Math.floor(Number(event.target.value) || 1)))} />
              </label>
              <Button small onClick={() => Run(() => Api("POST", "/market/list", { slot_index: focused.slot_index, quantity: amount, unit_price: list_price }), "Listed on the marketplace.", "market")}>List on market</Button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function CraftingPanel(props: { on_close: () => void }) {
  const recipes = UseAsync(() => Api<{ recipes: RecipeDefinition[] }>("GET", "/recipes"), []);
  const inventory = UseStore((state) => state.inventory);
  const level = UseStore((state) => state.player?.level ?? 1);
  const [times, set_times] = useState<Record<string, number>>({});
  const { error, busy, Run } = UseAction();
  const counts = useMemo(() => {
    const map = new Map<number, number>();
    for (const slot of inventory) map.set(slot.item_id, (map.get(slot.item_id) ?? 0) + slot.quantity);
    return map;
  }, [inventory]);
  return (
    <Panel title="Workbench" on_close={props.on_close} wide>
      <ErrorLine message={error} />
      <div className="recipe_list">
        {recipes.data?.recipes.map((recipe) => {
          const count = times[recipe.recipe_id] ?? 1;
          const can_craft = level >= recipe.unlock_level && recipe.ingredients.every((ingredient) => (counts.get(ingredient.item_id) ?? 0) >= ingredient.quantity * count);
          return (
            <article key={recipe.recipe_id} className={`recipe_card ${can_craft ? "" : "recipe_locked"}`}>
              <div className="recipe_result">
                <ItemIcon item_id={recipe.result_item_id} size={40} quantity={recipe.result_quantity * count} />
                <div>
                  <h3>{recipe.name}</h3>
                  {level < recipe.unlock_level && <p className="muted">Unlocks at level {recipe.unlock_level}</p>}
                </div>
              </div>
              <div className="ingredient_row">
                {recipe.ingredients.map((ingredient) => {
                  const have = counts.get(ingredient.item_id) ?? 0;
                  return (
                    <span key={ingredient.item_id} className={have >= ingredient.quantity * count ? "ingredient_ok" : "ingredient_missing"}>
                      <ItemIcon item_id={ingredient.item_id} size={22} /> {have}/{ingredient.quantity * count}
                    </span>
                  );
                })}
              </div>
              <div className="toolbar">
                <input className="tiny_input" type="number" min={1} max={50} value={count} onChange={(event) => set_times({ ...times, [recipe.recipe_id]: Math.max(1, Math.min(50, Number(event.target.value) || 1)) })} />
                <Button small disabled={!can_craft || busy} onClick={() => Run(() => Api("POST", "/craft", { recipe_id: recipe.recipe_id, times: count }), `Crafted ${recipe.name}!`, "craft")}>Craft</Button>
              </div>
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

export function ShopPanel(props: { on_close: () => void }) {
  const shop = UseAsync(() => Api<{ entries: { item_id: number; price: number; daily_limit: number; stock_left: number; sell_price: number }[] }>("GET", "/shop"), []);
  const [search, set_search] = useState("");
  const [category, set_category] = useState("all");
  const [quantities, set_quantities] = useState<Record<number, number>>({});
  const { error, busy, Run } = UseAction();
  const coins = UseStore((state) => state.player?.coins ?? 0);
  const entries = (shop.data?.entries ?? []).filter((entry) => {
    const item = GetItem(entry.item_id)!;
    return (category === "all" || item.kind === category) && item.name.toLowerCase().includes(search.toLowerCase());
  });
  return (
    <Panel title="General Store" on_close={props.on_close} wide>
      <div className="toolbar">
        <input placeholder="Search" value={search} onChange={(event) => set_search(event.target.value)} />
        <select value={category} onChange={(event) => set_category(event.target.value)}>
          {["all", "block", "background", "seed", "tool"].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <span className="spacer" />
        <Coins amount={coins} />
      </div>
      <p className="hint">Stock refreshes daily at 00:00 UTC. Sell items from your inventory.</p>
      <ErrorLine message={error} />
      <div className="shop_grid">
        {entries.map((entry) => {
          const item = GetItem(entry.item_id)!;
          const quantity = quantities[entry.item_id] ?? 1;
          return (
            <article key={entry.item_id} className="shop_card">
              <ItemIcon item_id={entry.item_id} size={40} />
              <h3>{item.name}</h3>
              <p className="muted">{entry.stock_left} left today</p>
              <p><Coins amount={entry.price} /> each</p>
              <div className="toolbar">
                <input className="tiny_input" type="number" min={1} max={Math.max(1, entry.stock_left)} value={quantity} onChange={(event) => set_quantities({ ...quantities, [entry.item_id]: Math.max(1, Math.floor(Number(event.target.value) || 1)) })} />
                <Button small disabled={busy || entry.stock_left < quantity || coins < entry.price * quantity}
                  onClick={() => Run(async () => { await Api("POST", "/shop/buy", { item_id: entry.item_id, quantity, request_id: RequestId() }); shop.reload(); }, `Bought ${quantity}x ${item.name}.`, "market")}>
                  Buy {(entry.price * quantity).toLocaleString()}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

interface Listing {
  listing_id: number;
  seller_id: number;
  seller_name: string;
  item_id: number;
  quantity: number;
  initial_quantity: number;
  unit_price: number;
  status: string;
  created_at: number;
  expires_at: number;
}

export function MarketPanel(props: { on_close: () => void }) {
  const [tab, set_tab] = useState<"browse" | "mine" | "history">("browse");
  const [filters, set_filters] = useState({ search: "", category: "all", sort: "price_asc", seller: "" });
  const [applied, set_applied] = useState(filters);
  const listings = UseAsync(
    () => Api<{ listings: Listing[] }>("GET", `/market?search=${encodeURIComponent(applied.search)}&category=${applied.category}&sort=${applied.sort}&seller=${encodeURIComponent(applied.seller)}`),
    [applied]
  );
  const mine = UseAsync(() => Api<{ listings: Listing[] }>("GET", "/market/mine"), [tab]);
  const history = UseAsync(() => Api<{ history: any[] }>("GET", "/market/history"), [tab]);
  const [quantities, set_quantities] = useState<Record<number, number>>({});
  const { error, busy, Run } = UseAction();
  const me = UseStore((state) => state.player);
  return (
    <Panel title="Player Marketplace" on_close={props.on_close} wide>
      <div className="tab_row">
        {(["browse", "mine", "history"] as const).map((key) => <button key={key} className={tab === key ? "tab tab_active" : "tab"} onClick={() => set_tab(key)}>{{ browse: "Browse", mine: "My listings", history: "History" }[key]}</button>)}
        <span className="spacer" />
        <Coins amount={me?.coins ?? 0} />
      </div>
      <p className="hint">List items from your Inventory. A {MARKET_FEE_RATE * 100}% fee is taken from each sale. Listings expire after 72 hours and unsold items return.</p>
      <ErrorLine message={error} />
      {tab === "browse" && (
        <>
          <form className="toolbar" onSubmit={(event) => { event.preventDefault(); set_applied(filters); }}>
            <input placeholder="Item name" value={filters.search} onChange={(event) => set_filters({ ...filters, search: event.target.value })} />
            <select value={filters.category} onChange={(event) => set_filters({ ...filters, category: event.target.value })}>
              {["all", ...new Set(ITEM_LIST.filter((item) => item.item_id > 0).map((item) => item.kind))].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={filters.sort} onChange={(event) => set_filters({ ...filters, sort: event.target.value })}>
              <option value="price_asc">Cheapest</option>
              <option value="price_desc">Priciest</option>
              <option value="newest">Newest</option>
              <option value="quantity">Most stock</option>
            </select>
            <input placeholder="Seller" value={filters.seller} onChange={(event) => set_filters({ ...filters, seller: event.target.value })} />
            <Button small type="submit">Search</Button>
          </form>
          <div className="listing_table">
            {listings.data?.listings.length === 0 && <p className="muted">No listings match.</p>}
            {listings.data?.listings.map((listing) => {
              const item = GetItem(listing.item_id)!;
              const quantity = Math.min(listing.quantity, quantities[listing.listing_id] ?? 1);
              const own = listing.seller_id === me?.player_id;
              return (
                <div key={listing.listing_id} className="listing_row">
                  <ItemIcon item_id={listing.item_id} />
                  <span className="listing_name">{item.name}<small className="muted"> by {listing.seller_name}</small></span>
                  <span>{listing.quantity} left</span>
                  <span><Coins amount={listing.unit_price} /> ea</span>
                  <input className="tiny_input" type="number" min={1} max={listing.quantity} value={quantity} onChange={(event) => set_quantities({ ...quantities, [listing.listing_id]: Math.max(1, Math.floor(Number(event.target.value) || 1)) })} />
                  <Button small disabled={busy || own || (me?.coins ?? 0) < listing.unit_price * quantity}
                    onClick={() => Run(async () => { await Api("POST", "/market/buy", { listing_id: listing.listing_id, quantity, request_id: RequestId() }); listings.reload(); }, `Bought ${quantity}x ${item.name}.`, "market")}>
                    {own ? "Yours" : `Buy ${(listing.unit_price * quantity).toLocaleString()}`}
                  </Button>
                </div>
              );
            })}
          </div>
        </>
      )}
      {tab === "mine" && (
        <div className="listing_table">
          {mine.data?.listings.length === 0 && <p className="muted">You have no listings. List items from your Inventory.</p>}
          {mine.data?.listings.map((listing) => (
            <div key={listing.listing_id} className="listing_row">
              <ItemIcon item_id={listing.item_id} />
              <span className="listing_name">{GetItem(listing.item_id)!.name}</span>
              <span>{listing.quantity}/{listing.initial_quantity}</span>
              <span><Coins amount={listing.unit_price} /></span>
              <span className={`status_tag status_${listing.status}`}>{listing.status}</span>
              {listing.status === "active"
                ? <Button small variant="danger" disabled={busy} onClick={() => Run(async () => { await Api("POST", "/market/cancel", { listing_id: listing.listing_id }); mine.reload(); }, "Listing cancelled; items returned.")}>Cancel</Button>
                : <TimeAgo time={listing.created_at} />}
            </div>
          ))}
        </div>
      )}
      {tab === "history" && (
        <div className="listing_table">
          {history.data?.history.length === 0 && <p className="muted">No trades yet.</p>}
          {history.data?.history.map((entry) => (
            <div key={entry.market_transaction_id} className="listing_row">
              <ItemIcon item_id={entry.item_id} />
              <span className="listing_name">{entry.quantity}x {GetItem(entry.item_id)?.name}</span>
              <span>{entry.buyer_id === me?.player_id ? `bought from ${entry.seller_name}` : `sold to ${entry.buyer_name}`}</span>
              <span><Coins amount={entry.buyer_id === me?.player_id ? entry.total : entry.total - entry.fee} /></span>
              <TimeAgo time={entry.created_at} />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
