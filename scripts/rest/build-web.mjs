import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basePaymentConfiguration } from "../../src/rest/wallet/productionStack.ts";
import { hashedAssetName } from "../../src/rest/web/assets.ts";
import { walletCss, walletPage } from "../../src/rest/web/walletPage.ts";
import { walletPaymentCss, walletPaymentPage } from "../../src/rest/web/walletPaymentPage.ts";
import { walletRecoveryCss, walletRecoveryPage } from "../../src/rest/web/walletRecoveryPage.ts";
import { walletSignupCss, walletSignupPage } from "../../src/rest/web/walletSignupPage.ts";
import { walletDeviceCss, walletDevicePage } from "../../src/rest/web/walletDevicePage.ts";

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
  // The approval page checks every payment against the server's own token and terminal pin.
  define: { __SIGNA_PAYMENT_PIN__: JSON.stringify(basePaymentConfiguration()) },
};

const sha256 = (body) => createHash("sha256").update(body).digest("hex");

/** Every page, script and stylesheet the Signa origin serves to a browser outside a frame, with signup,
 * recovery, devices, payments and funds configured as in production, by path to the sha256 of the body.
 * `bundle(name)` is an entry point's built text; scripts/rest/verify-served-build.mjs compares a live
 * origin against this, and test/rest-build.test.ts holds it to what the wallet site renders and serves. */
export function webManifest(bundle) {
  const files = {
    "wallet.js": bundle("wallet"), "wallet.css": walletCss(), "wallet-qr.js": bundle("wallet-qr"),
    "wallet-payment.js": bundle("wallet-payment"), "wallet-payment.css": walletPaymentCss(),
    "wallet-signup.js": bundle("wallet-signup"), "wallet-signup.css": walletSignupCss(),
    "wallet-recovery.js": bundle("wallet-recovery"), "wallet-recovery.css": walletRecoveryCss(),
    "wallet-recovery-kit.js": bundle("wallet-recovery-kit"),
    "wallet-device.js": bundle("wallet-device"), "wallet-device.css": walletDeviceCss(),
  };
  const assets = Object.fromEntries(Object.entries(files).map(([file, body]) => [file, hashedAssetName(file, body)]));
  const account = walletPage(true, true, "", false, assets);
  const pages = { "/": account, "/funds": account, "/create": walletSignupPage({ base: "", assets }),
    "/payment": walletPaymentPage("", assets), "/recover": walletRecoveryPage({ base: "", assets }), "/add": walletDevicePage({ base: "", assets }) };
  return Object.fromEntries([...Object.entries(pages),
    ...Object.entries(files).map(([file, body]) => [`/assets/${assets[file]}`, body])].map(([path, body]) => [path, sha256(body)]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build(webBuildOptions);
  const outdir = new URL("../../.generated/rest/", import.meta.url);
  const bundles = new Map(await Promise.all(Object.keys(webBuildOptions.entryPoints).map(async name =>
    [name, await readFile(new URL(`${name}.js`, outdir), "utf8")])));
  await writeFile(new URL("web-manifest.json", outdir), `${JSON.stringify(webManifest(name => bundles.get(name)), null, 2)}\n`);
}
