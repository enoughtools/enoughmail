import { z } from 'zod';
import type { McpSchema } from '@open-cloud/contracts';

/** Compile the bounded manifest subset, using the same schema for discovery and calls. */
export function compileMcpSchema(schema: McpSchema): z.ZodType {
  let validator: z.ZodType;
  switch (schema.type) {
    case 'object': {
      const required = new Set(schema.required ?? []);
      const fields = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, value]) => {
        const compiled = compileMcpSchema(value);
        return [name, required.has(name) ? compiled : compiled.optional()];
      }));
      validator = z.object(fields).strict();
      break;
    }
    case 'array': validator = z.array(compileMcpSchema(schema.items!)).max(schema.maxItems!); break;
    case 'string': {
      let field = z.string().max(schema.maxLength!);
      if (schema.minLength !== undefined) field = field.min(schema.minLength);
      validator = field;
      break;
    }
    case 'number':
    case 'integer': {
      let field = schema.type === 'integer' ? z.number().int() : z.number();
      if (schema.minimum !== undefined) field = field.min(schema.minimum);
      if (schema.maximum !== undefined) field = field.max(schema.maximum);
      validator = field;
      break;
    }
    case 'boolean': validator = z.boolean(); break;
  }
  if (schema.enum) validator = validator.refine((value) => schema.enum!.includes(value as string | number | boolean), 'Use a declared value.');
  return schema.description ? validator.describe(schema.description) : validator;
}
