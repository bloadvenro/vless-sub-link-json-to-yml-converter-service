import { ConversionError } from "./errors.js";

export type JsonObject = Record<string, unknown>;

const controlCharacter = /\p{Cc}/u;

export const fail = (): never => {
  throw new ConversionError();
};

export const object = (value: unknown): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail();
  }
  return value as JsonObject;
};

export const exactObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject => {
  const result = object(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some((key) => !allowed.has(key))
  ) {
    return fail();
  }
  return result;
};

export const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    return fail();
  }
  return value;
};

export const string = (value: unknown): string => {
  if (typeof value !== "string") {
    return fail();
  }
  return value;
};

export const integer = (value: unknown, minimum: number, maximum: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return fail();
  }
  return value;
};

export const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") {
    return fail();
  }
  return value;
};

export interface StringRules {
  readonly minBytes?: number;
  readonly maxBytes: number;
  readonly nonblank?: boolean;
  readonly noControls?: boolean;
  readonly noEdgeWhitespace?: boolean;
}

export const checkedString = (value: unknown, rules: StringRules): string => {
  const result = string(value);
  const bytes = Buffer.byteLength(result, "utf8");
  if (
    bytes < (rules.minBytes ?? 0) ||
    bytes > rules.maxBytes ||
    (rules.nonblank === true && result.trim() === "") ||
    (rules.noControls === true && controlCharacter.test(result)) ||
    (rules.noEdgeWhitespace === true && result.trim() !== result)
  ) {
    return fail();
  }
  return result;
};

export const identityString = (value: unknown, maxBytes: number): string =>
  checkedString(value, {
    minBytes: 1,
    maxBytes,
    nonblank: true,
    noControls: true,
    noEdgeWhitespace: true,
  });

export const controlFreeString = (
  value: unknown,
  minBytes: number,
  maxBytes: number,
): string =>
  checkedString(value, {
    minBytes,
    maxBytes,
    nonblank: minBytes > 0,
    noControls: true,
  });

export const literal = <T extends string | number | boolean>(
  value: unknown,
  expected: T,
): T => {
  if (value !== expected) {
    return fail();
  }
  return expected;
};

export const oneOf = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T => {
  const result = string(value);
  if (!allowed.has(result as T)) {
    return fail();
  }
  return result as T;
};
