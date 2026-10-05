export class GameError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class AuthError extends GameError {
  constructor(message = "Please log in.") {
    super("unauthorized", message, 401);
  }
}

export class ForbiddenError extends GameError {
  constructor(message = "You are not allowed to do that.") {
    super("forbidden", message, 403);
  }
}

export class NotFoundError extends GameError {
  constructor(message = "Not found.") {
    super("not_found", message, 404);
  }
}

export class ValidationError extends GameError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("invalid", message, 400, details);
  }
}

export class InsufficientError extends GameError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("insufficient", message, 409, details);
  }
}

export class RateLimitError extends GameError {
  constructor(message = "Slow down a little.") {
    super("rate_limited", message, 429);
  }
}
