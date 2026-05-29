# node-tldraw

a ready to go tldraw container and webpage

## usage

```bash
docker compose up -d --build
```

open http://localhost:3000

## notes

- if you need custom host/CORS settings, copy `.env.example` to `.env` and edit it
- boards are saved in the Docker volume `tldraw_sync_data` (shared across CLI/Dockge as long as they use the same Docker engine)

## migrate existing data (one-time)

if your boards currently live in a bind-mounted folder (for example `/opt/stacks/tldraw/data` from Dockge), copy them once into the shared Docker volume

```bash
docker volume create tldraw_sync_data
docker run --rm \
	-v tldraw_sync_data:/to \
	-v /opt/stacks/tldraw/data:/from \
	alpine sh -c 'cp -av /from/. /to/'
```

then, redeploy the stack

## licensing

- the tldraw SDK remains under its [original license](https://tldraw.dev/community/license), and production use requires an appropriate tldraw trial, commercial, or hobby license
