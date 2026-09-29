# Kitchen QR — Angular client

Angular (standalone components) web UI for the Kitchen QR app. It talks to the
same Express API as the other clients; no API changes were needed beyond the
new `PARTIALLY_READY` order status.

## Dependencies (kept minimal on purpose)

| Package | Why |
|---|---|
| `@angular/core`, `common`, `platform-browser`, `router`, `compiler` | The framework itself |
| `rxjs`, `zone.js` | Angular peer dependencies |
| `gridjs` | Free (MIT) data grid used for the staff orders table |
| `typescript`, `esbuild`, `@angular/compiler-cli` | Build only (`ngc` for AOT templates, esbuild for bundling) |

No Angular CLI, no Vite, no UI kit — styling is hand-written modern CSS in
`src/styles.css`.

## Build

```bash
npm install   # once
npm run build # ngc (AOT) + esbuild -> client/dist/
```

`client/dist/` is **committed** so the app runs straight from `./start.sh`
with no client-side install. Rebuild after changing anything under `src/`.
