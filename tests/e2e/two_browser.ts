// Real two-browser test: two isolated Chrome sessions register, join one world and interact.
// Run with: npm run build && npm run test:e2e
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = path.resolve("data/e2e");
const CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
];

const results: { step: string; ok: boolean; detail?: string }[] = [];

function Check(step: string, ok: boolean, detail?: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

async function WaitFor<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeout_ms = 8000): Promise<T> {
  const started = Date.now();
  let value = await probe();
  while (!accept(value) && Date.now() - started < timeout_ms) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await probe();
  }
  return value;
}

async function Register(page: Page, username: string, shots = false): Promise<void> {
  await page.goto(BASE_URL);
  await page.getByRole("button", { name: "Play Online" }).waitFor();
  if (shots) await page.screenshot({ path: path.join(SCREENSHOT_DIR, "00_title.png") });
  await page.getByRole("button", { name: "Play Online" }).click();
  await page.getByLabel("Name:").fill(username.slice(0, 12));
  if (shots) await page.screenshot({ path: path.join(SCREENSHOT_DIR, "00_login.png") });
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator(".log_lines").getByText("Welcome back").waitFor({ timeout: 10000 });
  if (shots) await page.screenshot({ path: path.join(SCREENSHOT_DIR, "00_connecting.png") });
  await page.getByRole("button", { name: "Enter World" }).waitFor({ timeout: 10000 });
  // Upgrade the guest to a full TileID account so it can build.
  await page.getByRole("button", { name: "Create a TileID" }).click();
  await page.getByLabel("TileID", { exact: true }).fill(username);
  await page.getByLabel("Email", { exact: true }).fill(`${username.toLowerCase()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByLabel("Confirm password").fill("password123");
  await page.getByRole("button", { name: "Create TileID" }).click();
  await page.getByRole("button", { name: "Create a TileID" }).waitFor({ state: "detached", timeout: 10000 });
}

const Debug = (page: Page) => ({
  remote: () => page.evaluate(() => (window as any).tilecraft_debug?.remote_players() ?? []),
  self: () => page.evaluate(() => (window as any).tilecraft_debug?.self()),
  tile: (x: number, y: number) => page.evaluate(([tx, ty]) => (window as any).tilecraft_debug?.tile(tx, ty), [x, y]),
  drops: () => page.evaluate(() => (window as any).tilecraft_debug?.drops() ?? 0),
  meta: () => page.evaluate(() => (window as any).tilecraft_debug?.meta()),
  screen: (x: number, y: number) => page.evaluate(([tx, ty]) => (window as any).tilecraft_debug.tile_to_screen(tx, ty), [x, y])
});

async function Chat(page: Page, text: string): Promise<void> {
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByPlaceholder("Press Enter to chat, /help").fill(text);
  await page.getByPlaceholder("Press Enter to chat, /help").press("Enter");
  await page.locator("canvas").click({ position: { x: 5, y: 300 }, button: "middle" }).catch(() => undefined);
  await page.getByPlaceholder("Press Enter to chat, /help").blur();
}

async function Main(): Promise<void> {
  if (!fs.existsSync("dist/client/index.html")) throw new Error("Run npm run build first.");
  const executable = CHROME_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("No Chrome or Edge found.");
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const database_path = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tilecraft_e2e_")), "game.sqlite");

  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), DATABASE_PATH: database_path, PUBLIC_URL: BASE_URL, LOG_LEVEL: "warn" },
    stdio: ["ignore", "inherit", "inherit"]
  });
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  try {
    await WaitFor(() => fetch(`${BASE_URL}/health`).then((response) => response.ok).catch(() => false), (ok) => ok, 20000);
    const context_a = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const context_b = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page_a = await context_a.newPage();
    const page_b = await context_b.newPage();
    for (const page of [page_a, page_b]) page.on("pageerror", (error) => Check(`no page errors (${page === page_a ? "A" : "B"})`, false, error.message));

    await Register(page_a, "Player_A", true);
    await Register(page_b, "Player_B");
    Check("both players logged in, saw the connection log and reached world select", true);
    await page_a.screenshot({ path: path.join(SCREENSHOT_DIR, "01_world_select.png") });

    await page_a.getByLabel("World Name:").fill("EEWORLD");
    await page_a.getByRole("button", { name: "Enter World" }).click();
    const meta_a = await WaitFor(Debug(page_a).meta, (meta) => !!meta, 10000);
    Check("Enter World auto-created EEWORLD and Player_A entered it", meta_a?.world_name === "EEWORLD" && meta_a?.your_role === "owner", JSON.stringify({ name: meta_a?.world_name, role: meta_a?.your_role }));

    const permission = await page_a.evaluate(async (world_id) => {
      const response = await fetch(`/api/worlds/${world_id}/permissions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "Player_B", role: "builder" }) });
      return response.status;
    }, meta_a.world_id);
    Check("owner granted Player_B builder", permission === 200);

    await page_b.getByLabel("World Name:").fill("EEWORLD");
    await page_b.getByRole("button", { name: "Enter World" }).click();
    await WaitFor(Debug(page_b).meta, (meta) => meta?.world_name === "EEWORLD", 10000);

    const a_sees_b = await WaitFor(Debug(page_a).remote, (list: any[]) => list.some((player) => player.username === "Player_B"));
    const b_sees_a = await WaitFor(Debug(page_b).remote, (list: any[]) => list.some((player) => player.username === "Player_A"));
    Check("Player_A sees Player_B", a_sees_b.some((player: any) => player.username === "Player_B"));
    Check("Player_B sees Player_A", b_sees_a.some((player: any) => player.username === "Player_A"));

    const a_start = (await Debug(page_b).remote()).find((player: any) => player.username === "Player_A");
    await page_a.locator("canvas").hover({ position: { x: 640, y: 100 } });
    await page_a.keyboard.down("d");
    await page_a.waitForTimeout(500);
    await page_a.keyboard.up("d");
    const a_moved = await WaitFor(Debug(page_b).remote, (list: any[]) => (list.find((player) => player.username === "Player_A")?.x ?? 0) > a_start.x + 30);
    Check("Player_B sees Player_A move", (a_moved.find((player: any) => player.username === "Player_A")?.x ?? 0) > a_start.x + 30);

    const b_start = (await Debug(page_a).remote()).find((player: any) => player.username === "Player_B");
    await page_b.locator("canvas").hover({ position: { x: 640, y: 100 } });
    await page_b.keyboard.down("a");
    await page_b.waitForTimeout(400);
    await page_b.keyboard.up("a");
    const b_moved = await WaitFor(Debug(page_a).remote, (list: any[]) => (list.find((player) => player.username === "Player_B")?.x ?? 99999) < b_start.x - 25);
    Check("Player_A sees Player_B move", (b_moved.find((player: any) => player.username === "Player_B")?.x ?? 99999) < b_start.x - 25);
    await page_a.screenshot({ path: path.join(SCREENSHOT_DIR, "02_two_players.png") });
    await page_a.getByRole("button", { name: "Menu" }).click();
    const has_tile_option = await page_a.getByRole("button", { name: "Create a TileID" }).count();
    Check("pause menu hides Create a TileID for TileID holders", has_tile_option === 0);
    await page_a.getByRole("button", { name: "Continue" }).click();

    // Break the ground tile just in front of Player_A.
    const self_a = await Debug(page_a).self();
    const target = { x: Math.floor((self_a.x + 10) / 32) + 1, y: Math.floor((self_a.y + 28) / 32) };
    const before = await Debug(page_b).tile(target.x, target.y);
    const point = await Debug(page_a).screen(target.x, target.y);
    await page_a.mouse.move(point.x, point.y);
    await page_a.mouse.down();
    const broken = await WaitFor(() => Debug(page_b).tile(target.x, target.y), (tile) => tile === 0, 8000);
    await page_a.mouse.up();
    Check("Player_A breaks a block and Player_B sees it disappear", before !== 0 && broken === 0, `tile ${before} -> ${broken}`);

    // Player_B places dirt (hotbar slot 1) on an air tile above the ground near itself.
    const self_b = await Debug(page_b).self();
    const self_a_now = await Debug(page_a).self();
    const b_tile = { x: Math.floor((self_b.x + 10) / 32), y: Math.floor((self_b.y + 14) / 32) };
    const a_tile = { x: Math.floor((self_a_now.x + 10) / 32), y: Math.floor((self_a_now.y + 14) / 32) };
    let place = { x: b_tile.x - 2, y: b_tile.y };
    // Pick an empty tile with solid ground below, away from both players.
    search: for (const dy of [0, -1, 1, -2]) {
      for (const dx of [-2, 2, -1, 1]) {
        const candidate = { x: b_tile.x + dx, y: b_tile.y + dy };
        if (Math.abs(candidate.x - a_tile.x) <= 1 && Math.abs(candidate.y - a_tile.y) <= 1) continue;
        const here = await Debug(page_b).tile(candidate.x, candidate.y);
        const below = await Debug(page_b).tile(candidate.x, candidate.y + 1);
        if (here === 0 && below !== 0 && below !== 18) {
          place = candidate;
          break search;
        }
      }
    }
    await page_b.keyboard.press("1");
    const place_point = await Debug(page_b).screen(place.x, place.y);
    await page_b.mouse.click(place_point.x, place_point.y, { button: "right" });
    const placed = await WaitFor(() => Debug(page_a).tile(place.x, place.y), (tile) => tile !== 0, 6000);
    Check("Player_B places a block and Player_A sees it appear", placed === 1, `tile ${placed}`);

    await Chat(page_a, "Hello from A!");
    const chat_b = await WaitFor(() => page_b.locator(".top_log_lines").innerText(), (text) => text.includes("Hello from A!"));
    Check("Player_B receives Player_A's chat", chat_b.includes("Hello from A!"));
    await Chat(page_b, "Hi A, this is B");
    const chat_a = await WaitFor(() => page_a.locator(".top_log_lines").innerText(), (text) => text.includes("Hi A, this is B"));
    Check("Player_A receives Player_B's chat", chat_a.includes("Hi A, this is B"));

    // Drop one item: it spawns next to A and A's auto-pickup collects it again.
    const inventory_before = await page_a.evaluate(() => fetch("/api/inventory").then((response) => response.json()));
    const stone_before = inventory_before.slots.filter((slot: any) => slot.item_id === 4).reduce((sum: number, slot: any) => sum + slot.quantity, 0);
    let max_drops_seen_by_b = 0;
    const watcher = setInterval(async () => { max_drops_seen_by_b = Math.max(max_drops_seen_by_b, await Debug(page_b).drops().catch(() => 0)); }, 30);
    await page_a.keyboard.press("e");
    await page_a.locator(".inventory_slot").nth(1).click();
    await page_a.screenshot({ path: path.join(SCREENSHOT_DIR, "05_inventory.png") });
    await page_a.getByRole("button", { name: "Drop" }).click();
    await page_a.keyboard.press("Escape");
    await page_a.waitForTimeout(1500);
    clearInterval(watcher);
    const inventory_after = await page_a.evaluate(() => fetch("/api/inventory").then((response) => response.json()));
    const stone_after = inventory_after.slots.filter((slot: any) => slot.item_id === 4).reduce((sum: number, slot: any) => sum + slot.quantity, 0);
    const drops_a = await Debug(page_a).drops();
    const drops_b = await Debug(page_b).drops();
    Check("item drop + pickup keeps the world consistent", stone_after === stone_before && drops_a === drops_b, `stone ${stone_before}->${stone_after}, drops A=${drops_a} B=${drops_b}, B saw up to ${max_drops_seen_by_b}`);

    await page_a.screenshot({ path: path.join(SCREENSHOT_DIR, "03_after_actions.png") });
    await page_b.screenshot({ path: path.join(SCREENSHOT_DIR, "04_player_b_view.png") });

    await page_a.getByRole("button", { name: "Menu" }).click();
    await page_a.screenshot({ path: path.join(SCREENSHOT_DIR, "06_pause_menu.png") });
    await page_a.getByRole("button", { name: "Quit World" }).click();
    const after_leave = await WaitFor(Debug(page_b).remote, (list: any[]) => !list.some((player) => player.username === "Player_A"));
    Check("Player_A leaves and disappears for Player_B", !after_leave.some((player: any) => player.username === "Player_A"));
    await page_a.getByRole("button", { name: "Enter World" }).waitFor();
    Check("Player_A is back at world select", true);
    await page_a.screenshot({ path: path.join(SCREENSHOT_DIR, "07_world_select_after.png") });
    await page_a.getByRole("button", { name: "Manage Worlds" }).click();
    await page_a.getByRole("button", { name: "Manage", exact: true }).click();
    await page_a.getByText("Permissions").first().waitFor();
    await page_a.screenshot({ path: path.join(SCREENSHOT_DIR, "08_manage_world.png") });
  } finally {
    await browser.close();
    server.kill();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${SCREENSHOT_DIR}`);
  process.exit(failed.length ? 1 : 0);
}

Main().catch((error) => {
  console.error(error);
  process.exit(1);
});
