export interface ErrorMetadata {
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfter?: string;
  readonly location?: string;
}

export class SnipeITError extends Error {
  readonly metadata: Readonly<ErrorMetadata>;

  constructor(message: string, metadata: ErrorMetadata = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.metadata = Object.freeze({ ...metadata });
  }
}

export class SnipeITConnectionError extends SnipeITError {}
export class SnipeITTimeoutError extends SnipeITError {}
export class SnipeITResponseError extends SnipeITError {}
export class SnipeITStateError extends SnipeITError {}

export class SnipeITApiError extends SnipeITError {
  readonly status: number | undefined;

  constructor(message: string, metadata: ErrorMetadata = {}, options?: ErrorOptions) {
    super(message, metadata, options);
    this.status = metadata.status;
  }
}

export class SnipeITAuthenticationError extends SnipeITApiError {}
export class SnipeITNotFoundError extends SnipeITApiError {}
export class SnipeITClientError extends SnipeITApiError {}
export class SnipeITServerError extends SnipeITApiError {}

export class SnipeITValidationError extends SnipeITApiError {
  readonly errors: unknown;

  constructor(message: string, metadata: ErrorMetadata = {}, errors?: unknown, options?: ErrorOptions) {
    super(message, metadata, options);
    this.errors = errors;
  }
}

/** Backward-friendly alias for the base library error. */
export { SnipeITError as SnipeITException };
