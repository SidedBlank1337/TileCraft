import type { Database } from "../database/database.ts";
import { HOTBAR_SLOTS, INVENTORY_SLOTS } from "../../shared/constants.ts";
import { GetItem, IsValidItemId, ITEM_LIST } from "../../shared/items.ts";
import type { InventorySlot } from "../../shared/protocol.ts";
import { InsufficientError, ValidationError } from "./errors.ts";
import type { PlayerHub } from "./hub.ts";

export function AssertQuantity(value: unknown, max = 1_000_000): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new ValidationError("Invalid quantity.");
  return value;
}

export function AssertSlot(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= INVENTORY_SLOTS) throw new ValidationError("Invalid inventory slot.");
  return value;
}

export function AssertItemId(value: unknown): number {
  if (!IsValidItemId(value)) throw new ValidationError("Unknown item.");
  return value;
}

export class InventoryService {
  constructor(private db: Database, private hub: PlayerHub) {}

  async SyncDefinitions(): Promise<void> {
    await this.db.Transaction(async () => {
      for (const item of ITEM_LIST) {
        await this.db.Run(
          `INSERT INTO item_definitions (item_id, item_key, name, kind, rarity, sell_price, max_stack) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(item_id) DO UPDATE SET item_key = excluded.item_key, name = excluded.name, kind = excluded.kind, rarity = excluded.rarity, sell_price = excluded.sell_price, max_stack = excluded.max_stack`,
          item.item_id, item.item_key, item.name, item.kind, item.rarity, item.sell_price, item.max_stack
        );
      }
    });
  }

  GetInventory(player_id: number): Promise<InventorySlot[]> {
    return this.db.All<InventorySlot>("SELECT slot_index, item_id, quantity FROM player_inventory WHERE player_id = ? ORDER BY slot_index", player_id);
  }

  async PushInventory(player_id: number): Promise<void> {
    if (this.hub.IsOnline(player_id)) this.hub.Send(player_id, "inventory_update", { slots: await this.GetInventory(player_id) });
  }

  async CountItem(player_id: number, item_id: number): Promise<number> {
    const row = await this.db.Get<{ total: number | null }>("SELECT SUM(quantity) AS total FROM player_inventory WHERE player_id = ? AND item_id = ?", player_id, item_id);
    return row?.total ?? 0;
  }

  async BestToolTier(player_id: number): Promise<number> {
    const rows = await this.db.All<{ item_id: number }>("SELECT DISTINCT item_id FROM player_inventory WHERE player_id = ? AND item_id IN (300, 301, 302)", player_id);
    return rows.reduce((best, row) => Math.max(best, GetItem(row.item_id)?.tool_tier ?? 0), 0);
  }

  // How many of item_id fit right now; lets callers reject before mutating anything.
  async FreeCapacity(player_id: number, item_id: number): Promise<number> {
    const item = GetItem(item_id);
    if (!item) return 0;
    const slots = await this.GetInventory(player_id);
    let capacity = (INVENTORY_SLOTS - slots.length) * item.max_stack;
    for (const slot of slots) if (slot.item_id === item_id) capacity += Math.max(0, item.max_stack - slot.quantity);
    return capacity;
  }

  async AddItem(player_id: number, item_id: number, quantity: number): Promise<void> {
    AssertItemId(item_id);
    AssertQuantity(quantity);
    const item = GetItem(item_id)!;
    await this.db.Transaction(async () => {
      const slots = await this.GetInventory(player_id);
      let remaining = quantity;
      for (const slot of slots) {
        if (remaining === 0) break;
        if (slot.item_id !== item_id || slot.quantity >= item.max_stack) continue;
        const add = Math.min(remaining, item.max_stack - slot.quantity);
        await this.db.Run("UPDATE player_inventory SET quantity = quantity + ? WHERE player_id = ? AND slot_index = ?", add, player_id, slot.slot_index);
        remaining -= add;
      }
      const used = new Set(slots.map((slot) => slot.slot_index));
      // Prefer the backpack over the hotbar for brand-new stacks only once the hotbar is full.
      for (let slot_index = 0; slot_index < INVENTORY_SLOTS && remaining > 0; slot_index++) {
        if (used.has(slot_index)) continue;
        const add = Math.min(remaining, item.max_stack);
        await this.db.Run("INSERT INTO player_inventory (player_id, slot_index, item_id, quantity) VALUES (?, ?, ?, ?)", player_id, slot_index, item_id, add);
        used.add(slot_index);
        remaining -= add;
      }
      if (remaining > 0) throw new InsufficientError("Your inventory is full.", { hint: "inventory_full" });
    });
  }

  async RemoveItem(player_id: number, item_id: number, quantity: number): Promise<void> {
    AssertItemId(item_id);
    AssertQuantity(quantity);
    await this.db.Transaction(async () => {
      const slots = (await this.GetInventory(player_id)).filter((slot) => slot.item_id === item_id);
      const total = slots.reduce((sum, slot) => sum + slot.quantity, 0);
      if (total < quantity) throw new InsufficientError(`You need ${quantity} ${GetItem(item_id)!.name} but have ${total}.`, { required: quantity, available: total });
      let remaining = quantity;
      for (const slot of slots.reverse()) {
        if (remaining === 0) break;
        const take = Math.min(remaining, slot.quantity);
        await this.RemoveFromSlotRaw(player_id, slot.slot_index, take);
        remaining -= take;
      }
    });
  }

