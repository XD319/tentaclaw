import type { ProviderErrorShape } from "../types/index.js";

export class ProviderError extends Error implements ProviderErrorShape {
  public readonly category: ProviderErrorShape["category"];
  public readonly details: ProviderErrorShape["details"];
  public readonly modelName: ProviderErrorShape["modelName"];
  public override readonly cause: unknown;
  public readonly providerName: string;
  public readonly retriable: boolean;
  public readonly retryCount: number;
  public readonly statusCode: number | undefined;
  public readonly summary: string;

  public constructor(shape: ProviderErrorShape) {
    super(shape.message);
    this.name = "ProviderError";
    this.category = shape.category;
    this.cause = shape.cause;
    this.details = shape.details;
    this.modelName = shape.modelName;
    this.providerName = shape.providerName;
    this.retriable = shape.retriable ?? false;
    this.retryCount = shape.retryCount ?? 0;
    this.statusCode = shape.statusCode;
    this.summary = shape.summary ?? shape.message;
  }
}
