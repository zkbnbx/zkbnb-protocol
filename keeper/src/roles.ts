/**
 * Role separation of the stage-2 keeper processes (privacy/PRIVACY-SPEC.md §2.10, §5.2, §6.4; implementation review
 * K3). The relayer sees client IPs and public inputs; the Epoch Coordinator holds the key that could decrypt every
 * intent. They must run on different hosts with different keys, so a process of one role must never hold the other
 * role's secrets. keeper/src/config.ts loads keeper/.env for every command, so one shared .env would quietly give
 * both processes both secrets.
 *
 * Chain 56: the command refuses to start. Other chains (anvil, testnet, the e2e driver): a warning only.
 * Only variable NAMES are ever reported, never values.
 */
export type KeeperRole = "relayer" | "coordinator";

/** Secrets that belong to the other role. */
export const FOREIGN_SECRETS: Readonly<Record<KeeperRole, readonly string[]>> = {
  relayer: ["COORDINATOR_SK", "COORDINATOR_KEY_DIR"],
  coordinator: ["RELAYER_PRIVATE_KEY", "RELAYER_HELD_KEY"],
};

/** The role of a keeper command, or null for the stage-1 commands and stage-2 commands that hold no secret. */
export function roleOf(cmd: string): KeeperRole | null {
  if (cmd === "relayer") return "relayer";
  if (cmd === "coordinator" || cmd === "rotate-key") return "coordinator";
  return null;
}

export interface RoleCheck {
  /** names (never values) of the other role's secrets present in this process's environment */
  names: string[];
  /** true on chain 56: the command must not start */
  refuse: boolean;
}

export function roleSeparation(role: KeeperRole, chainId: number, env: NodeJS.ProcessEnv): RoleCheck {
  const names = FOREIGN_SECRETS[role].filter((n) => (env[n] ?? "").trim() !== "");
  return { names, refuse: names.length > 0 && chainId === 56 };
}

/** The message for a refusal or a warning (names only). */
export function roleSeparationMessage(role: KeeperRole, names: readonly string[]): string {
  const other = role === "relayer" ? "Epoch Coordinator" : "relayer";
  return `the ${role} process has the ${other}'s secrets in its environment (${names.join(", ")}): run the relayer and the Coordinator on different hosts with separate .env files (privacy/PRIVACY-SPEC.md section 2.10)`;
}
