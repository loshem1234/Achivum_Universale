# Archivum Universale — Deployment Guide

This is a complete Node.js application. Follow these steps in order.
Total setup time: approximately 30–45 minutes.

---

## What you need before starting

- A free account at [github.com](https://github.com)
- A free account at [railway.app](https://railway.app)
- A free account at [cloudflare.com](https://cloudflare.com)
- Your Anthropic API key (from console.anthropic.com)

---

## Step 1 — Set up Cloudflare R2 (PDF storage)

1. Log in to [cloudflare.com](https://cloudflare.com)
2. In the left sidebar, click **R2 Object Storage**
3. Click **Create Bucket**
   - Name it `archivum-pdfs`
   - Click **Create Bucket**
4. Open the bucket, click **Settings** tab
   - Under **Public Access**, click **Allow Access**
   - Copy the **Public Bucket URL** — it looks like `https://pub-xxxx.r2.dev`
   - Save this as `R2_PUBLIC_URL`
5. Go back to R2 main page, click **Manage R2 API Tokens**
6. Click **Create API Token**
   - Give it a name: `archivum-token`
   - Permissions: **Object Read & Write**
   - Apply to: **Specific bucket** → `archivum-pdfs`
   - Click **Create API Token**
7. Copy and save these three values:
   - **Access Key ID** → save as `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → save as `R2_SECRET_ACCESS_KEY`
   - **Account ID** (shown on the R2 overview page) → save as `R2_ACCOUNT_ID`

---

## Step 2 — Push code to GitHub

1. Go to [github.com](https://github.com) → click **New repository**
   - Name it `archivum-universale`
   - Set to **Private**
   - Click **Create repository**

2. On your computer, open Terminal (Mac) or Command Prompt (Windows)

3. Navigate to the project folder:
   ```
   cd path/to/archivum-universale
   ```

4. Run these commands one at a time:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/archivum-universale.git
   git push -u origin main
   ```
   Replace `YOUR_USERNAME` with your GitHub username.

---

## Step 3 — Deploy on Railway

1. Go to [railway.app](https://railway.app) → **Start a New Project**
2. Click **Deploy from GitHub repo**
3. Connect your GitHub account if prompted
4. Select your `archivum-universale` repository
5. Railway will detect the Node.js app automatically
6. Click **Add Variables** (or go to the Variables tab) and add each of these:

   | Variable | Value |
   |---|---|
   | `ADMIN_PASSPHRASE` | Choose a strong passphrase |
   | `ANTHROPIC_API_KEY` | Your Anthropic API key |
   | `R2_ACCOUNT_ID` | From Step 1 |
   | `R2_ACCESS_KEY_ID` | From Step 1 |
   | `R2_SECRET_ACCESS_KEY` | From Step 1 |
   | `R2_BUCKET_NAME` | `archivum-pdfs` |
   | `R2_PUBLIC_URL` | From Step 1 (e.g. `https://pub-xxxx.r2.dev`) |
   | `NODE_ENV` | `production` |

7. Railway will deploy automatically. Watch the build logs — it should say **"Archivum Universale running on port XXXX"**

8. Click **Settings** → **Networking** → **Generate Domain**
   - You'll get a URL like `archivum-universale-production.up.railway.app`
   - This is your live site

---

## Step 4 — Add a Persistent Volume (CRITICAL for database)

This ensures your SQLite database survives deploys and restarts.

1. In Railway, go to your project → click your service
2. Click **Volumes** tab → **Add Volume**
3. Mount path: `/data`
4. Click **Add**
5. Railway will restart the service — your database now persists permanently

---

## Step 5 — Add a Custom Domain (optional)

1. Buy a domain at [Namecheap](https://namecheap.com) or [Cloudflare Registrar](https://cloudflare.com/products/registrar/)
2. In Railway → Settings → Networking → **Custom Domain**
3. Add your domain and follow the DNS instructions shown

---

## Updating the site

Whenever you make changes to the code:

```
git add .
git commit -m "Description of changes"
git push
```

Railway detects the push and redeploys automatically. Your database and all uploaded books are preserved.

---

## Architecture summary

```
Browser (Public)
    ↓ reads from
Express Server (Railway)
    ↓ stores metadata in          ↓ stores PDF files in
SQLite Database (/data/)     Cloudflare R2
    ↑ seeds on first boot
14 canonical entries

Admin uploads PDF →
  Server receives it →
  Sends to Anthropic API (server-side, secure) →
  Uploads PDF to R2 →
  Saves metadata + cover SVG to SQLite →
  Returns to browser
```

---

## Cost estimate

| Service | Cost |
|---|---|
| Railway (Hobby plan) | ~$5/month |
| Cloudflare R2 | Free up to 10GB storage |
| Anthropic API | Pay per use (~$0.01–0.05 per book processed) |
| Domain (optional) | ~$12/year |
| **Total** | **~$5–7/month** |

---

## Admin access

Navigate to your site → click **Enter** in the top right → enter your `ADMIN_PASSPHRASE`.

The API key is stored securely on the server — it is never sent to or stored in the browser.
