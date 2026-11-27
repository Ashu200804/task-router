export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class InvalidError extends AppError {
  constructor(message: string) {
    super(400, 'invalid', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'not_found', message);
  }
}

/** The caller acted on information that is no longer true. */
export class StaleError extends AppError {
  constructor(message: string) {
    super(409, 'stale', message);
  }
}

/** The same idempotency key was used for a different request. */
export class KeyReusedError extends AppError {
  constructor() {
    super(422, 'key_reused', 'This idempotency key was already used for a different request.');
  }
}

/** Retrying cannot help, so the queue should give up at once. */
export class PermanentError extends Error {}

export class UnauthorizedError extends AppError {
  constructor(message = 'Sign in again.') {
    super(401, 'unauthorized', message);
  }
}

/** Signed in, but this is not theirs to see or do. */
export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(403, 'forbidden', message);
  }
}
