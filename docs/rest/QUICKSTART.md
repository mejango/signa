# Your first request

Manage a Signa account, prepare wallet-approved transactions, and check their
results. Juicebox protocol reads and catalogs are available separately from Center.
Use Node 22 or newer for the examples below.

## Try a public request

No account or key is needed to discover supported chains and execution options:

```sh
curl https://api.signa.center/api/v1/capabilities
```

A successful response is JSON. Look at `protocolVersion` and the configured
chains. You can also explore the [Center contract catalog](https://juicebox.center/api/v1/catalog/contracts)
and [endpoint reference](/api#reference).

## Create your connection

1. Open [Accounts](/accounts) and select **Sign in**. Connect an existing wallet.
   Your wallet signs a request that creates or loads your Signa account.
   Signing in sends no transaction.
2. Under **02 / API access**, choose a label, expiry and permissions. Start with **Read**
   for data access, **Read + plan** to prepare actions, or **Read + plan + relay**
   to submit wallet-approved actions.
3. Select **Create API connection** and approve the requested access in your
   wallet. Save `juicebox-connection.json` in your application’s private folder.

The file contains the local bot key and all account settings. You do not need to
copy addresses or grant IDs. Signa receives only the public address and signed
proof. The page retains the key in memory until you sign out or close it;
**Download connection again** lets you retry a blocked download in that tab.

If setup is interrupted, select **Resume connection setup**. Signa checks the
existing registration before trying again with the same key and permissions.
Keep that tab open until your file is saved.

You can start making API requests now. The **Optional transaction wallet**
section is for keeping transaction funds separate, using sponsored fees where
available, or sharing approvals with other owners. It supports verified
Safe7579 wallets with one or more owners. See [when to add one](./SMART_ACCOUNTS.md).

## Install and connect

Run these commands in the folder containing your connection file:

```sh
npm install https://api.signa.center/api/client/juicebox-center-client-0.1.0.tgz
chmod 600 juicebox-connection.json
npx center account --connection juicebox-connection.json
```

You should receive `{ "account": { ... } }` with your account ID.
The client signs the request automatically; your owner wallet does not prompt.
`chmod` makes the secret readable only by you on macOS and Linux. Keep the file
out of source control and frontend assets, just as you would any application secret.

## Use JavaScript or TypeScript

Save this as `first-request.mjs`:

```js
import { connect } from '@juicebox/center-client/node';

const center = await connect('./juicebox-connection.json');
const { account } = await center.account();
console.log(account.id);
```

Run it:

```sh
node first-request.mjs
```

The package includes TypeScript types. You can use your existing local signer
or connected browser wallet instead of a file; see [client workflows](./CLIENT.md).

## Prepare your first action

For actions, create a connection with **Read + plan** or **Read + plan + relay**.
Use `center.prepare({ operation, input }, idempotencyKey)`. Choose an operation
and its input fields from the [Center operations catalog](https://juicebox.center/api/v1/catalog/operations).
The response contains the exact calls, amounts, dependencies and expiry to review.

Next, [prepare, approve and submit an action](./CLIENT.md#prepare-review-approve-submit).
Preparing a plan sends no blockchain transaction. API permissions authorize API
access; your wallet separately approves spending.

## When something goes wrong

| What happened | What to do |
| --- | --- |
| The connection file cannot be opened | Check the path, ownership and `0600` file permissions. |
| The connection expired or was revoked | Create a new connection on Accounts. Existing grants cannot be silently renewed. |
| A request lacks permission | Create a connection with the required scopes; the client never expands them automatically. |
| Setup stopped after your wallet signature | Use Resume connection setup in the same tab to check whether registration succeeded. |
| A submission timed out | Read the saved plan or submission ID before retrying. Keep the original idempotency key and exact signed bytes. |

## Choose your next step

- [Client workflows](./CLIENT.md): local signers, browser setup, plans and approvals.
- [Authentication](./AUTHENTICATION.md): scopes, revocation and the wire protocol.
- [Prepaid execution](./SPONSORSHIP.md): pay network costs for calls across chains.
- [Smart wallets](./SMART_ACCOUNTS.md): supported owner-approved execution.
- [Agent guide](./AI_GUIDE.md): integrate an assistant without putting keys in its conversation.
