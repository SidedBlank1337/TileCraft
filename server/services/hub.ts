type Sender = (player_id: number, event: string, data: unknown) => void;

// Lets services push to online players without importing the WebSocket layer.
export class PlayerHub {
  private sender: Sender = () => undefined;
  private online_check: (player_id: number) => boolean = () => false;

  Attach(sender: Sender, online_check: (player_id: number) => boolean): void {
    this.sender = sender;
    this.online_check = online_check;
  }

  Send(player_id: number, event: string, data: unknown): void {
    this.sender(player_id, event, data);
  }

  IsOnline(player_id: number): boolean {
    return this.online_check(player_id);
  }
}
