import type { Database } from "./database/database.ts";
import { AuthService } from "./auth/auth_service.ts";
import { EventService } from "./services/event_service.ts";
import { PlayerHub } from "./services/hub.ts";
import { PlayerService } from "./services/player_service.ts";
import { InventoryService } from "./services/inventory_service.ts";
import { NotificationService, ProgressService } from "./services/progress_service.ts";
import { WorldService } from "./services/world_service.ts";
import { CraftingService, MarketplaceService, ShopService } from "./services/economy_services.ts";
import { ActivityService, ChatService, FriendService } from "./services/social_services.ts";
import { SecurityService } from "./services/security_service.ts";
import { AdminService } from "./services/admin_service.ts";
import { WorldManager } from "./game/world_manager.ts";
import { TradeManager } from "./game/trade_manager.ts";

export interface Services {
  db: Database;
  hub: PlayerHub;
  event_service: EventService;
  security_service: SecurityService;
  player_service: PlayerService;
  auth_service: AuthService;
  inventory_service: InventoryService;
  notification_service: NotificationService;
  progress_service: ProgressService;
  world_service: WorldService;
  crafting_service: CraftingService;
  shop_service: ShopService;
  marketplace_service: MarketplaceService;
  chat_service: ChatService;
  friend_service: FriendService;
  activity_service: ActivityService;
  trade_manager: TradeManager;
  world_manager: WorldManager;
  admin_service: AdminService;
  disconnect_player: (player_id: number, message: string) => void;
  broadcast_all: (event: string, data: unknown) => void;
  refresh_identity: (player_id: number, username: string) => void;
}

// Built once; order matters because later services take earlier ones.
export async function CreateServices(db: Database): Promise<Services> {
  const hub = new PlayerHub();
  const event_service = new EventService(db);
  await event_service.Refresh();
  const security_service = new SecurityService(db);
  const player_service = new PlayerService(db, event_service, hub);
  const auth_service = new AuthService(db, player_service);
  const inventory_service = new InventoryService(db, hub);
  await inventory_service.SyncDefinitions();
  const notification_service = new NotificationService(db, hub);
  const progress_service = new ProgressService(db, player_service, inventory_service, notification_service);
  const world_service = new WorldService(db, player_service, progress_service, notification_service);
  const services = {
    db, hub, event_service, security_service, player_service, auth_service, inventory_service, notification_service, progress_service, world_service,
    crafting_service: new CraftingService(db, player_service, inventory_service, progress_service),
    shop_service: new ShopService(db, player_service, inventory_service, progress_service),
    marketplace_service: new MarketplaceService(db, player_service, inventory_service, progress_service, notification_service),
    chat_service: new ChatService(db),
    friend_service: new FriendService(db, hub, notification_service, progress_service),
    activity_service: new ActivityService(player_service, progress_service),
    trade_manager: new TradeManager(db, hub, player_service, inventory_service, progress_service, notification_service),
    disconnect_player: () => undefined,
    broadcast_all: () => undefined,
    refresh_identity: () => undefined
  } as unknown as Services;
  services.world_manager = new WorldManager(db, services);
  services.admin_service = new AdminService(db, services);
  world_service.live_counts = (world_id) => services.world_manager.LiveCount(world_id);
  return services;
}