  private async RemoveFromSlotRaw(player_id: number, slot_index: number, quantity: number): Promise<void> {
    const result = await this.db.Run("UPDATE player_inventory SET quantity = quantity - ? WHERE player_id = ? AND slot_index = ? AND quantity > ?", quantity, player_id, slot_index, quantity);
    if (result.changes > 0) return;
    const removed = await this.db.Run("DELETE FROM player_inventory WHERE player_id = ? AND slot_index = ? AND quantity = ?", player_id, slot_index, quantity);
    if (removed.changes === 0) throw new InsufficientError("Not enough items in that slot.");
  }

  async RemoveFromSlot(player_id: number, slot_index: number, quantity: number): Promise<InventorySlot> {
    AssertSlot(slot_index);
    AssertQuantity(quantity);
    return this.db.Transaction(async () => {
      const slot = await this.db.Get<InventorySlot>("SELECT slot_index, item_id, quantity FROM player_inventory WHERE player_id = ? AND slot_index = ?", player_id, slot_index);
      if (!slot) throw new ValidationError("That slot is empty.");
      if (slot.quantity < quantity) throw new InsufficientError("Not enough items in that slot.");
      await this.RemoveFromSlotRaw(player_id, slot_index, quantity);
      return slot;
    });
  }

  async GetSlot(player_id: number, slot_index: number): Promise<InventorySlot | undefined> {
    return this.db.Get<InventorySlot>("SELECT slot_index, item_id, quantity FROM player_inventory WHERE player_id = ? AND slot_index = ?", player_id, slot_index);
  }

  // Drag/drop: merge into a same-item stack, otherwise swap.
  async MoveSlot(player_id: number, from_slot: unknown, to_slot: unknown): Promise<void> {
    const from_index = AssertSlot(from_slot);
    const to_index = AssertSlot(to_slot);
    if (from_index === to_index) return;
    await this.db.Transaction(async () => {
      const source = await this.GetSlot(player_id, from_index);
      if (!source) throw new ValidationError("That slot is empty.");
      const target = await this.GetSlot(player_id, to_index);
      if (!target) {
        await this.db.Run("UPDATE player_inventory SET slot_index = ? WHERE player_id = ? AND slot_index = ?", to_index, player_id, from_index);
        return;
      }
      const item = GetItem(source.item_id)!;
      if (target.item_id === source.item_id && target.quantity < item.max_stack) {
        const move = Math.min(source.quantity, item.max_stack - target.quantity);
        await this.db.Run("UPDATE player_inventory SET quantity = quantity + ? WHERE player_id = ? AND slot_index = ?", move, player_id, to_index);
        await this.RemoveFromSlotRaw(player_id, from_index, move);
        return;
      }
      await this.SwapViaTemp(player_id, from_index, to_index, source, target);
    });
  }

  private async SwapViaTemp(player_id: number, from_index: number, to_index: number, source: InventorySlot, target: InventorySlot): Promise<void> {
    await this.db.Run("DELETE FROM player_inventory WHERE player_id = ? AND slot_index IN (?, ?)", player_id, from_index, to_index);
    await this.db.Run("INSERT INTO player_inventory (player_id, slot_index, item_id, quantity) VALUES (?, ?, ?, ?)", player_id, to_index, source.item_id, source.quantity);
    await this.db.Run("INSERT INTO player_inventory (player_id, slot_index, item_id, quantity) VALUES (?, ?, ?, ?)", player_id, from_index, target.item_id, target.quantity);
  }

  async SplitSlot(player_id: number, slot: unknown, quantity: unknown): Promise<void> {
    const slot_index = AssertSlot(slot);
    const amount = AssertQuantity(quantity);
    await this.db.Transaction(async () => {
      const source = await this.GetSlot(player_id, slot_index);
      if (!source) throw new ValidationError("That slot is empty.");
      if (amount >= source.quantity) throw new ValidationError("Split amount must be less than the stack size.");
      const used = new Set((await this.GetInventory(player_id)).map((entry) => entry.slot_index));
      let free = -1;
      for (let index = HOTBAR_SLOTS; index < INVENTORY_SLOTS + HOTBAR_SLOTS; index++) {
        const candidate = index % INVENTORY_SLOTS;
        if (!used.has(candidate)) { free = candidate; break; }
      }
      if (free < 0) throw new InsufficientError("No empty slot to split into.");
      await this.RemoveFromSlotRaw(player_id, slot_index, amount);
      await this.db.Run("INSERT INTO player_inventory (player_id, slot_index, item_id, quantity) VALUES (?, ?, ?, ?)", player_id, free, source.item_id, amount);
    });
  }

  // Sorts the backpack only; the hotbar layout is the player's choice.
  async SortInventory(player_id: number): Promise<void> {
    await this.db.Transaction(async () => {
      const slots = (await this.GetInventory(player_id)).filter((slot) => slot.slot_index >= HOTBAR_SLOTS);
      const totals = new Map<number, number>();
      for (const slot of slots) totals.set(slot.item_id, (totals.get(slot.item_id) ?? 0) + slot.quantity);
      await this.db.Run("DELETE FROM player_inventory WHERE player_id = ? AND slot_index >= ?", player_id, HOTBAR_SLOTS);
      const ordered = [...totals.entries()].sort((a, b) => {
        const item_a = GetItem(a[0])!;
        const item_b = GetItem(b[0])!;
        return item_a.kind.localeCompare(item_b.kind) || item_a.item_id - item_b.item_id;
      });
      let slot_index = HOTBAR_SLOTS;
      for (const [item_id, total] of ordered) {
        const max_stack = GetItem(item_id)!.max_stack;
        let remaining = total;
        while (remaining > 0) {
          const amount = Math.min(remaining, max_stack);
          await this.db.Run("INSERT INTO player_inventory (player_id, slot_index, item_id, quantity) VALUES (?, ?, ?, ?)", player_id, slot_index++, item_id, amount);
          remaining -= amount;
        }
      }
    });
  }
}
