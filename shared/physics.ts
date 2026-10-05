import { TILE_SIZE } from "./constants.ts";

export const PLAYER_WIDTH = 20;
export const PLAYER_HEIGHT = 28;
export const GRAVITY = 1700;
export const MOVE_SPEED = 210;
export const GROUND_ACCEL = 2200;
export const AIR_ACCEL = 1300;
export const FRICTION = 2400;
export const JUMP_VELOCITY = 560;
export const MAX_FALL_SPEED = 900;

export interface BodyState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  on_ground: boolean;
}

export interface MoveInput {
  left: boolean;
  right: boolean;
  jump: boolean;
}

export type SolidCheck = (tile_x: number, tile_y: number) => boolean;

function Approach(value: number, target: number, delta: number): number {
  if (value < target) return Math.min(value + delta, target);
  return Math.max(value - delta, target);
}

function OverlapsSolid(x: number, y: number, is_solid: SolidCheck): boolean {
  const left = Math.floor(x / TILE_SIZE);
  const right = Math.floor((x + PLAYER_WIDTH - 0.01) / TILE_SIZE);
  const top = Math.floor(y / TILE_SIZE);
  const bottom = Math.floor((y + PLAYER_HEIGHT - 0.01) / TILE_SIZE);
  for (let tile_y = top; tile_y <= bottom; tile_y++) {
    for (let tile_x = left; tile_x <= right; tile_x++) {
      if (is_solid(tile_x, tile_y)) return true;
    }
  }
  return false;
}

export function BodyOverlapsSolid(x: number, y: number, is_solid: SolidCheck): boolean {
  return OverlapsSolid(x, y, is_solid);
}

// Axis-separated sweep in small sub-steps so fast falls never tunnel through one-tile floors.
export function StepBody(body: BodyState, input: MoveInput, dt: number, is_solid: SolidCheck): BodyState {
  const next = { ...body };
  const direction = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const accel = next.on_ground ? GROUND_ACCEL : AIR_ACCEL;
  if (direction !== 0) next.vx = Approach(next.vx, direction * MOVE_SPEED, accel * dt);
  else next.vx = Approach(next.vx, 0, (next.on_ground ? FRICTION : AIR_ACCEL * 0.5) * dt);

  if (input.jump && next.on_ground) {
    next.vy = -JUMP_VELOCITY;
    next.on_ground = false;
  }
  next.vy = Math.min(next.vy + GRAVITY * dt, MAX_FALL_SPEED);

  const steps = Math.max(1, Math.ceil((Math.abs(next.vx) + Math.abs(next.vy)) * dt / 8));
  const sub_dt = dt / steps;
  next.on_ground = false;
  for (let i = 0; i < steps; i++) {
    const try_x = next.x + next.vx * sub_dt;
    if (OverlapsSolid(try_x, next.y, is_solid)) next.vx = 0;
    else next.x = try_x;

    const try_y = next.y + next.vy * sub_dt;
    if (OverlapsSolid(next.x, try_y, is_solid)) {
      if (next.vy > 0) {
        next.on_ground = true;
        next.y = Math.floor((try_y + PLAYER_HEIGHT) / TILE_SIZE) * TILE_SIZE - PLAYER_HEIGHT;
        if (OverlapsSolid(next.x, next.y, is_solid)) next.y = body.y;
      }
      next.vy = 0;
    } else {
      next.y = try_y;
    }
  }
  if (!next.on_ground && OverlapsSolid(next.x, next.y + 1, is_solid)) next.on_ground = true;
  return next;
}
