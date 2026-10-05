import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, SocketClient, Sleep, StartTestServer } from "./test_helpers.ts";
import { WebSocket } from "ws";

test("multiplayer: two real clients share one world over HTTP + WebSocket", async (t) => {
  const server = await StartTestServer();
  const ws_url = server.base_url.replace("http", "ws") + "/ws";
  const api_a = new ApiClient(server.base_url);
  const api_b = new ApiClient(server.base_url);
  await api_a.RegisterAndLogin("Player_A");
  await api_b.RegisterAndLogin("Player_B");
  let socket_a: SocketClient;
  let socket_b: SocketClient;
  let state_a: any;
  let world_id = 0;

  try {
    await t.test("unauthenticated API and WebSocket are rejected", async () => {
      const anonymous = new ApiClient(server.base_url);
      assert.equal((await anonymous.Call("GET", "/api/inventory")).status, 401);
      assert.equal((await anonymous.Call("POST", "/api/worlds", { world_name: "HACKWORLD", world_type: "public" })).status, 401);
      const forged = new SocketClient(ws_url, "tc_session=not-a-real-token");
      await assert.rejects(forged.Open(), /401/);
    });

    await t.test("create world, duplicate world rejected, server ignores client ids", async () => {
      const created = await api_a.Call("POST", "/api/worlds", { world_name: "testworld", world_type: "public", world_size: "small", seed: 1234, world_id: 999, owner_id: 999 });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      assert.equal(created.json.world.world_name, "TESTWORLD");
      assert.equal(created.json.world.owner_name, "Player_A");
      world_id = created.json.world.world_id;
      assert.notEqual(world_id, 999);
      const duplicate = await api_b.Call("POST", "/api/worlds", { world_name: "TESTWORLD", world_type: "public" });
      assert.equal(duplicate.status, 409);
      const reserved = await api_b.Call("POST", "/api/worlds", { world_name: "ADMIN", world_type: "public" });
      assert.equal(reserved.status, 400);
      const bad = await api_b.Call("POST", "/api/worlds", { world_name: "<script>", world_type: "public" });
      assert.equal(bad.status, 400);
      for (const invalid of ["ABC1", "TOO_LONG_NAMEXX", "ABCDEFGHIJKLMNOPQ", ""]) {
        assert.equal((await api_b.Call("POST", "/api/worlds", { world_name: invalid, world_type: "public" })).status, 400, invalid);
      }
    });

    await t.test("both players join and see each other", async () => {
      socket_a = new SocketClient(ws_url, api_a.cookie);
      socket_b = new SocketClient(ws_url, api_b.cookie);
      await Promise.all([socket_a.Open(), socket_b.Open()]);
      await socket_a.Wait("hello");
      await socket_b.Wait("hello");
      socket_a.Send("join_world", { world_name: "TESTWORLD" });
      state_a = await socket_a.Wait("world_state");
      assert.equal(state_a.your_role, "owner");
      socket_b.Send("join_world", { world_name: "testworld" });
      const state_b = await socket_b.Wait("world_state");
      assert.equal(state_b.your_role, "visitor");
      assert.ok(state_b.players.some((player: any) => player.username === "Player_A"), "B sees A");
      const joined = await socket_a.Wait("player_join", (data) => data.username === "Player_B");
      assert.equal(joined.username, "Player_B", "A sees B");
      const browse = await api_b.Call("GET", "/api/worlds?filter=public");
      assert.equal(browse.json.worlds.find((world: any) => world.world_name === "TESTWORLD").current_players, 2, "real live player count");
    });

    await t.test("movement syncs and impossible movement is corrected", async () => {
      const player = state_a.players.find((entry: any) => entry.username === "Player_A");
      await Sleep(60);
      socket_a.Send("player_move", { x: player.x + 4, y: player.y, vx: 100, vy: 0, facing: 1, anim: "walk" });
      const moved = await socket_b.Wait("players_moved", (data) => data.players.some((entry: any) => entry.x === player.x + 4));
      assert.ok(moved);
      await Sleep(60);
      socket_a.Send("player_move", { x: player.x + 2000, y: player.y, vx: 0, vy: 0, facing: 1 });
      const correction = await socket_a.Wait("player_correct");
      assert.equal(correction.x, player.x + 4, "teleport rejected");
      socket_a.Send("player_move", { x: "NaN", y: null, vx: 0, vy: 0 });
      await socket_a.Wait("error", (data) => /Malformed/.test(data.message));
    });

    await t.test("reach is limited to 2 tiles", async () => {
      socket_a.Clear();
      await Sleep(200);
      socket_a.Send("block_hit", { x: state_a.spawn_x + 4, y: state_a.spawn_y + 1 });
      await socket_a.Wait("error", (data) => /too far/.test(data.message));
    });

    await t.test("visitor cannot break; owner breaks, both see it, drop is picked up once", async () => {
      const target = { x: state_a.spawn_x + 1, y: state_a.spawn_y + 1 };
      socket_b.Send("block_hit", target);
      await socket_b.Wait("error", (data) => data.code === "no_permission");
      socket_a.Send("block_hit", { ...target, x: -5 });
      await socket_a.Wait("error", (data) => /Invalid tile/.test(data.message));
      for (let hit = 0; hit < 3; hit++) {
        socket_a.Send("block_hit", target);
        await Sleep(200);
      }
      const update = await socket_b.Wait("tile_update", (data) => data.x === target.x && data.y === target.y);
      assert.equal(update.foreground, 0, "B sees the block disappear");
      const drop = await socket_b.Wait("drop_spawn");
      socket_a.Send("item_pickup", { drop_id: drop.drop_id });
      socket_a.Send("item_pickup", { drop_id: drop.drop_id });
      const removed = await socket_b.Wait("drop_remove", (data) => data.drop_id === drop.drop_id);
      assert.ok(removed);
      await Sleep(150);
      const pickups = socket_a.messages.filter((message) => message.event === "item_obtained");
      assert.equal(pickups.length, 1, "duplicate pickup ignored");
    });

    await t.test("instant breaking is rejected by the hit cooldown", async () => {
      const target = { x: state_a.spawn_x - 1, y: state_a.spawn_y + 1 };
      socket_b.Clear();
      for (let hit = 0; hit < 10; hit++) socket_a.Send("block_hit", target);
      await Sleep(300);
      assert.equal(socket_b.messages.filter((message) => message.event === "tile_update" && message.data.x === target.x).length, 0, "ten instant hits did not break a 3-hit block");
    });

    await t.test("owner grants builder; builder places a block that A sees", async () => {
      const denied = await api_b.Call("POST", `/api/worlds/${world_id}/permissions`, { username: "Player_B", role: "admin" });
      assert.equal(denied.status, 403, "visitor cannot grant itself roles");
      const granted = await api_a.Call("POST", `/api/worlds/${world_id}/permissions`, { username: "Player_B", role: "builder" });
      assert.equal(granted.status, 200);
      await socket_b.Wait("world_settings", (data) => data.your_role === "builder");
      const place = { x: state_a.spawn_x - 2, y: state_a.spawn_y - 1, slot_index: 0 };
      socket_b.Send("block_place", place);
      const update = await socket_a.Wait("tile_update", (data) => data.x === place.x && data.y === place.y);
      assert.equal(update.foreground, 1, "A sees the dirt block appear");
      await Sleep(150);
      socket_b.Send("block_place", { x: state_a.spawn_x - 2, y: state_a.spawn_y - 1, slot_index: 39 });
      await socket_b.Wait("error", (data) => /empty|occupied/.test(data.message));
    });

    await t.test("fake admin command and malformed packets rejected", async () => {
      socket_b.Send("chat_send", { channel: "world", text: "/coins Player_B 99999" });
      await socket_b.Wait("error", (data) => data.code === "forbidden");
      socket_b.socket.send("{not json");
      await socket_b.Wait("error", (data) => data.code === "protocol");
      socket_b.Send("give_me_coins", { coins: 1e9 });
      await socket_b.Wait("error", (data) => data.code === "protocol");
      const profile = await api_b.Call("GET", "/api/player");
      assert.ok(profile.json.player.coins < 10000);
      const admin = await api_b.Call("GET", "/api/admin/overview");
      assert.equal(admin.status, 403);
    });

    await t.test("chat both ways, HTML is not interpreted, flooding is limited", async () => {
      socket_a.Send("chat_send", { channel: "world", text: "hello from A <b>bold</b>" });
      const received_b = await socket_b.Wait("chat_message", (data) => data.sender_name === "Player_A");
      assert.equal(received_b.body, "hello from A <b>bold</b>", "stored and sent as plain text");
      socket_b.Send("chat_send", { channel: "world", text: "hi A" });
      await socket_a.Wait("chat_message", (data) => data.body === "hi A");
      socket_b.Send("chat_send", { channel: "private", to_username: "Player_A", text: "secret" });
      await socket_a.Wait("chat_message", (data) => data.channel === "private" && data.body === "secret");
      for (let i = 0; i < 8; i++) socket_b.Send("chat_send", { channel: "world", text: `spam ${i}` });
      await socket_b.Wait("error", (data) => data.code === "rate_limited");
    });

    await t.test("trade: request, accept, offer, change resets confirm, complete, no duplication", async () => {
      socket_a.Clear();
      socket_b.Clear();
      socket_a.Send("trade_request", { username: "Player_B" });
      const request = await socket_b.Wait("trade_request");
      socket_b.Send("trade_respond", { trade_id: request.trade_id, accept: true });
      await socket_a.Wait("trade_update", (data) => data.status === "open");
      socket_a.Send("trade_offer", { trade_id: request.trade_id, items: [{ item_id: 4, quantity: 5 }], coins: 10 });
      await socket_b.Wait("trade_update", (data) => data.sides[0].coins === 10);
      socket_b.Send("trade_offer", { trade_id: request.trade_id, items: [{ item_id: 4, quantity: 9999 }], coins: 0 });
      await socket_b.Wait("error", (data) => data.code === "insufficient");
      socket_a.Send("trade_confirm", { trade_id: request.trade_id });
      await socket_b.Wait("trade_update", (data) => data.sides[0].confirmed === true);
      socket_b.Send("trade_offer", { trade_id: request.trade_id, items: [{ item_id: 12, quantity: 2 }], coins: 0 });
      const reset = await socket_a.Wait("trade_update", (data) => data.sides[1].items.length === 1);
      assert.equal(reset.sides[0].confirmed, false, "change resets confirmations");
      const before_a = (await api_a.Call("GET", "/api/player")).json.player.coins;
      const before_b = (await api_b.Call("GET", "/api/player")).json.player.coins;
      socket_a.Send("trade_confirm", { trade_id: request.trade_id });
      socket_b.Send("trade_confirm", { trade_id: request.trade_id });
      socket_b.Send("trade_confirm", { trade_id: request.trade_id });
      await socket_a.Wait("trade_closed", (data) => data.completed === true);
      await Sleep(100);
      const after_a = (await api_a.Call("GET", "/api/player")).json.player.coins;
      const after_b = (await api_b.Call("GET", "/api/player")).json.player.coins;
      assert.equal(after_a + after_b, before_a + before_b, "coins conserved");
      assert.equal(after_b - before_b, 10);
    });

    await t.test("trade cancels safely when a player disconnects", async () => {
      socket_a.Clear();
      socket_a.Send("trade_request", { username: "Player_B" });
      const request = await socket_b.Wait("trade_request", (data) => data.trade_id !== undefined && !socket_b.messages.some((message) => message.event === "trade_closed" && message.data.trade_id === data.trade_id));
      socket_b.Send("trade_respond", { trade_id: request.trade_id, accept: true });
      await socket_a.Wait("trade_update", (data) => data.trade_id === request.trade_id && data.status === "open");
      socket_b.Close();
      const closed = await socket_a.Wait("trade_closed", (data) => data.trade_id === request.trade_id);
      assert.equal(closed.completed, false);
      await socket_a.Wait("player_leave", (data) => data.reason === "disconnect");
    });

    await t.test("private world requires invitation; banned player cannot enter", async () => {
      const created = await api_a.Call("POST", "/api/worlds", { world_name: "SECRETBASE", world_type: "private", world_size: "small" });
      const secret_id = created.json.world.world_id;
      socket_b = new SocketClient(ws_url, api_b.cookie);
      await socket_b.Open();
      socket_b.Send("join_world", { world_name: "SECRETBASE" });
      await socket_b.Wait("error", (data) => data.code === "world_denied");
      const browse = await api_b.Call("GET", "/api/worlds?filter=public");
      assert.ok(!browse.json.worlds.some((world: any) => world.world_name === "SECRETBASE"), "private world hidden");
      await api_a.Call("POST", `/api/worlds/${secret_id}/invite`, { username: "Player_B" });
      socket_b.Clear();
      socket_b.Send("join_world", { world_name: "SECRETBASE" });
      await socket_b.Wait("world_state");
      await api_a.Call("POST", `/api/worlds/${secret_id}/permissions`, { username: "Player_B", role: "banned" });
      await socket_b.Wait("kicked");
      socket_b.Clear();
      socket_b.Send("join_world", { world_name: "SECRETBASE" });
      const denied = await socket_b.Wait("error", (data) => data.code === "world_denied");
      assert.match(denied.message, /banned/);
      const takeover = await api_b.Call("PATCH", `/api/worlds/${secret_id}`, { world_name: "STOLEN", is_owner: true });
      assert.equal(takeover.status, 403);
    });

    await t.test("guests without a TileID can walk and chat but not interact", async () => {
      const guest_api = new ApiClient(server.base_url);
      const created = await guest_api.Call("POST", "/api/auth/guest", { name: "Wanderer" });
      assert.equal(created.status, 200);
      assert.equal(created.json.player.is_guest, true);
      assert.equal((await guest_api.Call("POST", "/api/shop/buy", { item_id: 1, quantity: 1 })).status, 403);
      assert.equal((await guest_api.Call("POST", "/api/worlds", { world_name: "GUESTLAND", world_type: "public" })).status, 403);
      const guest = new SocketClient(ws_url, guest_api.cookie);
      await guest.Open();
      guest.Send("join_world", { world_name: "TESTWORLD" });
      const state = await guest.Wait("world_state");
      assert.equal(state.can_build, false);
      guest.Send("block_hit", { x: state.spawn_x, y: state.spawn_y + 1 });
      await guest.Wait("error", (data) => data.code === "tile_id_required");
      guest.Send("chat_send", { channel: "world", text: "guest says hi" });
      await guest.Wait("chat_message", (data) => data.body === "guest says hi");
      const upgraded = await guest_api.Call("POST", "/api/auth/upgrade", { tile_id: "Wanderer_Pro", email: "wanderer@example.com", password: "password123", confirm_password: "password123" });
      assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json));
      assert.equal(upgraded.json.player.is_guest, false);
      assert.equal(upgraded.json.player.username, "Wanderer_Pro");
      const relogin = new ApiClient(server.base_url);
      assert.equal((await relogin.Call("POST", "/api/auth/login", { login: "Wanderer_Pro", password: "password123" })).status, 200);
      guest.Close();
    });

    await t.test("cross-site POST is rejected", async () => {
      const response = await fetch(`${server.base_url}/api/shop/buy`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: api_a.cookie, origin: "https://evil.example" },
        body: JSON.stringify({ item_id: 1, quantity: 1 })
      });
      assert.equal(response.status, 403);
    });

    await t.test("health endpoint reports state without secrets", async () => {
      const response = await fetch(`${server.base_url}/health`);
      const body = await response.json();
      assert.equal(body.status, "ok");
      assert.ok(!JSON.stringify(body).includes("session"));
    });
  } finally {
    socket_a!?.Close();
    socket_b!?.Close();
    await Sleep(50);
    await server.Stop();
  }
});

test("websocket flood closes the connection", async () => {
  const server = await StartTestServer();
  try {
    const api = new ApiClient(server.base_url);
    await api.RegisterAndLogin("Flooder");
    const socket = new SocketClient(server.base_url.replace("http", "ws") + "/ws", api.cookie);
    await socket.Open();
    const closed = new Promise<number>((resolve) => socket.socket.once("close", (code) => resolve(code)));
    for (let i = 0; i < 300; i++) if (socket.socket.readyState === WebSocket.OPEN) socket.Send("ping", { t: i });
    assert.equal(await closed, 4008);
  } finally {
    await server.Stop();
  }
});
