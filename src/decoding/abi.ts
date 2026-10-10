import {
  decodeAbiParameters,
  encodeAbiParameters,
  toFunctionSelector,
  type AbiParameter,
  type Hex,
} from "viem";
import { array, object } from "../collection/validation.js";

export interface Callable {
  readonly name: string;
  readonly signature: string;
  readonly selector: Hex;
  readonly inputs: readonly AbiParameter[];
  readonly outputs: readonly AbiParameter[];
}

export class AbiDecoder {
  private readonly functions = new Map<string, Callable[]>();

  constructor(abi: readonly unknown[]) {
    for (const value of abi) {
      try {
        const item = object(value, "ABI item");
        if (item.type !== "function") continue;
        if (
          typeof item.name !== "string" ||
          !/^[A-Za-z_$][\w$]*$/.test(item.name)
        )
          continue;
        const inputs = parameters(item.inputs);
        const outputs = parameters(item.outputs);
        const signature = `${item.name}(${inputs.map(parameterSignature).join(",")})`;
        const selector = toFunctionSelector(signature);
        const entry = { name: item.name, signature, selector, inputs, outputs };
        const existing = this.functions.get(selector) ?? [];
        // Duplicate declarations and selector collisions must not choose an arbitrary ABI.
        if (
          !existing.some(
            (other) => JSON.stringify(other) === JSON.stringify(entry),
          )
        )
          existing.push(entry);
        this.functions.set(selector, existing);
      } catch {
        /* Unsupported compiler types remain undecoded. */
      }
    }
  }

  decode(
    input: Hex,
  ): { callable: Callable; args: readonly unknown[] | null } | null {
    const candidates = this.functions.get(input.slice(0, 10));
    if (!candidates || candidates.length !== 1) return null;
    const callable = candidates[0]!;
    return {
      callable,
      args: decodeValues(callable.inputs, `0x${input.slice(10)}`),
    };
  }
}

export function decodeValues(
  parameters: readonly AbiParameter[],
  data: Hex,
): readonly unknown[] | null {
  try {
    const decoded = decodeAbiParameters(parameters, data);
    if (
      encodeAbiParameters(parameters, decoded).toLowerCase() !==
      data.toLowerCase()
    )
      return null;
    return decoded;
  } catch {
    return null;
  }
}

function parameters(value: unknown, depth = 0): readonly AbiParameter[] {
  if (depth > 32) throw new Error("ABI nesting limit.");
  return array(value, "ABI parameters").map((entry) => {
    const item = object(entry, "ABI parameter");
    if (
      typeof item.type !== "string" ||
      (item.name !== undefined && typeof item.name !== "string")
    )
      throw new Error("Invalid ABI parameter.");
    const match =
      /^(tuple|address|bool|string|bytes(?:[1-9]|[12][0-9]|3[0-2])?|u?int(?:[0-9]+)?)((?:\[(?:[1-9][0-9]*)?\])*)$/.exec(
        item.type,
      );
    if (!match) throw new Error("Unsupported ABI type.");
    let base = match[1]!;
    if (base === "uint" || base === "int") base += "256";
    if (/^u?int/.test(base)) {
      const width = Number(base.replace(/^u?int/, ""));
      if (width < 8 || width > 256 || width % 8 !== 0)
        throw new Error("Invalid integer width.");
    }
    const common = { name: item.name ?? "", type: `${base}${match[2]}` };
    return base === "tuple"
      ? { ...common, components: parameters(item.components, depth + 1) }
      : common;
  }) as readonly AbiParameter[];
}

function parameterSignature(parameter: AbiParameter): string {
  if (parameter.type.startsWith("tuple") && "components" in parameter)
    return `(${parameter.components.map(parameterSignature).join(",")})${parameter.type.slice(5)}`;
  return parameter.type;
}
