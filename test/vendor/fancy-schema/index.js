// src/index.ts
var MAX_DEPTH = 256;
function escapePointer(token) {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}
function unescapePointer(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  if (t === "boolean") return "boolean";
  if (t === "string") return "string";
  return "object";
}
function matchesType(value, want) {
  const got = typeOf(value);
  if (want === "number") return got === "number" || got === "integer";
  return got === want;
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k])
    );
  }
  return false;
}
function err(ctx, instancePath, schemaPath, keyword, message, detail) {
  ctx.errors.push({ instancePath, schemaPath, keyword, message, ...detail === void 0 ? {} : { detail } });
}
function compileRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
function resolveRef(root, ref) {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return void 0;
  let node = root;
  for (const raw of ref.slice(2).split("/")) {
    const token = unescapePointer(raw);
    if (node === null || typeof node !== "object") return void 0;
    node = node[token];
    if (node === void 0) return void 0;
  }
  return node;
}
function validateNode(schema, value, instancePath, schemaPath, ctx) {
  if (schema === true) return;
  if (schema === false) {
    err(ctx, instancePath, schemaPath, "false", "schema is `false`, so no value is valid");
    return;
  }
  if (schema === null || typeof schema !== "object") return;
  if (ctx.depth > MAX_DEPTH) {
    err(ctx, instancePath, schemaPath, "depth", `exceeded maximum depth of ${MAX_DEPTH}`);
    return;
  }
  if (typeof schema.$ref === "string") {
    const target = resolveRef(ctx.root, schema.$ref);
    if (target === void 0) {
      err(ctx, instancePath, `${schemaPath}/$ref`, "$ref", `cannot resolve "${schema.$ref}"`, schema.$ref);
      return;
    }
    ctx.depth++;
    validateNode(target, value, instancePath, `#${schema.$ref.slice(1)}`, ctx);
    ctx.depth--;
  }
  if (schema.type !== void 0) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wanted.some((t) => matchesType(value, t))) {
      err(
        ctx,
        instancePath,
        `${schemaPath}/type`,
        "type",
        `expected ${wanted.join(" or ")}, got ${typeOf(value)}`,
        typeOf(value)
      );
      return;
    }
  }
  if (schema.enum !== void 0 && !schema.enum.some((c) => deepEqual(c, value))) {
    err(ctx, instancePath, `${schemaPath}/enum`, "enum", `value is not one of the ${schema.enum.length} allowed`);
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    err(ctx, instancePath, `${schemaPath}/const`, "const", `value does not equal the required constant`);
  }
  const kind = typeOf(value);
  if (kind === "string") {
    const s = value;
    const len = [...s].length;
    if (schema.minLength !== void 0 && len < schema.minLength) {
      err(ctx, instancePath, `${schemaPath}/minLength`, "minLength", `shorter than ${schema.minLength}`, String(len));
    }
    if (schema.maxLength !== void 0 && len > schema.maxLength) {
      err(ctx, instancePath, `${schemaPath}/maxLength`, "maxLength", `longer than ${schema.maxLength}`, String(len));
    }
    if (schema.pattern !== void 0) {
      const re = compileRegex(schema.pattern);
      if (re === null) {
        err(
          ctx,
          instancePath,
          `${schemaPath}/pattern`,
          "pattern",
          `${JSON.stringify(schema.pattern)} is not a valid ECMA-262 regular expression`
        );
      } else if (!re.test(s)) {
        err(ctx, instancePath, `${schemaPath}/pattern`, "pattern", `does not match /${schema.pattern}/`);
      }
    }
  }
  if (kind === "number" || kind === "integer") {
    const n = value;
    if (schema.minimum !== void 0 && n < schema.minimum) {
      err(ctx, instancePath, `${schemaPath}/minimum`, "minimum", `less than ${schema.minimum}`);
    }
    if (schema.maximum !== void 0 && n > schema.maximum) {
      err(ctx, instancePath, `${schemaPath}/maximum`, "maximum", `greater than ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== void 0 && n <= schema.exclusiveMinimum) {
      err(ctx, instancePath, `${schemaPath}/exclusiveMinimum`, "exclusiveMinimum", `not greater than ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== void 0 && n >= schema.exclusiveMaximum) {
      err(ctx, instancePath, `${schemaPath}/exclusiveMaximum`, "exclusiveMaximum", `not less than ${schema.exclusiveMaximum}`);
    }
    if (schema.multipleOf !== void 0) {
      const q = n / schema.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) {
        err(ctx, instancePath, `${schemaPath}/multipleOf`, "multipleOf", `not a multiple of ${schema.multipleOf}`);
      }
    }
  }
  if (kind === "array") {
    const arr = value;
    if (schema.minItems !== void 0 && arr.length < schema.minItems) {
      err(ctx, instancePath, `${schemaPath}/minItems`, "minItems", `fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== void 0 && arr.length > schema.maxItems) {
      err(ctx, instancePath, `${schemaPath}/maxItems`, "maxItems", `more than ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (deepEqual(arr[i], arr[j])) {
            err(ctx, `${instancePath}/${j}`, `${schemaPath}/uniqueItems`, "uniqueItems", `duplicates item ${i}`);
          }
        }
      }
    }
    if (schema.items !== void 0) {
      ctx.depth++;
      arr.forEach((item, i) => validateNode(schema.items, item, `${instancePath}/${i}`, `${schemaPath}/items`, ctx));
      ctx.depth--;
    }
  }
  if (kind === "object") {
    const obj = value;
    if (schema.required !== void 0) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
          err(ctx, instancePath, `${schemaPath}/required`, "required", `missing required property "${key}"`, key);
        }
      }
    }
    const objKeys = Object.keys(obj);
    if (schema.minProperties !== void 0 && objKeys.length < schema.minProperties) {
      err(
        ctx,
        instancePath,
        `${schemaPath}/minProperties`,
        "minProperties",
        `has ${objKeys.length} propert${objKeys.length === 1 ? "y" : "ies"}, needs at least ${schema.minProperties}`,
        String(objKeys.length)
      );
    }
    if (schema.maxProperties !== void 0 && objKeys.length > schema.maxProperties) {
      err(
        ctx,
        instancePath,
        `${schemaPath}/maxProperties`,
        "maxProperties",
        `has ${objKeys.length} properties, allows at most ${schema.maxProperties}`,
        String(objKeys.length)
      );
    }
    if (schema.propertyNames !== void 0) {
      ctx.depth++;
      for (const key of objKeys) {
        validateNode(
          schema.propertyNames,
          key,
          `${instancePath}/${escapePointer(key)}`,
          `${schemaPath}/propertyNames`,
          ctx
        );
      }
      ctx.depth--;
    }
    if (schema.properties !== void 0) {
      ctx.depth++;
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          validateNode(
            sub,
            obj[key],
            `${instancePath}/${escapePointer(key)}`,
            `${schemaPath}/properties/${escapePointer(key)}`,
            ctx
          );
        }
      }
      ctx.depth--;
    }
    const patternMatched = /* @__PURE__ */ new Set();
    if (schema.patternProperties !== void 0) {
      ctx.depth++;
      for (const [pattern, sub] of Object.entries(schema.patternProperties)) {
        const re = compileRegex(pattern);
        if (re === null) {
          err(
            ctx,
            instancePath,
            `${schemaPath}/patternProperties/${escapePointer(pattern)}`,
            "patternProperties",
            `${JSON.stringify(pattern)} is not a valid ECMA-262 regular expression`
          );
          continue;
        }
        for (const key of objKeys) {
          if (!re.test(key)) continue;
          patternMatched.add(key);
          validateNode(
            sub,
            obj[key],
            `${instancePath}/${escapePointer(key)}`,
            `${schemaPath}/patternProperties/${escapePointer(pattern)}`,
            ctx
          );
        }
      }
      ctx.depth--;
    }
    if (schema.additionalProperties !== void 0) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of objKeys) {
        if (known.has(key) || patternMatched.has(key)) continue;
        if (schema.additionalProperties === false) {
          err(
            ctx,
            `${instancePath}/${escapePointer(key)}`,
            `${schemaPath}/additionalProperties`,
            "additionalProperties",
            `property "${key}" is not allowed`,
            key
          );
        } else {
          ctx.depth++;
          validateNode(
            schema.additionalProperties,
            obj[key],
            `${instancePath}/${escapePointer(key)}`,
            `${schemaPath}/additionalProperties`,
            ctx
          );
          ctx.depth--;
        }
      }
    }
  }
  if (schema.allOf !== void 0) {
    ctx.depth++;
    schema.allOf.forEach((sub, i) => validateNode(sub, value, instancePath, `${schemaPath}/allOf/${i}`, ctx));
    ctx.depth--;
  }
  if (schema.anyOf !== void 0) {
    if (!schema.anyOf.some((sub) => branchPasses(sub, value, ctx))) {
      err(ctx, instancePath, `${schemaPath}/anyOf`, "anyOf", `matched none of the ${schema.anyOf.length} alternatives`);
    }
  }
  if (schema.oneOf !== void 0) {
    const matched = schema.oneOf.filter((sub) => branchPasses(sub, value, ctx)).length;
    if (matched !== 1) {
      err(
        ctx,
        instancePath,
        `${schemaPath}/oneOf`,
        "oneOf",
        `matched ${matched} of the ${schema.oneOf.length} alternatives, expected exactly 1`,
        String(matched)
      );
    }
  }
  if (schema.not !== void 0 && branchPasses(schema.not, value, ctx)) {
    err(ctx, instancePath, `${schemaPath}/not`, "not", "value matches a schema it must not match");
  }
  if (schema.if !== void 0) {
    const taken = branchPasses(schema.if, value, ctx) ? schema.then : schema.else;
    if (taken !== void 0) {
      ctx.depth++;
      validateNode(taken, value, instancePath, `${schemaPath}/${taken === schema.then ? "then" : "else"}`, ctx);
      ctx.depth--;
    }
  }
}
function branchPasses(schema, value, parent) {
  const probe = { root: parent.root, errors: [], depth: parent.depth + 1 };
  validateNode(schema, value, "", "#", probe);
  return probe.errors.length === 0;
}
function validate(schema, value) {
  const ctx = { root: schema, errors: [], depth: 0 };
  validateNode(schema, value, "", "#", ctx);
  return { valid: ctx.errors.length === 0, errors: ctx.errors };
}
function compile(schema) {
  return (value) => validate(schema, value);
}

export { compile, validate };
