# Hosting the UniBursar Cloud Hub — recommended free options

The hub (`server.js` + `portal.js`) is **pure Node, zero npm dependencies**. It runs on
any Node host with **no build/install problems**. Pick one of the options below, then enter
the hub's **public URL** and **SYNC_TOKEN** in every desktop app (Administration → Sync) and
click **♻️ Re-sync Everything** on the computer that has the data.

| Host | Free? | Always-on | Permanent data | Effort | Best for |
|------|-------|-----------|----------------|--------|----------|
| **Render** (free web service) | ✅ | ✅ via built-in self-ping | ⚠️ wiped on restart (auto-refills from a desktop) | ⭐ easiest | Just get online fast |
| **Fly.io** | ✅ (small free allowance) | ✅ `min_machines_running=1` | ✅ free 1–3 GB volume | ⭐⭐ | Always-on **and** permanent |
| **Oracle Cloud — Always Free VM** | ✅ forever | ✅ real VM | ✅ real disk | ⭐⭐⭐ | The most robust, long-term |
| **Google Cloud — e2-micro free VM** | ✅ forever (free regions) | ✅ real VM | ✅ real disk | ⭐⭐⭐ | 24/7 on Google infra |

> Note: free tiers change over time and most ask for a card to verify (Render's free web
> service does **not** require a card). Don't put fees you can't afford on auto-scaling tiers.

---

## ⭐ Option 1 — Render (recommended to start; easiest)

1. Put this project in a **GitHub** repo (private is fine).
2. Render → **New → Blueprint** → pick the repo. Render reads **`server/render.yaml`** and
   creates the service (free plan, start `node server.js`, health check `/health`).
   * No Blueprint? Use **New → Web Service**, set **Root Directory = `server`**,
     **Build = `npm install`**, **Start = `node server.js`**.
3. Open the service → **Environment** → copy the generated **`SYNC_TOKEN`**.
4. Your hub URL is shown at the top, e.g. `https://unibursar-hub.onrender.com`.
5. **Always-on is automatic** — Render injects `RENDER_EXTERNAL_URL`, so the server pings
   itself every 10 minutes and never sleeps (well within the free 750 hrs/month).

**Data:** Render free has no persistent disk, so a restart/redeploy empties the cloud copy —
but **nothing is lost**: whenever a desktop reconnects it re-uploads everything (or click
**♻️ Re-sync Everything**). For a permanent cloud copy, upgrade to a paid instance + Disk and
set `DATA_DIR=/var/data`, or use Option 2/3.

---

## ⭐⭐ Option 2 — Fly.io (always-on AND permanent, still free)

Uses **`server/Dockerfile`** + **`server/fly.toml`** (already included).

> ⚠️ **Do NOT run `fly launch`.** Its source scanner errors with
> *“Could not detect runtime or Dockerfile.”* Use **`fly deploy`** instead — it builds straight
> from `fly.toml` + `Dockerfile` and ignores the scanner. And run every command from **inside
> the `server` folder** (the one that actually contains `Dockerfile`).

```powershell
# install flyctl: https://fly.io/docs/flyctl/install/  then `fly auth signup`
cd "C:\Users\black mamba\Documents\uni\server"     # MUST be in this folder
dir   # confirm you see: server.js  portal.js  package.json  Dockerfile  fly.toml

fly apps create uni-lab                            # pick your own unique name
# edit fly.toml -> set: app = "uni-lab"  (and primary_region to a region near you)
fly volumes create unibursar_data --size 1 --region iad -a uni-lab -y   # same region as fly.toml
fly secrets set SYNC_TOKEN=a-long-random-secret -a uni-lab               # note this — you'll re-type it in the apps
fly deploy -a uni-lab                              # builds the Dockerfile, no scanner
fly status -a uni-lab                              # shows your https URL, e.g. https://uni-lab.fly.dev
```

`min_machines_running = 1` keeps it awake; the volume at `/data` (with `DATA_DIR=/data`) keeps
the data permanently. `fly secrets` are write-only, so save the SYNC_TOKEN when you set it.

**If a deploy ever can't find the Dockerfile:** you're in the wrong folder — `cd` into the
`server` folder (where `Dockerfile` lives) and run `fly deploy` again.

