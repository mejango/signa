import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** The browser bundles Center serves; test/rest-web-bundle-budget.test.ts holds their size budgets. */
export const webBuildOptions = {
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: {
    "wallet-recovery": "src/rest/web/walletRecoveryJourney.ts",
    "wallet-device": "src/rest/web/walletDevice.ts",
    "wallet-signup": "src/rest/web/walletSignup.ts",
    "wallet-payment": "src/rest/web/walletPayment.ts",
    wallet: "src/rest/web/wallet.ts",
    accounts: "src/rest/web/main.ts",
    docs: "src/rest/docs/main.ts",
    // Loaded on demand from the URL its page names in <meta name="module:..."> (src/rest/web/lazyModule.ts).
    "wallet-recovery-kit": "src/rest/web/walletRecoveryKit.ts",
    "accounts-signed-in": "src/rest/web/accountsSignedIn.ts",
    "wallet-qr": "src/rest/web/qr.ts",
  },
  outdir: ".generated/rest",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "eof",
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await build(webBuildOptions);
