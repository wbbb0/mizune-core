import type { Ajv, AnySchema, ValidateFunction } from "ajv";
import { LRUCache } from "lru-cache";

/**
 * Owns compiled validators by schema content, including freshly projected tool schemas.
 * Each cache miss has its own compiler: Ajv's internal strong schema/ref caches therefore
 * are owned by that validator/cache entry, rather than the lifetime of the service.
 * The limits bound retained entries and serialized schema bytes, not generated code size.
 */
export class JsonSchemaValidatorCache {
  private readonly validators: LRUCache<string, ValidateFunction>;

  constructor(
    private readonly createCompiler: () => Pick<Ajv, "compile">,
    limits: { maxEntries?: number; maxSchemaBytes?: number } = {}
  ) {
    this.validators = new LRUCache({
      max: limits.maxEntries ?? 256,
      maxSize: limits.maxSchemaBytes ?? 2 * 1024 * 1024,
      sizeCalculation: (_validator, serializedSchema) => Buffer.byteLength(serializedSchema)
    });
  }

  get(schema: AnySchema): ValidateFunction {
    const serializedSchema = JSON.stringify(schema);
    const cached = this.validators.get(serializedSchema);
    if (cached) return cached;

    // Compile an owned snapshot so later mutations cannot change a cached validator's schema.
    const validator = this.createCompiler().compile(JSON.parse(serializedSchema) as AnySchema);
    this.validators.set(serializedSchema, validator);
    return validator;
  }
}
