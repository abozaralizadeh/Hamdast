# Contributing

Thanks for wanting to help. Issues and pull requests are welcome.

## The license, and what you agree to

Hamdast is source available under the PolyForm Noncommercial License 1.0.0 (see `LICENSE`). Anyone may use and study it for non-commercial purposes. The author keeps every right to use it commercially, and to license it to others for commercial use.

A contribution is accepted only if you agree to this: by opening a pull request or sending code, text or other material, you confirm that you wrote it (or have the right to share it), that it can be distributed under the project's license, and that Abozar may relicense it, commercial terms included. If you can't agree to that, please open an issue to talk about the idea instead of sending code.

Want to use Hamdast commercially? Ask for written permission by opening an issue.

## Before you open a pull request

- Run `npm test` and add a test for what you change.
- The rules engine in `src/engine/` stays pure: no clock, network, database or randomness of its own.
- Everything a player receives goes through `src/server/view.js`. If you add a field to a view, extend the leak tests in `test/server.test.js` and `test/units.test.js`.
- The browser app never builds HTML from strings and uses no inline styles. CSS uses logical properties only, so right to left keeps working. Tests check these.
- Keep the data minimal. No names, phone numbers or recordings, and no chat text or roles in logs.
- No new dependencies without a good reason. Staying dependency free is a feature.
- Write plain words in docs and comments, and no em dashes.

## Third-party code

The only third-party assets today are the Vazirmatn and Fraunces fonts, listed in `THIRD_PARTY_NOTICES.md`. If you add anything else, say where it comes from and under which license, and list it there too. It keeps its own license.
