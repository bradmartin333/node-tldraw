# node-tldraw

a ready to go tldraw container and webpage

## usage

```bash
docker volume create tldraw_sync_data
docker compose up -d --build
```

open http://localhost:3000

## notes

- if you need custom host/CORS settings, copy `.env.example` to `.env` and edit it
- boards are saved in the Docker volume `tldraw_sync_data` (shared across CLI/Dockge as long as they use the same Docker engine)

## licensing

- the tldraw SDK remains under its [original license](https://tldraw.dev/community/license), and production use requires an appropriate tldraw trial, commercial, or hobby license
