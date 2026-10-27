import { Type, type Static } from 'typebox';

/** Typed error codes returned by every Map Services endpoint. */
export const ERROR_CODES = {
  INVALID_REQUEST: 400,
  QUERY_TOO_LONG: 400,
  LIMIT_EXCEEDED: 400,
  BBOX_TOO_LARGE: 400,
  UNKNOWN_PRESET: 400,
  UNSUPPORTED_COMBINATION: 422,
  NO_ROUTE: 422,
  POINT_NOT_ROUTABLE: 422,
  NOT_FOUND: 404,
  DATASET_MISMATCH: 409,
  PAYLOAD_TOO_LARGE: 413,
  OVERLOADED: 503,
  MAINTENANCE: 503,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_REVISION_MISMATCH: 503,
  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  DEADLINE_EXCEEDED: 504,
  CANCELLED: 499,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ErrorCodeSchema = Type.Enum<ErrorCode[]>(Object.keys(ERROR_CODES) as ErrorCode[]);

export const ErrorBodySchema = Type.Object(
  {
    error: Type.Object({
      code: ErrorCodeSchema,
      message: Type.String(),
      request_id: Type.String(),
      provider: Type.Optional(Type.String()),
      dataset_id: Type.Optional(Type.String()),
      details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  },
  { $id: 'ErrorBody', description: 'Typed error envelope. HTTP status follows the code.' },
);
export type ErrorBody = Static<typeof ErrorBodySchema>;

/** Error raised inside the API; serialized into ErrorBody by the error handler. */
export class MapServiceError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly provider: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, opts: { provider?: string; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'MapServiceError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.provider = opts.provider;
    this.details = opts.details;
  }
}
