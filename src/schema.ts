import { z } from 'zod';

/**
 * Convert a JSON Schema (as declared by a VS Code language-model tool's inputSchema)
 * into a Zod schema that the MCP SDK accepts.
 *
 * Handles the subset of JSON Schema that VS Code tools actually use:
 * string, number, integer, boolean, array, object, enum, and required[].
 * Unknown types fall back to z.unknown() (accepts anything).
 */

/** Convert a single JSON Schema type descriptor (a property or an array item) to a Zod type. */
function typeToZod(prop: Record<string, unknown>): z.ZodTypeAny {
    const t = (prop as { type?: string | string[] }).type;
    const types = Array.isArray(t) ? t : t ? [t] : [];
    const has = (x: string) => types.includes(x);
    const en = (prop as { enum?: unknown[] }).enum;

    if (Array.isArray(en) && en.length > 0) {
        return z.enum(en.map(String) as [string, ...string[]]);
    }
    // Multi-type (e.g. ["string","number"]) → union of the supported primitives.
    if (types.length > 1) {
        const members: z.ZodTypeAny[] = [];
        if (has('string')) members.push(z.string());
        if (has('integer')) members.push(z.number().int());
        if (has('number')) members.push(z.number());
        if (has('boolean')) members.push(z.boolean());
        if (members.length > 1) {
            return z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
        }
        if (members.length === 1) {
            return members[0];
        }
        return z.unknown();
    }
    if (has('string')) {
        return z.string();
    }
    if (has('integer') || types[0] === 'integer') {
        return z.number().int();
    }
    if (has('number')) {
        return z.number();
    }
    if (has('boolean')) {
        return z.boolean();
    }
    if (has('array')) {
        const items = (prop as { items?: Record<string, unknown> }).items;
        return z.array(items && typeof items === 'object' ? jsonSchemaToZod(items) : z.unknown());
    }
    if (has('object') || types.length === 0) {
        // An object schema (has properties) or a bare object type.
        return jsonSchemaToZod(prop);
    }
    return z.unknown();
}

/** Convert a JSON Schema to a Zod schema. Object schemas get required/optional handling. */
export function jsonSchemaToZod(schema: Record<string, unknown> | undefined): z.ZodTypeAny {
    if (!schema || typeof schema !== 'object') {
        return z.object({}).passthrough();
    }

    // If this schema itself describes a primitive/array (e.g. an array item like
    // { type: 'string' } or { type: 'array', items: {...} }), convert it directly.
    const selfType = (schema as { type?: string | string[] }).type;
    if (selfType && !(selfType === 'object' || (Array.isArray(selfType) && selfType.includes('object')))) {
        return typeToZod(schema);
    }

    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, prop] of Object.entries(props)) {
        let field = typeToZod(prop);

        const desc = (prop as { description?: string }).description;
        if (desc) {
            field = field.describe(desc);
        }

        // Optional unless listed in required.
        shape[key] = required.includes(key) ? field : field.optional();
    }

    return z.object(shape);
}
