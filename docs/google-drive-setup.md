# Google Drive backup — one-time setup (about 10 minutes)

This creates a free "client ID" that lets the Mileage Logbook ask Google for permission to save
**its own backup file** in your Google Drive. It uses the `drive.file` permission, which means the
app can only see files it created. It can't see anything else in your Drive. It costs nothing.

Do this on a computer, signed in with the Google account whose Drive you want to use.

## 1. Create a project
1. Go to **https://console.cloud.google.com/**. Accept the terms if asked.
2. Click the **project picker** at the top (it may say "Select a project") → **New project**.
3. Name it `Mileage Logbook` → **Create**. Make sure it's selected in the project picker.

## 2. Turn on the Google Drive API
1. Go to **https://console.cloud.google.com/apis/library/drive.googleapis.com**.
2. Click **Enable**.

## 3. Set up the sign-in screen
1. Go to **https://console.cloud.google.com/auth/overview** and click **Get started**.
2. **App information:** App name `Mileage Logbook`, User support email: your email → **Next**.
3. **Audience:** choose **External** → **Next**.
4. **Contact information:** your email → **Next**. Tick the agreement → **Continue** → **Create**.
5. In the left menu open **Audience**. Under **Test users**, click **Add users**, add your own Gmail
   address, and **Save**. Leave the publishing status as **Testing**.
6. In the left menu open **Data access** → **Add or remove scopes**. Type `drive.file` in the filter,
   tick **…/auth/drive.file** ("See, edit, create and delete only the specific Google Drive files
   you use with this app") → **Update** → **Save**.

## 4. Create the client ID
1. In the left menu open **Clients** → **Create client**.
2. **Application type:** Web application. **Name:** `Mileage app`.
3. Under **Authorised JavaScript origins** click **Add URI** and enter exactly:
   `https://angelice13.github.io`
   (no `/testing`, no slash at the end). If you move the app to a new GitHub account later, add
   that address too, e.g. `https://newname.github.io`.
4. Leave "Authorised redirect URIs" empty → **Create**.
5. Copy the **Client ID**. It ends in `.apps.googleusercontent.com`.

## 5. Put it in the app
- Open the app → **Reports** → **Backup & restore** → **Google Drive** → paste the client ID →
  **Save client ID** → **Back up to Drive now**.
- Google shows a sign-in window. Because the app is in "Testing", you may see **"Google hasn't
  verified this app"**. That's expected for your own private app: tap **Continue**, then allow
  access to "files you use with this app".

The client ID isn't a secret. You can also send it to whoever maintains the app, to build it in so
you don't have to paste it on each device.

## How backups work afterwards
- After 10pm (or the next time you open the app), if you've signed in within the last hour, the
  app backs up to Drive automatically. Otherwise you'll see **"Back up to Google Drive"**. Tap it
  (one tap, you may need to pick your Google account).
- The file is `My Drive / Mileage Logbook backups / mileage-backup.zip`. Each backup replaces the
  previous one, and Google Drive keeps older versions for about 30 days (right-click → Manage versions).
- On a new phone: **Restore from Drive**.
