# HomeHub on GitHub Pages

HomeHub keeps the original mobile layout and five tabs. The Vite build is a static site. Supabase handles email verification codes, database storage, permissions and live refresh. There is no web server to deploy.

This setup starts with an empty Supabase database. Any records in the original private ChatGPT Site stay there. These instructions assume a new GitHub repository named `homehub` with default branch `main`.

## 1. Create the GitHub repository

1. Extract the source ZIP and open a terminal in `homehub-pages`, the folder that contains this guide.
2. Create a **public** repository called `homehub` on GitHub. Leave the README, license and gitignore options unchecked so GitHub starts with an empty repo. GitHub Free supports Pages from public repositories. Anyone can see the frontend source and frontend URL. The Supabase database separately enforces who can see household data.
3. In the repository, open **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**. If the setting is unavailable before the first commit, return to it immediately after pushing in step 5.
4. Write down your Pages URL. For a project repository it is `https://YOUR_GITHUB_USERNAME.github.io/homehub/`. If you use a different repository name, use that exact name in the URL and Supabase settings. GitHub Actions supplies the correct path to Vite at build time.

[GitHub Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## 2. Create the Supabase project

1. Create a project in the [Supabase dashboard](https://supabase.com/dashboard) and select the Free plan if it meets your needs. Save the database password in your password manager.
2. From **Connect** or **Settings → API Keys**, copy the exact project URL and **publishable** key. The key starts with `sb_publishable_`.
3. In GitHub, go to **Settings → Secrets and variables → Actions → Variables** and add the following repository variables.

   | Variable | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://YOUR_PROJECT_REF.supabase.co` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | Your `sb_publishable_…` key |

The project URL and publishable key are designed to be visible in the frontend. Keep the database password, Supabase secret and service-role keys, and SMTP credentials out of the repository and browser. The workflow rejects non-publishable key prefixes.

[Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)

## 3. Apply the database migration

1. Open **SQL Editor → New query** in Supabase.
2. Paste the entire contents of [the initial migration](supabase/migrations/20261124000000_homehub.sql) and click **Run** once on the new project. It runs in a transaction.
3. Keep `homehub_private` out of the Data API's exposed schemas. Keep `public` exposed so the app can call the `homehub` RPC.
4. Confirm that `public.homehub_events` is in the `supabase_realtime` publication. The migration enables it. Its row-level policy exposes only a caller's own change signal. The app re-fetches household data through the authorized RPC and polls as a fallback.

The migration denies browser roles direct access to the household tables. The database function takes the signed-in user ID from Supabase Auth, checks membership and admin roles, scopes every record write to its household, and uses composite foreign keys for assignments and contact links. Invitations expire after 24 hours, can be revoked, and are stored as hashes. Join attempts are limited per authenticated account. Each household starts empty.

[Supabase Realtime and PostgreSQL changes](https://supabase.com/docs/guides/realtime/postgres-changes)

## 4. Configure email verification codes

1. In Supabase, open **Authentication → Sign In / Providers → Email**. Enable Email and keep **Confirm email** and new-user signups enabled. Google can stay disabled.
2. Open **Authentication → Email Templates**. Edit **Magic Link** and **Confirm signup** so both use this HTML body and a subject such as **Your HomeHub sign-in code**.

   ```html
   <h2>Sign in to HomeHub</h2>
   <p>Your one-time code is <strong>{{ .Token }}</strong>.</p>
   <p>Enter the code on the HomeHub screen where you requested it.</p>
   ```

3. In **Authentication → URL Configuration**, set **Site URL** to your full Pages URL, for example `https://YOUR_GITHUB_USERNAME.github.io/homehub/`. The in-app code flow verifies directly with Supabase, so there is no Google redirect to configure.
4. Test with your Supabase team email first. Supabase's default email sender only delivers to project team addresses. Before testing with family or other outside addresses, set up **Authentication → SMTP Settings** with a transactional email provider. Keep the provider's SMTP credentials in Supabase.

[Supabase passwordless email](https://supabase.com/docs/guides/auth/auth-email-passwordless) · [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp)

## 5. Deploy

Run these commands from the extracted folder, replacing the GitHub username.

```sh
git init -b main
git add .
git commit -m "Set up HomeHub on GitHub Pages"
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/homehub.git
git push -u origin main
```

Open **Actions → Deploy HomeHub to GitHub Pages** and check the run. If Pages was configured after the first push, rerun the workflow from the **Actions** tab. The workflow installs dependencies, runs the PostgreSQL privacy test suite, builds for the Pages base path and deploys `dist/`. It runs again on pushes to `main`. Supabase migrations are applied separately in the SQL Editor.

The tabs use fragments such as `/homehub/#contacts`, so refreshing a tab stays on the static entry point. Email codes are entered directly in HomeHub.

To run locally with Node.js 24, copy `.env.example` to `.env.local`, insert the project URL and publishable key, then run `npm ci` and `npm run dev`. Run `npm test` to repeat the local PostgreSQL tests without credentials.

## 6. Test email verification codes and independent household privacy

Use two separate browser profiles with two email addresses that your Supabase SMTP setup can reach, A and B.

1. Open the Pages URL signed out. Create an account with a username, email and password. Confirm that the signup email contains a code, then enter it to proceed. Returning users can sign in with email and password. Usernames are shown to household members.
2. In profile A, sign in and create **Maple Test**. In B, sign in and create **Cedar Test**. Confirm each starts with zero items and tasks and only its creator is an admin. Add a different item, maintenance task and contact to each household.
3. Test the direct API while A and B are still independent. In Firefox DevTools, open **Network**, filter for `/rest/v1/rpc/homehub`, navigate or reload the app, and use **Edit and Resend** on an authenticated RPC to keep its headers in the browser. Obtain the target household UUID from the other profile's own `list` response. With A's authenticated request, try B's UUID in the body below. Repeat in the other direction.

   ```json
   {"p_operation":"get","p_household":"OTHER_HOUSEHOLD_UUID","p_record":null,"p_body":{}}
   ```

   The response body should contain `"status":404` and no household records. The HTTP request can still return 200 because the RPC returns application status in JSON. Change `p_operation` to `contact_add` and use `"p_body":{"name":"Forbidden test","phone":"5550100"}`. Expect the same denial. Confirm the target contact list is unchanged. For an anonymous check, remove the Authorization header from an edited request and retain only the publishable API key. Expect API permission denial. Keep Authorization headers and tokens out of screenshots, chat, and files.
4. In A, create and revoke a code. In B, check that the old code fails. Generate a new code, join Maple Test and verify household switching. As B, confirm that a regular member cannot generate codes, manage members or change the weekly ordering settings.
5. In Maple Test, add one `Toothpaste` in A and one ` toothpaste ` in B. Confirm both screens show total **2**, with both contributions in the expanded row. Mark the group as ordered, add a new request, then undo the first order from history. Test assignment, completion, phone links and ordering rotation. Reload both browser profiles to verify persistence.
6. Remove B from Maple Test as A. B should lose access on refresh or after the live update. Confirm B's direct Maple Test read is denied again and that the previous invitation can no longer be used.
7. Install the PWA and test email verification codes inside the installed app. On **iPhone**, open the URL in Safari, choose **Share → Add to Home Screen**, enable **Open as Web App** if shown, and tap **Add**. On **Android**, open the URL in Chrome and choose **Install app** or **Add to home screen** from the menu. Household data is fetched online and is never stored by the service worker.

[Apple's Home Screen instructions](https://support.apple.com/en-in/guide/iphone/iph42ab2f3a7/ios) · [Chrome for Android web apps](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid)
