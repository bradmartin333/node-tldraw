# node-tldraw

a ready to go tldraw container and webpage

## usage

```bash
curl -O https://raw.githubusercontent.com/bradmartin333/node-tldraw/main/deploy/docker-compose.yml

docker compose up -d
```

open <http://localhost:3000>

## custom logos

1. create both files

```sh
cd /path/to/your/compose/dir # for Dockge, this is /opt/stacks/node-tldraw/
cp /path/to/light-logo.webp ./logo-light.webp
cp /path/to/dark-logo.webp  ./logo-dark.webp
```

2. uncomment the `configs` lines in `docker-compose.yml`

## develop

with docker (builds and runs the production image from source):

```bash
docker compose up -d --build
```

## licensing

the tldraw SDK remains under its [original license](https://tldraw.dev/community/license), and production use requires an appropriate tldraw trial, commercial, or hobby license
