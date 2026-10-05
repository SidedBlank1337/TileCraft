import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateTestPlayer, CreateTestServices } from "./test_helpers.ts";
import { GameError } from "../server/services/errors.ts";

test("inventory, crafting, economy and marketplace", async (t) => {
  const services = await CreateTestServices();
  const inv = services.inventory_service;
  const { player_id } = await CreateTestPlayer(services, "crafter", 1000);

  await t.test("add stacks into existing slots, then new slots, respecting max stack", async () => {
    await inv.AddItem(player_id, 4, 190);
    const stone = (await inv.GetInventory(player_id)).filter((slot) => slot.item_id === 4);
    assert.equal(stone.reduce((sum, slot) => sum + slot.quantity, 0), 205);
    assert.ok(stone.every((slot) => slot.quantity <= 200));
  });

  await t.test("remove, invalid quantity and invalid item", async () => {
    await inv.RemoveItem(player_id, 4, 5);
    assert.equal(await inv.CountItem(player_id, 4), 200);
    await assert.rejects(inv.RemoveItem(player_id, 4, 201), (error: GameError) => error.code === "insufficient");
    await assert.rejects(inv.AddItem(player_id, 4, -5));
    await assert.rejects(inv.AddItem(player_id, 4, 1.5));
    await assert.rejects(inv.AddItem(player_id, 99999, 1));
    assert.equal(await inv.CountItem(player_id, 4), 200);
  });

  await t.test("split, move/merge, swap and sort", async () => {
    const slots = await inv.GetInventory(player_id);
    const dirt = slots.find((slot) => slot.item_id === 1)!;
    await inv.SplitSlot(player_id, dirt.slot_index, 10);
    const after = (await inv.GetInventory(player_id)).filter((slot) => slot.item_id === 1);
    assert.equal(after.length, 2);
    assert.equal(after.reduce((sum, slot) => sum + slot.quantity, 0), 30);
    await assert.rejects(inv.SplitSlot(player_id, dirt.slot_index, 999));
    const extra = after.find((slot) => slot.slot_index !== dirt.slot_index)!;
    await inv.MoveSlot(player_id, extra.slot_index, dirt.slot_index);
    const merged = (await inv.GetInventory(player_id)).filter((slot) => slot.item_id === 1);
    assert.deepEqual(merged.map((slot) => slot.quantity), [30]);
    await inv.MoveSlot(player_id, 0, 1);
    await inv.SortInventory(player_id);
    assert.equal(await inv.CountItem(player_id, 1), 30);
    await assert.rejects(inv.MoveSlot(player_id, 0, 40));
  });

  await t.test("crafting: valid, invalid recipe, insufficient materials, level lock", async () => {
    await inv.AddItem(player_id, 11, 2);
    const result = await services.crafting_service.Craft(player_id, "planks_from_log", 2);
    assert.equal(result.quantity, 8);
    assert.equal(await inv.CountItem(player_id, 11), 0);
    await assert.rejects(services.crafting_service.Craft(player_id, "fake_recipe"), (error: GameError) => error.code === "not_found");
    await assert.rejects(services.crafting_service.Craft(player_id, "planks_from_log", 1), (error: GameError) => error.code === "insufficient");
    await assert.rejects(services.crafting_service.Craft(player_id, "planks_from_log", -1));
    await assert.rejects(services.crafting_service.Craft(player_id, "moon_pick"), /level/);
  });

  await t.test("coins: earn, spend, no negative balance, rollback on failure", async () => {
    const before = (await services.player_service.GetPlayer(player_id)).coins;
    await services.player_service.ChangeCoins(player_id, 50, "test_earn");
    await services.player_service.ChangeCoins(player_id, -20, "test_spend");
    assert.equal((await services.player_service.GetPlayer(player_id)).coins, before + 30);
    await assert.rejects(services.player_service.ChangeCoins(player_id, -1_000_000, "test_spend"), (error: GameError) => error.code === "insufficient");
    await assert.rejects(services.db.Transaction(async () => {
      await services.player_service.ChangeCoins(player_id, 500, "test_rollback");
      throw new Error("boom");
    }));
    assert.equal((await services.player_service.GetPlayer(player_id)).coins, before + 30);
    const ledger = await services.db.All("SELECT * FROM transactions WHERE player_id = ? AND type = 'test_rollback'", player_id);
    assert.equal(ledger.length, 0);
  });

  await t.test("shop buy/sell with daily stock and replay protection", async () => {
    const coins = (await services.player_service.GetPlayer(player_id)).coins;
    await services.shop_service.Buy(player_id, 130, 2, "request_abc12345");
    await assert.rejects(services.shop_service.Buy(player_id, 130, 2, "request_abc12345"), (error: GameError) => error.code === "duplicate_request");
    assert.equal((await services.player_service.GetPlayer(player_id)).coins, coins - 24);
    await assert.rejects(services.shop_service.Buy(player_id, 300, 3), /stock/);
    await assert.rejects(services.shop_service.Buy(player_id, 9, 1), (error: GameError) => error.code === "not_found");
    const sold = await services.shop_service.Sell(player_id, 4, 10);
    assert.equal(sold.earned, 20);
    await assert.rejects(services.shop_service.Sell(player_id, 4, 100000));
  });

  await t.test("marketplace: list, buy, cancel, double purchase, concurrent purchase", async () => {
    const seller = await CreateTestPlayer(services, "seller", 0);
    const buyer_a = await CreateTestPlayer(services, "buyer_a", 500);
    const buyer_b = await CreateTestPlayer(services, "buyer_b", 500);
    await inv.AddItem(seller.player_id, 211, 5);
    const listing = await services.marketplace_service.CreateListing(seller.player_id, { item_id: 211, quantity: 5, unit_price: 100 });
    assert.equal(await inv.CountItem(seller.player_id, 211), 0, "items are escrowed");

    const results = await Promise.allSettled([
      services.marketplace_service.Buy(buyer_a.player_id, listing.listing_id, 5),
      services.marketplace_service.Buy(buyer_b.player_id, listing.listing_id, 5)
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, "exactly one concurrent purchase succeeds");
    const total_received = (await inv.CountItem(buyer_a.player_id, 211)) + (await inv.CountItem(buyer_b.player_id, 211));
    assert.equal(total_received, 5, "no item duplication");
    const coins_a = (await services.player_service.GetPlayer(buyer_a.player_id)).coins;
    const coins_b = (await services.player_service.GetPlayer(buyer_b.player_id)).coins;
    assert.equal(coins_a + coins_b, 500, "only one buyer paid");
    assert.equal((await services.player_service.GetPlayer(seller.player_id)).coins, 475, "seller paid minus 5% fee");
    await assert.rejects(services.marketplace_service.Buy(buyer_a.player_id, listing.listing_id, 1), (error: GameError) => error.code === "listing_unavailable");

    await inv.AddItem(seller.player_id, 4, 10);
    const second = await services.marketplace_service.CreateListing(seller.player_id, { item_id: 4, quantity: 10, unit_price: 3 });
    await assert.rejects(services.marketplace_service.Buy(seller.player_id, second.listing_id, 1), /own listing/);
    const poor = await CreateTestPlayer(services, "poor_guy", 0);
    await assert.rejects(services.marketplace_service.Buy(poor.player_id, second.listing_id, 1), (error: GameError) => error.code === "insufficient");
    const buyer_c = await CreateTestPlayer(services, "buyer_c", 100);
    await services.marketplace_service.Buy(buyer_c.player_id, second.listing_id, 4);
    const cancelled = await services.marketplace_service.Cancel(seller.player_id, second.listing_id);
    assert.equal(cancelled.returned, 6);
    await assert.rejects(services.marketplace_service.Cancel(seller.player_id, second.listing_id));
    await assert.rejects(services.marketplace_service.CreateListing(seller.player_id, { item_id: 4, quantity: 999, unit_price: 3 }));
    await assert.rejects(services.marketplace_service.CreateListing(seller.player_id, { item_id: 4, quantity: 1, unit_price: -3 }));
    const negative = await services.db.Get<{ count: number }>("SELECT COUNT(*) AS count FROM players WHERE coins < 0");
    assert.equal(negative!.count, 0);
  });

  await t.test("quests and achievements cannot be double-claimed", async () => {
    await services.progress_service.Track(player_id, [{ stat_key: "items_crafted", amount: 5 }]);
    await services.progress_service.ClaimQuest(player_id, "craft_5");
    await assert.rejects(services.progress_service.ClaimQuest(player_id, "craft_5"), /already/);
    await assert.rejects(services.progress_service.ClaimQuest(player_id, "harvest_10"), /not finished/);
    await assert.rejects(services.progress_service.ClaimQuest(player_id, "fake_quest"));
    await services.progress_service.Track(player_id, [{ stat_key: "blocks_broken" }]);
    await services.progress_service.Track(player_id, [{ stat_key: "blocks_broken" }]);
    const unlocked = await services.db.All("SELECT * FROM player_achievements WHERE player_id = ? AND achievement_key = 'first_block'", player_id);
    assert.equal(unlocked.length, 1);
  });

  await t.test("database integrity", async () => {
    const integrity = await services.db.Get<{ integrity_check: string }>("PRAGMA integrity_check");
    assert.equal(integrity!.integrity_check, "ok");
    assert.equal((await services.db.All("PRAGMA foreign_key_check")).length, 0);
  });
});
