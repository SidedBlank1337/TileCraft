import { GetItem, type ItemDefinition } from "../../shared/items.ts";
import { COSMETICS_BY_KEY, type Appearance } from "../../shared/cosmetics.ts";

const SIZE = 32;
const texture_cache = new Map<string, HTMLCanvasElement>();
const icon_url_cache = new Map<number, string>();

function Hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function Canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return [canvas, ctx];
}

function Speckle(ctx: CanvasRenderingContext2D, item: ItemDefinition, density: number, cell = 2): void {
  const [base, dark, light] = item.palette;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let y = 0; y < SIZE; y += cell) {
    for (let x = 0; x < SIZE; x += cell) {
      const roll = Hash(item.item_id, x, y);
      if (roll < density) ctx.fillStyle = dark;
      else if (roll > 1 - density * 0.6) ctx.fillStyle = light;
      else continue;
      ctx.fillRect(x, y, cell, cell);
    }
  }
}

function Bevel(ctx: CanvasRenderingContext2D, light: string, dark: string): void {
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, SIZE, 2);
  ctx.fillRect(0, 0, 2, SIZE);
  ctx.fillStyle = dark;
  ctx.fillRect(0, SIZE - 2, SIZE, 2);
  ctx.fillRect(SIZE - 2, 0, 2, SIZE);
  ctx.globalAlpha = 1;
}

