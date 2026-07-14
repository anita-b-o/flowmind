import { Injectable } from "@nestjs/common";

@Injectable()
export class ExpressionResolver {
  resolveValue(value: unknown, context: Record<string, unknown>): unknown {
    if (typeof value === "string") {
      return this.resolveString(value, context);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.resolveValue(item, context));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.resolveValue(entry, context)])
      );
    }
    return value;
  }

  private resolveString(value: string, context: Record<string, unknown>) {
    return value.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path: string) => {
      const resolved = this.readPath(context, path);
      return resolved === undefined || resolved === null ? "" : String(resolved);
    });
  }

  private readPath(source: Record<string, unknown>, path: string) {
    const blocked = new Set(["__proto__", "prototype", "constructor"]);
    return path.split(".").reduce<unknown>((current, segment) => {
      if (blocked.has(segment) || !current || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, source);
  }
}
