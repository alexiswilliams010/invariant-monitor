import type { AbiParameter, Address } from "viem";

export interface DisplayArgument {
  readonly name: string;
  readonly type: string;
  readonly value?: string | boolean | readonly DisplayArgument[];
}

export class AddressNames {
  private readonly names = new Map<Address, string>();
  private readonly used = new Set<string>();
  private next = 0;

  register(
    address: Address,
    preferred?: string | null,
    created = false,
  ): string {
    const key = address.toLowerCase() as Address;
    const existing = this.names.get(key);
    if (existing) return existing;
    const base = preferred
      ? displayText(preferred)
      : `${created ? "New_Contract" : "Contract_"}${letters(this.next++)}`;
    let name = base || `Contract_${letters(this.next++)}`;
    let suffix = 2;
    while (this.used.has(name)) name = `${base}_${suffix++}`;
    this.used.add(name);
    this.names.set(key, name);
    return name;
  }

  entries(): readonly { address: Address; name: string }[] {
    return [...this.names].map(([address, name]) => ({ address, name }));
  }
}

export function displayArguments(
  parameters: readonly AbiParameter[],
  values: readonly unknown[] | null,
  names: AddressNames,
): readonly DisplayArgument[] {
  return parameters.map((parameter, index) =>
    displayArgument(parameter, values?.[index], names, 0),
  );
}

function displayArgument(
  parameter: AbiParameter,
  value: unknown,
  names: AddressNames,
  depth: number,
): DisplayArgument {
  const result = {
    name: displayText(parameter.name ?? ""),
    type: parameter.type,
  };
  if (value === undefined || depth > 32) return result;
  const arrayType = /^(.*)\[[0-9]*\]$/.exec(parameter.type);
  if (arrayType) {
    if (!Array.isArray(value) || value.length > 256) return result;
    const element = {
      ...parameter,
      type: arrayType[1]!,
      name: "",
    } as AbiParameter;
    return {
      ...result,
      value: value.map((item) =>
        displayArgument(element, item, names, depth + 1),
      ),
    };
  }
  if (parameter.type === "tuple" && "components" in parameter) {
    if (!value || typeof value !== "object") return result;
    const components = parameter.components.map((component, index) =>
      displayArgument(
        component,
        Array.isArray(value)
          ? value[index]
          : (value as Record<string, unknown>)[component.name ?? ""],
        names,
        depth + 1,
      ),
    );
    return { ...result, value: components };
  }
  if (parameter.type === "address" && typeof value === "string")
    return { ...result, value: names.register(value as Address) };
  if (
    /^u?int/.test(parameter.type) &&
    (typeof value === "bigint" || typeof value === "number")
  )
    return { ...result, value: String(value) };
  if (parameter.type === "bool" && typeof value === "boolean")
    return { ...result, value };
  if (parameter.type === "string" && typeof value === "string")
    return { ...result, value: displayText(value) };
  return result;
}

export function displayText(value: string): string {
  return value
    .replace(/\b0x[0-9a-f]+/gi, "bytes")
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{16,}\b/gi, "bytes")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 512);
}

function letters(value: number): string {
  let result = "";
  do {
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}
