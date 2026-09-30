# Deploy 0.9.15 to existing Yandex Cloud stand

This update is intentionally provided as a patch that does **not** contain `.env`. The production `.env` already configured on the VM must remain in place.

## 1. Upload patch from Windows

```powershell
scp -i "$HOME\.ssh\max-regulatory\ssh-key-1790536783378" `
  ".\max-regulatory-control-0.9.15-chatbot-patch.tar.gz" `
  ubuntu@158.160.0.219:/home/ubuntu/
```

## 2. Apply on VM

```bash
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -i ~/.ssh/max-regulatory/ssh-key-1790536783378 ubuntu@158.160.0.219
```

If connecting from Windows, use the Windows key path as before. Then on Ubuntu:

```bash
cd ~/vk_max_hack_ultr0-main
cp .env ~/.max-regulatory-production-env.backup
sha256sum .env

tar -xzf ~/max-regulatory-control-0.9.15-chatbot-patch.tar.gz

cmp -s .env ~/.max-regulatory-production-env.backup && echo "ENV OK"
docker compose up -d --build api bot worker web
docker compose ps -a
curl -fsS http://127.0.0.1:3000/health; echo
curl -fsS http://127.0.0.1:3001/health; echo
```

The patch has no database migration and does not replace `.env`.

## 3. Sync MAX webhook and commands

```bash
docker compose exec bot npm run bot:subscribe
```

`POST /subscriptions` is also the MAX API method used to update a webhook subscription, so the same public endpoint may be submitted again with the new update type configuration. The subscribe script also PATCHes the bot command list.

Verify:

```bash
docker compose exec bot node -e "
fetch('https://platform-api2.max.ru/subscriptions',{headers:{Authorization:process.env.MAX_BOT_TOKEN}})
.then(r=>r.text()).then(console.log)
"
```

## 4. Live smoke in MAX

Start with:

```text
/start
/status
/requirements
/actions
/changes
/documents
/history
/profile
/help
```

Then test an ordinary phrase (`что мне нужно сделать`) and a safe topic lookup (`что у меня по персональным данным?`). Complete one current action through `Готово N` → `Подтвердить` and verify the same action becomes completed in Mini App.

Full matrix: `BOT_SCENARIOS_0.9.15.md`.

## 5. Rollback

Source rollback can be done by restoring the previous 0.9.14 source archive while keeping the production `.env` and PostgreSQL volume. 0.9.15 introduces no DB migration. Do not use `docker compose down -v` on the production stack.