function DrawTile(ctx: CanvasRenderingContext2D, item: ItemDefinition): void {
  const [base, dark, light] = item.palette;
  switch (item.pattern) {
    case "noise":
    case "wall":
      Speckle(ctx, item, 0.18);
      Bevel(ctx, light, dark);
      break;
    case "sand":
      Speckle(ctx, item, 0.25, 1);
      break;
    case "grass": {
      Speckle(ctx, { ...item, palette: [base, "#6b4329", "#a87150"] }, 0.18);
      for (let x = 0; x < SIZE; x += 2) {
        const depth = 6 + Math.floor(Hash(item.item_id, x, 99) * 5);
        ctx.fillStyle = dark;
        ctx.fillRect(x, 0, 2, depth);
        ctx.fillStyle = light;
        ctx.fillRect(x, 0, 2, Math.max(2, depth - 4));
      }
      break;
    }
    case "ore": {
      Speckle(ctx, { ...item, palette: [base, "#5f646b", "#a2a7ad"] }, 0.15);
      for (let i = 0; i < 6; i++) {
        const x = 3 + Math.floor(Hash(item.item_id, i, 1) * 24);
        const y = 3 + Math.floor(Hash(item.item_id, i, 2) * 24);
        ctx.fillStyle = dark;
        ctx.fillRect(x, y, 5, 4);
        ctx.fillStyle = light;
        ctx.fillRect(x + 1, y, 2, 2);
      }
      Bevel(ctx, "#ffffff", "#000000");
      break;
    }
    case "brick": {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.fillStyle = dark;
      for (let row = 0; row < 4; row++) {
        ctx.fillRect(0, row * 8 + 7, SIZE, 1);
        const offset = row % 2 === 0 ? 0 : 8;
        for (let x = offset; x < SIZE; x += 16) ctx.fillRect(x, row * 8, 1, 8);
      }
      ctx.fillStyle = light;
      for (let row = 0; row < 4; row++) ctx.fillRect(1, row * 8, SIZE - 2, 1);
      break;
    }
    case "plank": {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, SIZE, SIZE);
      for (let row = 0; row < 4; row++) {
        ctx.fillStyle = dark;
        ctx.fillRect(0, row * 8 + 7, SIZE, 1);
        ctx.fillRect(row % 2 ? 20 : 8, row * 8, 1, 7);
        ctx.fillStyle = light;
        for (let x = 2; x < SIZE; x += 6) if (Hash(item.item_id, x, row) > 0.5) ctx.fillRect(x, row * 8 + 3, 3, 1);
      }
      break;
    }
    case "log": {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, SIZE, SIZE);
      for (let x = 0; x < SIZE; x += 4) {
        ctx.fillStyle = Hash(item.item_id, x, 5) > 0.5 ? dark : light;
        ctx.fillRect(x, 0, 2, SIZE);
      }
      break;
    }
    case "leaf": {
      ctx.fillStyle = dark;
      ctx.fillRect(0, 0, SIZE, SIZE);
      for (let y = 0; y < SIZE; y += 4) {
        for (let x = 0; x < SIZE; x += 4) {
          const roll = Hash(item.item_id, x, y);
          ctx.fillStyle = roll > 0.6 ? light : base;
          ctx.fillRect(x, y, 4, 4);
          if (roll < 0.08) ctx.clearRect(x, y, 4, 4);
        }
      }
      break;
    }
    case "crystal": {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, SIZE, SIZE);
      for (let i = 0; i < 4; i++) {
        const x = 4 + i * 7;
        const height = 10 + Math.floor(Hash(item.item_id, i, 3) * 14);
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.moveTo(x, SIZE - 2);
        ctx.lineTo(x + 3, SIZE - 2 - height);
        ctx.lineTo(x + 6, SIZE - 2);
        ctx.fill();
        ctx.fillStyle = light;
        ctx.fillRect(x + 2, SIZE - height + 2, 1, height - 6);
      }
      Bevel(ctx, light, "#000000");
      break;
    }
    case "glass": {
      ctx.fillStyle = base;
      ctx.globalAlpha = 0.3;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = dark;
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, SIZE - 2, SIZE - 2);
      ctx.fillStyle = light;
      for (let i = 0; i < 8; i++) ctx.fillRect(6 + i, 18 - i, 2, 2);
      break;
    }
    case "moss": {
      Speckle(ctx, { ...item, palette: [base, "#1a3029", "#305a4d"] }, 0.2);
      for (let i = 0; i < 9; i++) {
        const x = Math.floor(Hash(item.item_id, i, 7) * 28) + 2;
        const y = Math.floor(Hash(item.item_id, i, 8) * 28) + 2;
        ctx.fillStyle = dark;
        ctx.fillRect(x, y, 3, 3);
        ctx.fillStyle = light;
        ctx.fillRect(x + 1, y + 1, 1, 1);
      }
      break;
    }
    case "water": {
      ctx.globalAlpha = 0.65;
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.fillStyle = light;
      for (let y = 4; y < SIZE; y += 9) for (let x = (y * 3) % 8; x < SIZE; x += 12) ctx.fillRect(x, y, 6, 1);
      ctx.globalAlpha = 1;
      break;
    }
    case "chest": {
      Speckle(ctx, { ...item, palette: ["#5f646b", "#4b4f5a", "#80858c"] }, 0.15);
      ctx.fillStyle = base;
      ctx.fillRect(5, 9, 22, 17);
      ctx.fillStyle = light;
      ctx.fillRect(5, 9, 22, 4);
      ctx.fillStyle = dark;
      ctx.fillRect(5, 15, 22, 2);
      ctx.fillRect(14, 13, 4, 6);
      break;
    }
    case "beacon": {
      ctx.fillStyle = base;
      ctx.fillRect(11, 8, 10, 24);
      ctx.fillStyle = dark;
      ctx.fillRect(9, 2, 14, 8);
      ctx.fillStyle = light;
      ctx.fillRect(12, 4, 8, 4);
      break;
    }
    case "lantern": {
      ctx.fillStyle = base;
      ctx.fillRect(15, 0, 2, 6);
      ctx.fillRect(9, 6, 14, 3);
      ctx.fillRect(9, 24, 14, 3);
      ctx.fillStyle = dark;
      ctx.fillRect(10, 9, 12, 15);
      ctx.fillStyle = light;
      ctx.fillRect(13, 12, 6, 9);
      break;
    }
    case "shrine": {
      ctx.fillStyle = base;
      ctx.fillRect(4, 6, 6, 26);
      ctx.fillRect(22, 6, 6, 26);
      ctx.fillRect(2, 2, 28, 6);
      ctx.fillStyle = dark;
      ctx.fillRect(12, 12, 8, 12);
      ctx.fillStyle = light;
      ctx.fillRect(14, 15, 4, 6);
      break;
    }
    case "core": {
      Speckle(ctx, item, 0.25);
      ctx.fillStyle = "#5b2a86";
      for (let i = 0; i < 4; i++) ctx.fillRect(Math.floor(Hash(item.item_id, i, 9) * 28), Math.floor(Hash(item.item_id, i, 10) * 30), 4, 1);
      break;
    }
    default:
      DrawIcon(ctx, item);
  }
}

