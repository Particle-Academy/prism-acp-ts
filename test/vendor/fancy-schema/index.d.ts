/**
 * A zero-dependency JSON Schema **Draft 2020-12** validator.
 *
 * Load a schema, validate documents, and get back errors that say WHICH
 * document and WHICH field — not just a verdict. The verdict alone moves the
 * work rather than doing it.
 *
 * Deliberately NOT here: remote `$ref` fetching over the network (a validator
 * that makes HTTP requests is a validator that fails for network reasons, and
 * the failure presents as a connectivity problem rather than a missing
 * document), compilation to generated code, and custom keyword registration.
 * Each waits for a consumer that actually asks.
 */
type Schema = boolean | SchemaObject;
interface SchemaObject {
    $ref?: string;
    $defs?: Record<string, Schema>;
    type?: JsonType | JsonType[];
    enum?: unknown[];
    const?: unknown;
    properties?: Record<string, Schema>;
    patternProperties?: Record<string, Schema>;
    propertyNames?: Schema;
    required?: string[];
    minProperties?: number;
    maxProperties?: number;
    additionalProperties?: Schema;
    items?: Schema;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
    allOf?: Schema[];
    anyOf?: Schema[];
    oneOf?: Schema[];
    not?: Schema;
    if?: Schema;
    then?: Schema;
    else?: Schema;
    /** Annotations and vocabulary we do not implement are ignored, never failed. */
    [key: string]: unknown;
}
type JsonType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
interface ValidationError {
    /** RFC 6901 JSON Pointer to the failing value, e.g. `/rows/1/n`. */
    instancePath: string;
    /** Pointer to the keyword that rejected it, e.g. `#/properties/n/type`. */
    schemaPath: string;
    /** The keyword that failed. */
    keyword: string;
    /** Human-readable, one line. */
    message: string;
    /** Extra specifics — the missing key, the unexpected property, the count. */
    detail?: string;
}
interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
}
/** Validate one document against one schema. */
declare function validate(schema: Schema, value: unknown): ValidationResult;
/**
 * Bind a schema once and validate many documents against it.
 *
 * This is the shape a corpus check actually wants: one schema, N documents,
 * told which ones failed and why.
 */
declare function compile(schema: Schema): (value: unknown) => ValidationResult;

export { type JsonType, type Schema, type SchemaObject, type ValidationError, type ValidationResult, compile, validate };
