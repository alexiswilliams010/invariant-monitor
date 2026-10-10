import type { Chain } from "viem";
import { base, mainnet } from "viem/chains";

export type ChainConfig = Chain & {
  readonly alchemyBaseUrl: string;
};

export const chains = {
  ethereum: {
    ...mainnet,
    alchemyBaseUrl: "https://eth-mainnet.g.alchemy.com/v2",
  },
  base: {
    ...base,
    alchemyBaseUrl: "https://base-mainnet.g.alchemy.com/v2",
  },
} as const satisfies Record<string, ChainConfig>;

export type ChainName = keyof typeof chains;

export function parseChain(value: string): ChainName {
  if (Object.hasOwn(chains, value)) return value as ChainName;
  throw new Error("Chain must be ethereum or base.");
}
