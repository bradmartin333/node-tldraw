# node-tldraw

a ready to go tldraw container and webpage

## run it

```bash
curl -O https://raw.githubusercontent.com/bradmartin333/node-tldraw/main/deploy/docker-compose.yml

docker compose up -d
```

open <http://localhost:3000>

no build, no manual volume setup, and no env vars *if you stay on localhost*. reaching
it by hostname or LAN IP needs two vars — see [reaching it from another host](#reaching-it-from-another-host).
to update: `docker compose pull && docker compose up -d`.

> **don't use docker desktop's *Run* dialog.** it leaves the port fields blank,
> so nothing is published to the host and the page never loads — and it attaches
> a throwaway volume, so boards vanish when the container is removed. use the
> compose file above; docker desktop will show it under **Containers** with
> start/stop/logs buttons.

the equivalent `docker run`, if you prefer it:

```bash
docker run -d --name tldraw --restart always \
  -p 3000:3000 -p 8787:8787 \
  -v tldraw_sync_data:/data \
  bradmartin333/node-tldraw:latest
```

**both ports are required.** 3000 serves the web app; 8787 serves the sync API and
websocket, which the browser connects to directly. publish only 3000 and the page
loads but no boards appear.

boards persist in the `tldraw_sync_data` volume. `docker compose down` keeps it;
only `docker compose down -v` deletes it.

## custom logos

swap in your own logos — no rebuild needed.

**1. create both files first.** they must exist *before* `docker compose up`, or the
mount fails:

```sh
cd /path/to/your/compose/dir # for Dockge, this is /opt/stacks/node-tldraw/
cp /path/to/light-logo.webp ./logo-light.webp
cp /path/to/dark-logo.webp  ./logo-dark.webp
```

## develop

```bash
docker compose up -d --build   # builds from source, app + sync as separate containers
```

## licensing

the tldraw SDK remains under its [original license](https://tldraw.dev/community/license), and production use requires an appropriate tldraw trial, commercial, or hobby license
