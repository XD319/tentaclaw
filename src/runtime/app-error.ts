import { ProviderError } from "../providers";
import type { RuntimeErrorCode, RuntimeErrorShape } from "../types";

export class AppError extends Error implements RuntimeErrorShape {
  public readonly code: RuntimeErrorCode;
  public readonly details: Record<string, unknown> | undefined;
  public override readonly cause: unknown;

  public constructor(shape: RuntimeErrorShape) {
    super(shape.message);
    this.name = "AppError";
    this.code = shape.code;
    this.details = shape.details;
    this.cause = shape.cause;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof ProviderError) {
    return new AppError({
      cause: error,
      code: "provider_error",
      details: {
        providerErrorSummary: error.summary,
        providerCategory: error.category,
        providerName: error.providerName,
        modelName: error.modelName ?? null,
        retriable: error.retriable,
        retryCount: error.retryCount,
        statusCode: error.statusCode ?? null
      },
      message: error.message
    });
  }

  if (error instanceof Error) {
    return new AppError({
      cause: error,
      code: "provider_error",
      message: error.message
    });
  }

  return new AppError({
    cause: error,
    code: "provider_error",
    message: "Unknown error"
  });
}
