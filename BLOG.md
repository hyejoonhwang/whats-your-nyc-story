# Taking *What's Your NYC Story?* From Localhost to Live

*Process log — turning a Live Web final into an open-source project with a public domain*

I'm building **What's Your NYC Story?** — a real-time, zoomable, collaborative typographic map of New York City — for two classes at the same time. It's my Live Web final, and it doubles as my Open Source class project. That second class adds a constraint: the project has to live as a real public open-source repo, with all the accompanying documentation, and it has to stand on top of an existing open-source library (in my case, Cheng Lou's [Pretext](https://github.com/chenglou/pretext) — a canvas text layout engine).

Here's how I got from "running on my laptop" to "live at https://whatsyournycstory.live with auto-deploy."

## 1. The four files every open-source project needs

My professor's checklist was straightforward: a README, a license, contributing guidelines, and a code of conduct. The [opensource.guide starting-a-project](https://opensource.guide/starting-a-project/) page from GitHub is the canonical reference for this — it lays out exactly these four files and explains why each one matters.

### README.md
The README isn't a manual — it's a hook. The first paragraph has to make a stranger want to keep reading. I led with the conceptual idea (NYC as a living typographic pressure system) and the technical hook (Pretext-driven canvas reflow at 60fps), then moved to install instructions. A second-time visitor cares about installing; a first-time visitor cares about whether the project sounds interesting.

The most important non-obvious section: **credit to Pretext**, placed second from the top — not buried at the bottom — because attribution to the upstream library is the load-bearing requirement of being a downstream open-source project.

### LICENSE — choosing MIT, and why

This was the most thoughtful decision. I started by reading **Pretext's own LICENSE file** and confirmed it's MIT. That mattered because **license compatibility is one-way**: a downstream project can't be more restrictive than its dependencies allow.

I considered four options:

- **MIT** — most permissive, simplest text, recognizable everywhere
- **Apache 2.0** — also permissive but adds patent-grant clauses that felt overkill for a small art project
- **GPL v3** — copyleft, would force any derivative work to also be GPL, discouraging remixing
- **Unlicense / CC0** — public domain, but I wanted attribution preserved

[choosealicense.com](https://choosealicense.com/), maintained by GitHub, has a flowchart that basically says: "Want it simple and permissive? → MIT." That sealed it. MIT also matches Pretext exactly, which makes the compatibility story trivial.

### CONTRIBUTING.md
A doc that says "here's how you can help." I wrote it to lower the barrier to contribution as much as possible — the first section is "Ways to Contribute," and it deliberately lists non-code contributions (reporting bugs, seeding stories during the show) right next to "send a pull request." The dev setup section emphasizes the one quirk of this project: you have to open *two browser windows* to test live sync.

### CODE_OF_CONDUCT.md
I used the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) as the template. It's the de facto standard in open source — adopted by GitHub itself, the Linux kernel, React, Rails, Kubernetes. Using a recognized standard signals to contributors that the project operates by community norms they already understand.

## 2. Going public on GitHub

Initial commit, public repo, push:

```bash
git init -b main
git add .
git commit -m "Initial commit: What's Your NYC Story?"
gh repo create whats-your-nyc-story --public --source=. --remote=origin --push
```

I did rename the repo once — first I'd called it `whats-your-nyc-stories` (plural), but "What's = What is" doesn't agree with a plural noun, so I renamed it to `whats-your-nyc-story`. `gh repo rename` updates the GitHub side and your local `git remote` in one motion.

The public repo now lives at https://github.com/hyejoonhwang/whats-your-nyc-story.

## 3. From localhost to a real domain

Running locally is fine for development, but Live Web demands a *live* URL. I have a Digital Ocean droplet from previous classes — small, 512MB RAM, Ubuntu 24.04, already had Node, PM2, nginx, and certbot set up. Two old projects live there (`chat-server`, `control-my-laptop`), so I wanted to slot mine in without disturbing them.

The setup followed the exact pattern of my older projects:

```
1. Clone repo to /root/whats-your-nyc-story
2. npm install --omit=dev
3. pm2 start server.js --name whats-your-nyc-story
4. pm2 save  (so it auto-restarts on reboot)
```

Each project gets its own port (mine is 5001) and its own PM2-managed Node process. They don't fight each other.

For nginx I copied the config pattern from one of my existing projects — a reverse proxy from the public-facing port 443 to localhost:5001, with the WebSocket upgrade headers Socket.io needs:

```nginx
server {
    server_name whatsyournycstory.live www.whatsyournycstory.live;
    location / {
        proxy_pass http://127.0.0.1:5001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        ...
    }
}
```

## 4. Domain + SSL

I bought `whatsyournycstory.live` from Namecheap. Namecheap defaults to a parking page, so I had to:

- **Delete the URL Redirect Record** that pointed traffic to a parking page
- **Add A records** for `@` and `www` pointing to the droplet's IP (`165.227.98.201`)
- **Leave the TXT/SPF record alone** — it's only for email and doesn't affect web routing

DNS propagation took about 5 minutes. The first time I hit the URL, my browser screamed "Not Secure" — that's expected before SSL is set up, and it actually means **the DNS is working** because I reached my server.

For SSL I ran:

```bash
certbot --nginx -d whatsyournycstory.live -d www.whatsyournycstory.live --redirect
```

Certbot does three things in one command: gets a free Let's Encrypt certificate, rewrites my nginx config to use HTTPS, and adds an HTTP→HTTPS redirect. It also schedules auto-renewal so the cert never expires. Total time: ~15 seconds.

## 5. Auto-deploy from GitHub

The painful version of "deploying" is: SSH into the droplet, `git pull`, `npm install`, `pm2 restart`. Every. Single. Time. After two days of doing that manually, I set up GitHub Actions to do it automatically on every push.

The flow:

1. **Generate a dedicated deploy SSH keypair** (separate from my personal Mac key, for security)
2. **Put the public key** in the droplet's `~/.ssh/authorized_keys`
3. **Put the private key** in GitHub repo → Settings → Secrets, as `SSH_PRIVATE_KEY` (plus `SSH_HOST` and `SSH_USER`)
4. **Write the workflow** at `.github/workflows/deploy.yml`:

```yaml
name: Deploy to droplet
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /root/whats-your-nyc-story
            git pull --ff-only
            npm install --omit=dev
            pm2 restart whats-your-nyc-story --update-env
```

Now my workflow is normal-developer-life: edit code → `git push` → ~30 seconds later it's live. The first push that included this workflow triggered itself and deployed in 15 seconds.

## 6. Adding swap memory (a small but important detail)

When I checked the droplet's memory after deploying my third Node process alongside the two existing ones, only **102 MB of RAM was free** out of 458 MB total. With no swap configured, that meant a memory spike — say, a burst of viewers at the show all writing simultaneously — could trigger Linux's OOM killer and crash one of my apps mid-demo.

The fix: a **1 GB swap file** on the droplet's SSD. Swap acts as an emergency airbag — when RAM fills up, the kernel offloads inactive memory pages to disk instead of killing processes.

```bash
fallocate -l 1G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo "/swapfile none swap sw 0 0" >> /etc/fstab   # persist across reboots
sysctl vm.swappiness=10                            # only use swap when really needed
```

Effective RAM budget: 458 MB → **1.46 GB**. The 1 GB sits unused 99% of the time. It's just there for the demo-day spike.

## What's live now

- **Code:** [github.com/hyejoonhwang/whats-your-nyc-story](https://github.com/hyejoonhwang/whats-your-nyc-story)
- **Live site:** [whatsyournycstory.live](https://whatsyournycstory.live)
- **Auto-deploy:** push to `main` → live in ~30 seconds
- **SSL:** auto-renewing
- **License:** MIT, compatible with Pretext
- **Open-source paperwork:** README, LICENSE, CONTRIBUTING, CODE_OF_CONDUCT — all checked off

## What I learned

The non-obvious lesson from this whole process: **picking your dependencies is also picking your license.** I built on top of Pretext and that automatically narrowed my license choices. License compatibility goes one way, downstream is constrained by upstream, and that's a useful constraint — it means open-source software stays open as it gets remixed.

The other lesson: **a class project doesn't have to be a class-project setup.** Five years ago, getting a real domain, free SSL, and auto-deploy would have been a separate week of work. In 2026 it's an afternoon. The tools have caught up to where artists and students can run real production-shaped infrastructure for free or near-free, and the open-source community is what made that possible.
