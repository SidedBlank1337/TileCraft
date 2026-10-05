import React, { useEffect, useRef } from "react";
import { GetItem } from "../../shared/items.ts";
import type { Appearance } from "../../shared/cosmetics.ts";
import { ItemIconUrl, DrawCharacter } from "../game/textures.ts";
import { audio } from "../audio/audio_engine.ts";
import { UseStore } from "../state/store.ts";

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; small?: boolean }) {
  const { variant = "primary", small, className, onClick, ...rest } = props;
  return (
    <button
      {...rest}
      className={`pixel_button pixel_button_${variant} ${small ? "pixel_button_small" : ""} ${className ?? ""}`}
      onClick={(event) => {
        audio.Play("click");
        onClick?.(event);
      }}
    />
  );
}

export function Panel(props: { title: string; on_close: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.on_close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [props.on_close]);
  return (
    <div className="panel_backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.on_close()}>
      <section className={`pixel_panel ${props.wide ? "pixel_panel_wide" : ""}`} role="dialog" aria-label={props.title}>
        <header className="panel_header">
          <h2>{props.title}</h2>
          <button className="panel_close" aria-label="Close" onClick={props.on_close}>✕</button>
        </header>
        <div className="panel_body">{props.children}</div>
      </section>
    </div>
  );
}

export function ItemIcon(props: { item_id: number; size?: number; quantity?: number }) {
  const item = GetItem(props.item_id);
  const size = props.size ?? 32;
  if (!item) return null;
  return (
    <span className={`item_icon rarity_${item.rarity}`} style={{ width: size, height: size }} title={item.name}>
      <img src={ItemIconUrl(props.item_id)} width={size} height={size} alt={item.name} draggable={false} />
      {props.quantity !== undefined && props.quantity > 1 && <span className="item_quantity">{props.quantity}</span>}
    </span>
  );
}

export function Coins(props: { amount: number }) {
  return (
    <span className="coin_amount">
      <span className="coin_glyph" aria-hidden>●</span>
      {props.amount.toLocaleString()}
    </span>
  );
}

export function Avatar(props: { appearance: Appearance; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = props.size ?? 64;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = size / 36;
    DrawCharacter(ctx, size / 2 - 10 * scale, size * 0.28, props.appearance, 1, "idle", 0, scale);
  }, [props.appearance, size]);
  return <canvas ref={ref} width={size} height={size} className="avatar_canvas" />;
}

export function Toasts() {
  const toasts = UseStore((state) => state.toasts);
  return (
    <div className="toast_stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.toast_id} className={`toast toast_${toast.kind}`}>{toast.message}</div>
      ))}
    </div>
  );
}

export function ConnectionBadge() {
  const connection = UseStore((state) => state.connection);
  const labels: Record<string, string> = { connected: "Connected", connecting: "Connecting…", reconnecting: "Reconnecting…", lost: "Connection Lost", offline: "Offline" };
  return <span className={`connection_badge connection_${connection}`}>{labels[connection]}</span>;
}

export function ErrorLine(props: { message: string | null }) {
  if (!props.message) return null;
  return <p className="error_line" role="alert">{props.message}</p>;
}

export function TimeAgo(props: { time: number }) {
  const seconds = Math.floor((Date.now() - props.time) / 1000);
  let text: string;
  if (seconds < 60) text = "just now";
  else if (seconds < 3600) text = `${Math.floor(seconds / 60)}m ago`;
  else if (seconds < 86400) text = `${Math.floor(seconds / 3600)}h ago`;
  else text = `${Math.floor(seconds / 86400)}d ago`;
  return <span title={new Date(props.time).toLocaleString()}>{text}</span>;
}

export function UseAsync<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, set_data] = React.useState<T | null>(null);
  const [error, set_error] = React.useState<string | null>(null);
  const [tick, set_tick] = React.useState(0);
  useEffect(() => {
    let alive = true;
    loader()
      .then((result) => alive && (set_data(result), set_error(null)))
      .catch((caught) => alive && set_error(caught instanceof Error ? caught.message : "Failed to load."));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => set_tick((value) => value + 1) };
}
