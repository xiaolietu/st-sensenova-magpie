# NOTICE

## The SenseNova logo

`assets/sensenova.png` is SenseNova's icon, taken from
`https://platform.sensenova.cn/favicon.ico` (which, despite the name and the
`image/x-icon` response header, serves a 65×65 PNG). SenseNova（日日新）是商汤的
商标与财产。

It is included here for one reason: to identify the SenseNova provider in
Magpie's provider list. Magpie reads it through the `auth.icon` hook and the
`magpie.icon` field in `package.json`.

This plugin is an **unaffiliated third-party client**. SenseTime does not
endorse it, and the logo's presence implies no relationship. If you fork this
plugin for a different service, replace the file.

## The endpoints this plugin talks to

Two of the three are **not** public APIs:

- `https://token.sensenova.cn/v1` — the Token Plan's OpenAI-compatible API.
  This is the documented, intended way to call the models.
- An endpoint on `https://platform.sensenova.cn` — the one the SenseNova
  **console's own frontend** calls to draw its 积分额度 panel. It is internal,
  undocumented, and may change or disappear without notice. It is used here
  because the platform publishes no API-key-accessible quota endpoint at all
  (every candidate path answers 404). Its path is deliberately not written
  down in this file; it is in `quota.mjs`.
- `https://iam.sensecoreapi.cn/iam/authn/…` — the platform's IAM login service,
  used the same way the console's login page uses it, to renew the console
  token that the quota endpoint requires.

Using the console's internal endpoints may or may not be within the platform's
terms of service. That is the user's call, not this plugin's.

## Shared logic

`quota.mjs` is a port of the credential and quota logic from the companion
command-line tool `snquota`, which was written alongside this plugin. Both are
MIT licensed; see `LICENSE`.
