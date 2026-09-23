# Changelog

## 0.0.1

First release.

- Hover a symbol to see the explanation saved for it in wise.
- TypeScript and JavaScript resolve by declaration, so pointing anywhere inside
  a function finds it. Every other language resolves through an in-code anchor,
  on the marker line or the declaration directly below it.
- Shows the opening paragraph rather than the whole explanation, with a link
  into the viewer for the rest.
- Stays silent when wise is not running, when a file sits outside a workspace,
  or when nothing is stored at the cursor.
- Settings: `wise.enabled`, `wise.port`.
