const EXPLORER = "https://stellar.expert/explorer/testnet";

/** Where to look something up on the public testnet explorer. */
export const explorer = {
  tx: (hash: string) => `${EXPLORER}/tx/${hash}`,
  ledger: (sequence: number) => `${EXPLORER}/ledger/${sequence}`,
  /** G... accounts and C... contracts live under different paths. */
  address: (address: string) =>
    `${EXPLORER}/${address.startsWith("C") ? "contract" : "account"}/${address}`,
};
