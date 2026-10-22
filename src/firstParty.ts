export type FirstPartyApplication = {
  origin: string;
  walletCallbacks: readonly string[];
  /** How long a sign-in (an app grant) lasts, in seconds; an hour when absent, at most 90 days. */
  grantLifetimeSeconds?: number;
};

function applications(origins: readonly string[]): readonly FirstPartyApplication[] {
  return Object.freeze(origins.map(origin => Object.freeze({ origin, walletCallbacks: Object.freeze([]) })));
}

const PRODUCTION_APPLICATIONS = applications([
  "https://juicebox.money",
  "https://revnet.money",
  "https://eth.shop",
  "https://succulent.money",
  "https://homerun.money",
  "https://beep.biz",
]);
const DEV_APPLICATIONS = applications([
  "https://dev.juicebox.money",
  "https://dev.revnet.money",
  "http://localhost:3001",
  "http://localhost:3002",
  "https://dev.eth.shop",
  "http://localhost:3003",
  "https://dev.succulent.money",
  "http://localhost:3004",
  "http://localhost:3010",
  "http://localhost:3014",
  "http://127.0.0.1:8787",
]);

const HOSTING_NAMES = {
  environment: ["SIGNA_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME"],
  replicaId: ["SIGNA_REPLICA_ID", "RAILWAY_REPLICA_ID"],
  replicaRegion: ["SIGNA_REPLICA_REGION", "RAILWAY_REPLICA_REGION"],
} as const;

/** One read of a hosting-neutral setting: the SIGNA_* name, else the Railway name. */
export function hostingSetting(
  name: keyof typeof HOSTING_NAMES,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const [neutral, railway] = HOSTING_NAMES[name];
  return env[neutral] || env[railway] || undefined;
}

export function environmentName(env: Record<string, string | undefined> = process.env): string | undefined {
  return hostingSetting("environment", env);
}

/** The shared trusted configuration. Empty callbacks admit no wallet handoff. */
export function firstPartyForEnvironment(environment = environmentName()): readonly FirstPartyApplication[] {
  return environment === "dev" ? DEV_APPLICATIONS : PRODUCTION_APPLICATIONS;
}

export function originsForEnvironment(environment = environmentName()): readonly string[] {
  return firstPartyForEnvironment(environment).map(application => application.origin);
}
