import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiClient, SocketClient, Sleep, StartTestServer } from "./test_helpers.ts";
import { DecodeTiles } from "../shared/protocol.ts";
import { GenerateWorld } from "../server/game/world_generator.ts";

test("world generation is deterministic and playable", () => {
  const first = GenerateWorld(100, 60, 42, "public");
  const second = GenerateWorld(100, 60, 42, "public");
  const other = GenerateWorld(100, 60, 43, "public");
  assert.deepEqual(first.foreground, second.foreground);
  assert.notDeepEqual(first.foreground, other.foreground);
  assert.equal(first.foreground[first.spawn_y * 100 + first.spawn_x], 19, "spawn beacon placed");
  assert.ok([1, 2, 3, 4].includes(first.foreground[(first.spawn_y + 1) * 100 + first.spawn_x]), "solid ground under spawn");
  for (let x = 0; x < 100; x++) assert.equal(first.foreground[59 * 100 + x], 6, "unbreakable floor");
  const ores = [...first.foreground].filter((tile) => tile === 7).length;
  assert.ok(ores > 10, "copper generated");
});

test("farming and persistence across a server restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tilecraft_"));
  const database_path = path.join(directory, "game.sqlite");
  let server = await StartTestServer(database_path);
  const api = new ApiClient(server.base_url);
  await api.RegisterAndLogin("Farmer_A");
  const friend = new ApiClient(server.base_url);
  await friend.RegisterAndLogin("Helper_B");
  let socket!: SocketClient;
  let world_id = 0;
  let spawn_x = 0;
  let spawn_y = 0;
  let coins_before = 0;

  try {
    await t.test("build, plant and configure, then leave", async () => {
      const created = await api.Call("POST", "/api/worlds", { world_name: "TESTWORLD", world_type: "farming", world_size: "small", seed: 77 });
      world_id = created.json.world.world_id;
      socket = new SocketClient(server.base_url.replace("http", "ws") + "/ws", api.cookie);
      await socket.Open();
      socket.Send("join_world", { world_name: "TESTWORLD" });
      const state = await socket.Wait("world_state");
      spawn_x = state.spawn_x;
      spawn_y = state.spawn_y;
      socket.Send("block_place", { x: spawn_x - 2, y: spawn_y - 1, slot_index: 0 });
      await socket.Wait("tile_update", (data) => data.x === spawn_x - 2);
      await Sleep(120);
      socket.Send("block_place", { x: spawn_x + 2, y: spawn_y, slot_index: 3 });
      const planted = await socket.Wait("tile_update", (data) => data.x === spawn_x + 2 && data.tree);
      assert.equal(planted.tree.item_id, 130);
      await Sleep(120);
      socket.Send("block_place", { x: spawn_x + 1, y: spawn_y - 1, slot_index: 3 });
      await socket.Wait("error", (data) => /solid ground/.test(data.message));
      await api.Call("PATCH", `/api/worlds/${world_id}`, { description: "My farm", settings: { visitors_can_build: true }, player_limit: 12 });
      await api.Call("POST", `/api/worlds/${world_id}/permissions`, { username: "Helper_B", role: "builder" });
      coins_before = (await api.Call("GET", "/api/player")).json.player.coins;
      socket.Send("leave_world");
      await socket.Wait("world_left");
      socket.Close();
    });

    await t.test("restart the server: nothing regenerates or resets", async () => {
      await server.Stop();
      server = await StartTestServer(database_path);
      const restarted = new ApiClient(server.base_url);
      restarted.cookie = api.cookie;
      const player = await restarted.Call("GET", "/api/player");
      assert.equal(player.status, 200, "session survived restart");
      assert.equal(player.json.player.coins, coins_before);
      const world = await restarted.Call("GET", `/api/worlds/${world_id}`);
      assert.equal(world.json.world.description, "My farm");
      assert.equal(world.json.world.player_limit, 12);
      assert.equal(world.json.world.settings.visitors_can_build, true);
      const permissions = await restarted.Call("GET", `/api/worlds/${world_id}/permissions`);
      assert.equal(permissions.json.permissions[0].role, "builder");
      const inventory = await restarted.Call("GET", "/api/inventory");
      assert.equal(inventory.json.slots.find((slot: any) => slot.slot_index === 0).quantity, 29);
      assert.equal(inventory.json.slots.find((slot: any) => slot.slot_index === 3).quantity, 3);

      socket = new SocketClient(server.base_url.replace("http", "ws") + "/ws", api.cookie);
      await socket.Open();
      socket.Send("join_world", { world_name: "TESTWORLD" });
      const state = await socket.Wait("world_state");
      const tiles = DecodeTiles(state.foreground, state.width * state.height);
      assert.equal(tiles[(spawn_y - 1) * state.width + spawn_x - 2], 1, "placed block persisted");
      assert.ok(state.trees.some((tree: any) => tree.x === spawn_x + 2 && tree.item_id === 130), "tree persisted");
    });

    await t.test("growth continues offline and harvest pays once", async () => {
      const game = server.game;
      await game.services.db.Run("UPDATE trees SET planted_at = planted_at - 3600000 WHERE world_id = ?", world_id);
      socket.Close();
      await Sleep(50);
      await game.services.world_manager.Unload(world_id);
      socket = new SocketClient(server.base_url.replace("http", "ws") + "/ws", api.cookie);
      await socket.Open();
      socket.Send("join_world", { world_name: "TESTWORLD" });
      await socket.Wait("world_state");
      socket.Send("block_hit", { x: spawn_x + 2, y: spawn_y });
      await socket.Wait("tile_update", (data) => data.tree_removed === true);
      const drops: any[] = [];
      for (let i = 0; i < 2; i++) drops.push(await socket.Wait("drop_spawn", (data) => !drops.some((drop: any) => drop.drop_id === data.drop_id)).catch(() => null));
      assert.ok(drops.some((drop: any) => drop?.item_id === 200), "sunberries dropped");
      await Sleep(200);
      socket.Send("block_hit", { x: spawn_x + 2, y: spawn_y });
      await Sleep(200);
      const stats = await game.services.progress_service.GetStats((await game.services.player_service.FindByUsername("Farmer_A"))!.user_id);
      assert.equal(stats.trees_harvested, 1);
      assert.equal((await game.services.db.All("SELECT * FROM trees WHERE world_id = ?", world_id)).length, 0);
    });
  } finally {
    socket?.Close();
    await Sleep(50);
    await server.Stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