function DrawIcon(ctx: CanvasRenderingContext2D, item: ItemDefinition): void {
  const [base, dark, light] = item.palette;
  ctx.clearRect(0, 0, SIZE, SIZE);
  if (item.kind === "seed") {
    ctx.fillStyle = dark;
    ctx.fillRect(14, 4, 4, 8);
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.ellipse(16, 20, 8, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = light;
    ctx.fillRect(12, 15, 3, 5);
    return;
  }
  if (item.kind === "tool") {
    if (item.category === "rod") {
      ctx.strokeStyle = base;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(6, 28);
      ctx.lineTo(26, 4);
      ctx.stroke();
      ctx.strokeStyle = light;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(26, 4);
      ctx.lineTo(27, 22);
      ctx.stroke();
      return;
    }
    ctx.fillStyle = dark;
    ctx.save();
    ctx.translate(16, 16);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-2, -12, 4, 26);
    ctx.restore();
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.moveTo(4, 10);
    ctx.quadraticCurveTo(16, -2, 28, 10);
    ctx.lineTo(24, 12);
    ctx.quadraticCurveTo(16, 4, 8, 12);
    ctx.fill();
    ctx.fillStyle = light;
    ctx.fillRect(14, 4, 4, 2);
    return;
  }
  if (item.category === "fish") {
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.ellipse(14, 16, 10, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(22, 16);
    ctx.lineTo(30, 9);
    ctx.lineTo(30, 23);
    ctx.fill();
    ctx.fillStyle = light;
    ctx.fillRect(7, 14, 2, 2);
    ctx.fillStyle = dark;
    ctx.fillRect(10, 19, 10, 1);
    return;
  }
  if (item.kind === "fruit") {
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.arc(16, 18, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3a8a2a";
    ctx.fillRect(15, 4, 3, 6);
    ctx.fillRect(18, 5, 6, 3);
    ctx.fillStyle = light;
    ctx.fillRect(11, 13, 4, 4);
    return;
  }
  if (item.kind === "consumable") {
    ctx.fillStyle = "#e9c46a";
    ctx.fillRect(4, 16, 24, 10);
    ctx.fillStyle = base;
    ctx.fillRect(6, 12, 20, 6);
    ctx.fillStyle = light;
    for (let x = 8; x < 26; x += 5) ctx.fillRect(x, 10, 3, 3);
    return;
  }
  // Ingots, shards and dust: a faceted bar.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(4, 24);
  ctx.lineTo(10, 12);
  ctx.lineTo(28, 12);
  ctx.lineTo(28, 24);
  ctx.fill();
  ctx.fillStyle = base;
  ctx.fillRect(10, 12, 18, 8);
  ctx.fillStyle = light;
  ctx.fillRect(12, 13, 10, 2);
}

export function GetTexture(item_id: number): HTMLCanvasElement | null {
  const key = `t${item_id}`;
  const cached = texture_cache.get(key);
  if (cached) return cached;
  const item = GetItem(item_id);
  if (!item || item.item_id === 0) return null;
  const [canvas, ctx] = Canvas();
  if (item.kind === "block" || item.kind === "background") DrawTile(ctx, item);
  else DrawIcon(ctx, item);
  texture_cache.set(key, canvas);
  return canvas;
}

// Trees are drawn from the seed palette: [fruit/primary, leaves, highlight].
export function GetTreeTexture(item_id: number, stage: number): HTMLCanvasElement | null {
  const key = `tree${item_id}_${stage}`;
  const cached = texture_cache.get(key);
  if (cached) return cached;
  const item = GetItem(item_id);
  if (!item) return null;
  const [canvas, ctx] = Canvas();
  const [primary, leaves, light] = item.palette;
  if (stage === 0) {
    ctx.fillStyle = primary;
    ctx.fillRect(13, 26, 6, 6);
  } else {
    const height = [0, 8, 16, 24, 28][stage];
    ctx.fillStyle = "#6b4a2b";
    ctx.fillRect(14, SIZE - height, 4, height);
    ctx.fillStyle = leaves;
    const radius = [0, 4, 7, 10, 12][stage];
    ctx.beginPath();
    ctx.arc(16, SIZE - height, radius, 0, Math.PI * 2);
    ctx.fill();
    if (stage >= 3) {
      ctx.fillStyle = light;
      ctx.fillRect(10, SIZE - height - 4, 3, 3);
    }
    if (stage === 4) {
      ctx.fillStyle = primary;
      for (const [x, y] of [[9, 6], [20, 4], [14, 10], [22, 12], [7, 13]]) ctx.fillRect(x, y, 4, 4);
    }
  }
  texture_cache.set(key, canvas);
  return canvas;
}

export function ItemIconUrl(item_id: number): string {
  const cached = icon_url_cache.get(item_id);
  if (cached) return cached;
  const texture = GetTexture(item_id);
  const url = texture ? texture.toDataURL() : "";
  icon_url_cache.set(item_id, url);
  return url;
}

const SKIN = "#f1c27d";

function CosmeticColor(key: string | undefined, fallback: string): string {
  return (key && COSMETICS_BY_KEY.get(key)?.color) || fallback;
}

// Characters are 20x28 px at scale 1, drawn with x,y at the body's top-left.
export function DrawCharacter(ctx: CanvasRenderingContext2D, x: number, y: number, appearance: Appearance, facing: number, anim: string, time: number, scale = 1): void {
  ctx.save();
  ctx.translate(Math.round(x + 10 * scale), Math.round(y));
  ctx.scale(facing * scale, scale);
  const walk = anim === "walk" ? Math.sin(time / 80) * 3 : 0;
  const hair = appearance.hair ? COSMETICS_BY_KEY.get(appearance.hair) : undefined;
  const hat = appearance.hat ? COSMETICS_BY_KEY.get(appearance.hat) : undefined;
  const accessory = appearance.accessory ? COSMETICS_BY_KEY.get(appearance.accessory) : undefined;

  if (accessory?.style === "cape") {
    ctx.fillStyle = accessory.color;
    ctx.fillRect(-8, 11, 4, 14 + Math.abs(walk));
  }
  ctx.fillStyle = CosmeticColor(appearance.shoes, "#3a2414");
  ctx.fillRect(-6 + walk, 25, 5, 3);
  ctx.fillRect(1 - walk, 25, 5, 3);
  ctx.fillStyle = CosmeticColor(appearance.pants, "#3d405b");
  ctx.fillRect(-6 + walk * 0.6, 19, 5, 6);
  ctx.fillRect(1 - walk * 0.6, 19, 5, 6);
  ctx.fillStyle = CosmeticColor(appearance.shirt, "#4361ee");
  ctx.fillRect(-7, 11, 14, 9);
  ctx.fillStyle = SKIN;
  const arm_swing = anim === "punch" ? 6 : walk;
  ctx.fillRect(5, 12 + (anim === "punch" ? -2 : 0), 3 + (anim === "punch" ? 4 : 0), 6 - Math.abs(arm_swing) * 0.2);
  ctx.fillRect(-8, 12, 3, 6);
  ctx.fillRect(-6, 1, 12, 10);
  ctx.fillStyle = "#222";
  ctx.fillRect(2, 5, 2, 2);
  ctx.fillRect(-2, 5, 1, 2);
  if (hair) {
    ctx.fillStyle = hair.color;
    if (hair.style === "spiky") for (let i = -6; i < 6; i += 3) ctx.fillRect(i, -2 + ((i + 6) % 2), 3, 4);
    else if (hair.style === "long") ctx.fillRect(-7, 0, 4, 14);
    else if (hair.style === "bob") ctx.fillRect(-7, 0, 4, 9);
    ctx.fillRect(-6, 0, 12, hair.style === "buzz" ? 2 : 3);
  }
  if (accessory?.style === "goggles") {
    ctx.fillStyle = accessory.color;
    ctx.fillRect(-6, 4, 12, 3);
    ctx.fillStyle = "#9ef0ff";
    ctx.fillRect(1, 4, 3, 3);
  } else if (accessory?.style === "scarf") {
    ctx.fillStyle = accessory.color;
    ctx.fillRect(-7, 10, 14, 3);
    ctx.fillRect(-7, 12, 3, 5);
  }
  if (hat) {
    ctx.fillStyle = hat.color;
    if (hat.style === "cap") {
      ctx.fillRect(-6, -2, 12, 4);
      ctx.fillRect(2, 0, 7, 2);
    } else if (hat.style === "wizard") {
      ctx.beginPath();
      ctx.moveTo(-8, 1);
      ctx.lineTo(0, -14);
      ctx.lineTo(8, 1);
      ctx.fill();
      ctx.fillStyle = "#ffd166";
      ctx.fillRect(-1, -7, 2, 2);
    } else if (hat.style === "top") {
      ctx.fillRect(-8, -1, 16, 2);
      ctx.fillRect(-5, -10, 10, 9);
    } else if (hat.style === "crown") {
      for (let i = -6; i < 6; i += 4) ctx.fillRect(i, -4, 2, 5);
      ctx.fillRect(-6, -1, 12, 2);
    }
  }
  ctx.restore();
}
