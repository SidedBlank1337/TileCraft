import React, { useCallback, useEffect, useState } from "react";
import { Api, OnUnauthorized } from "./services/api.ts";
import { game_socket, InstallGlobalHandlers } from "./services/socket.ts";
import { store, UseStore } from "./state/store.ts";
import { audio } from "./audio/audio_engine.ts";
import { AboutPanel, ConnectingScreen, LoginScreen, TileIdPanel, TitleScreen, WorldSelectScreen } from "./screens/front_screens.tsx";
import { GameScreen, PauseMenu, type PanelName } from "./screens/game_screen.tsx";
import { CreateWorldPanel, MyWorlds, WorldBrowser, WorldManagePanel } from "./screens/world_screens.tsx";
import { CraftingPanel, InventoryPanel, MarketPanel, ShopPanel } from "./screens/economy_screens.tsx";
import { FriendsPanel, NotificationsPanel, ProfilePanel, QuestsPanel, SettingsPanel, TradeWindow } from "./screens/social_screens.tsx";
import { AdminPanel } from "./screens/admin_screen.tsx";
import { Toasts } from "./components/ui.tsx";

type Stage = "title" | "login" | "connecting" | "worlds";

InstallGlobalHandlers();

export function App() {
  const player = UseStore((state) => state.player);
  const current_world = UseStore((state) => state.current_world);
  const [checking, set_checking] = useState(true);
  const [panel, set_panel] = useState<PanelName | null>(null);
  const [panel_world_id, set_panel_world_id] = useState<number | null>(null);
  const [joining, set_joining] = useState<string | null>(null);
  const [stage, set_stage] = useState<Stage>("title");
  const [create_name, set_create_name] = useState("");

  useEffect(() => {
    OnUnauthorized(() => {
      game_socket.Disconnect();
      store.Reset();
      set_stage("login");
    });
    Api("GET", "/auth/me")
      .then((result) => store.Set({ player: result.player }))
      .catch(() => undefined)
      .finally(() => set_checking(false));
    const unlock = () => audio.Unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    const off_expired = game_socket.On("session_expired", () => {
      store.Reset();
      set_stage("login");
      store.Toast("error", "Your session expired. Please log in again.");
    });
    const off_left = game_socket.On("world_left", () => store.Set({ current_world: null }));
    const off_error = game_socket.On("error", (data) => {
      if (data.event === "join_world") {
        set_joining(null);
        if (!game_socket.last_world_state || game_socket.last_world_state.world_name !== store.Get().current_world) {
          game_socket.Send("leave_world");
          store.Set({ current_world: null });
        }
      }
    });
    const off_state = game_socket.On("world_state", () => set_joining(null));
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      off_expired();
      off_left();
      off_error();
      off_state();
    };
  }, []);

  useEffect(() => {
    if (!current_world) audio.SetMusicContext("menu");
  }, [current_world]);

  const Open = useCallback((name: PanelName, world_id?: number) => {
    set_panel(name);
    if (world_id) set_panel_world_id(world_id);
  }, []);
  const Close = useCallback(() => set_panel(null), []);

  const Join = (world_name: string) => {
    set_panel(null);
    set_joining(world_name);
    game_socket.rejoin_world = null;
    game_socket.last_world_state = null;
    if (!game_socket.Send("join_world", { world_name })) {
      store.Toast("error", "Not connected yet. Try again in a moment.");
      set_joining(null);
      return;
    }
    // world_state flips current_world, which mounts the game screen before the engine needs it.
    store.Set({ current_world: world_name.toUpperCase() });
  };

  const Leave = () => {
    game_socket.Send("leave_world");
    game_socket.rejoin_world = null;
    game_socket.last_world_state = null;
    store.Set({ current_world: null, chat: [] });
    set_stage("worlds");
  };

  const Logout = async () => {
    await Api("POST", "/auth/logout").catch(() => undefined);
    game_socket.Disconnect();
    store.Reset();
    set_panel(null);
    set_stage("title");
  };

  const Quit = async () => {
    if (store.Get().player) await Logout();
    store.Toast("info", "Thanks for playing! You can close this tab now.");
  };

  if (checking) return <div className="loading_screen">Loading…</div>;

  let screen: React.ReactNode;
  if (current_world && player) screen = <GameScreen key={current_world} panel_open={panel !== null} on_open={Open} on_leave={Leave} />;
  else if (stage === "title" || (!player && stage !== "login")) {
    screen = <TitleScreen on_play={() => set_stage(player ? "connecting" : "login")} on_options={() => Open("settings")} on_about={() => Open("about")} on_quit={Quit} />;
  } else if (stage === "login" || !player) screen = <LoginScreen on_back={() => set_stage("title")} on_logged_in={() => set_stage("connecting")} />;
  else if (stage === "connecting") screen = <ConnectingScreen on_ready={() => set_stage("worlds")} on_cancel={() => { game_socket.Disconnect(); set_stage("title"); }} />;
  else screen = <WorldSelectScreen on_enter={Join} on_back={() => set_stage("title")} on_open={Open} on_create={(name) => { set_create_name(name); Open("create_world"); }} />;

  return (
    <>
      {screen}
      {joining && !current_world && <div className="loading_screen">Joining {joining}…</div>}
      {player && panel === "inventory" && <InventoryPanel on_close={Close} in_world={!!current_world} />}
      {panel === "crafting" && <CraftingPanel on_close={Close} />}
      {panel === "shop" && <ShopPanel on_close={Close} />}
      {panel === "market" && <MarketPanel on_close={Close} />}
      {panel === "quests" && <QuestsPanel on_close={Close} />}
      {panel === "profile" && <ProfilePanel on_close={Close} />}
      {panel === "friends" && <FriendsPanel on_close={Close} on_visit={Join} />}
      {panel === "settings" && <SettingsPanel on_close={Close} on_logout={Logout} logged_in={!!player} />}
      {panel === "notifications" && <NotificationsPanel on_close={Close} />}
      {panel === "browser" && <WorldBrowser on_close={Close} on_join={Join} />}
      {panel === "create_world" && <CreateWorldPanel on_close={Close} on_created={Join} initial_name={create_name} />}
      {panel === "about" && <AboutPanel on_close={Close} />}
      {panel === "pause" && <PauseMenu is_guest={!!player?.is_guest} on_continue={Close} on_options={() => Open("settings")} on_tile_id={() => Open("tile_id")} on_quit={() => { Close(); Leave(); }} />}
      {panel === "tile_id" && player?.is_guest && <TileIdPanel on_close={Close} />}
      {panel === "my_worlds" && <MyWorlds on_close={Close} on_join={Join} on_create={() => Open("create_world")} on_manage={(world_id) => Open("manage_world", world_id)} />}
      {panel === "manage_world" && panel_world_id && <WorldManagePanel world_id={panel_world_id} on_close={Close} />}
      {panel === "admin" && <AdminPanel on_close={Close} />}
      <TradeWindow />
      <Toasts />
    </>
  );
}