---

## ⭐⭐⭐ Option 3 — Oracle Cloud “Always Free” VM (most robust, forever-free)

A real Linux VM that never sleeps, with a real disk. More setup, but bullet-proof.

1. Create an **Always Free** VM (Ampere/ARM or AMD micro), Ubuntu.
2. SSH in and install Node + run the hub as a service:
   ```bash
   sudo apt update && sudo apt install -y nodejs
   mkdir -p ~/unibursar && cd ~/unibursar     # copy server.js + portal.js here
   # run it persistently with a systemd service (or pm2):
   sudo npm i -g pm2
   SYNC_TOKEN=your-secret DATA_DIR=/home/ubuntu/unibursar/data PORT=4000 pm2 start server.js --name unibursar-hub
   pm2 save && pm2 startup
   ```
3. Open the port: add an **ingress rule** for TCP **4000** in the VCN Security List, and
   `sudo iptables -I INPUT -p tcp --dport 4000 -j ACCEPT` (persist it).
4. Your hub URL is `http://<vm-public-ip>:4000` (put it behind Caddy/Nginx for HTTPS if you
   want a domain).

---

## ⭐⭐⭐ Option 4 — Google Cloud (Compute Engine free VM) — always‑on, persistent

Google Cloud has an **Always Free `e2-micro` VM** in `us-west1`, `us-central1` or `us-east1`.
It's a real Linux server that never sleeps with a persistent disk — ideal for 24/7 access even
when no desktop is online. (Avoid **Cloud Run** for the hub: it scales to zero and has an
ephemeral filesystem, so the data store wouldn't persist.)

1. **Create the VM** — Console → **Compute Engine → VM instances → Create instance**:
   - Name `unibursar-hub`; **Region** `us-central1` (or us-west1/us-east1 for free tier);
     **Machine type** `e2-micro`.
   - **Boot disk:** Ubuntu 22.04 LTS (the disk is persistent — your data survives reboots).
   - **Firewall:** tick **Allow HTTP traffic** (and HTTPS if you'll add a domain).
   - Create, then copy the instance's **External IP**.
2. **Open port 4000** — Console → **VPC network → Firewall → Create firewall rule**:
   - Name `allow-unibursar`; Direction **Ingress**; Targets **All instances**;
     Source ranges `0.0.0.0/0`; Protocols/ports **TCP `4000`** → Create.
   *(GCP Ubuntu images don't run a host firewall by default, so the VPC rule is all you need.)*
3. **SSH in** — click **SSH** next to the instance (opens a browser terminal), then:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo npm install -g pm2
   mkdir -p ~/unibursar-hub      # then upload server.js + portal.js + package.json here
   ```
   To upload the files: on your PC run
   `gcloud compute scp --recurse "C:\Users\black mamba\Documents\uni\server" unibursar-hub:~/unibursar-hub`
   (install the gcloud CLI first), **or** paste the files via the SSH window's ⚙ → *Upload file*.
4. **Run it 24/7:**
   ```bash
   cd ~/unibursar-hub
   SYNC_TOKEN='a-long-random-secret' DATA_DIR="$HOME/unibursar-data" PORT=4000 \
     pm2 start server.js --name unibursar-hub
   pm2 save && pm2 startup     # run the sudo line it prints
   curl http://localhost:4000/health     # → {"ok":true,...}
   ```
5. Your hub + portal is **`http://<EXTERNAL-IP>:4000`**. Data lives in `~/unibursar-data` on the
   persistent disk, so students/staff/lecturers can reach the portal **any time**, and desktops
   sync to it whenever they're online. *(For HTTPS + a domain, follow the Caddy step under
   Oracle above — open ports 80/443 with another firewall rule.)*

> **Static IP (recommended):** VPC network → IP addresses → reserve the instance's external IP
> as **static** so it never changes on reboot.

---

## After ANY option — connect the apps
On **every** computer (the one with the data first): Administration → Sync →
**Server URL** = the hub URL, **Sync token** = the SYNC_TOKEN → **Save** →
**🌐 Test Connection** → on the data PC, **♻️ Re-sync Everything**. The same hub powers the
student/parent/staff **Portal** at that URL.
