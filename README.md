# Bot Importer for SillyTavern

Import many character cards at once. Set each bot's profile picture, tags and lorebook before importing, without opening any bot. Works on desktop and on phones.

## Install

Copy the `st-bot-importer` folder (all five files) into one of these:

- `SillyTavern/data/<your-user>/extensions/` (recommended; `default-user` on a single-user setup)
- `SillyTavern/public/scripts/extensions/third-party/`

Restart SillyTavern and refresh the page. The folder must contain `manifest.json`, `index.js`, `lib.js` and `style.css`.

## Open it

- the **Bot Importer** entry in the magic wand menu (next to the chat box)
- the box icon next to the "Import character" button in the character list
- **Open Bot Importer** in the Extensions panel

## Use it

1. Drop PNG or JSON cards on the window, or tap the drop area to browse. Pick as many as you like.
2. On each card:
   - tap the picture to choose a new profile picture (or drop an image on it)
   - add or remove tags (type, then Enter or comma)
   - choose a lorebook to link, or leave the card's own setting
3. Use the bulk bar to add one tag, or one lorebook, to all selected cards.
4. Press **Import**. Imported cards leave the list; failed ones stay with the reason.

## Duplicate warnings

Cards are compared with your whole library and with each other by description and intro messages (first message plus alternate greetings), never by name alone.

| Banner | Meaning |
| --- | --- |
| Exact duplicate / Near-identical (red) | Description and intro both match. Unticked automatically. |
| Same description, different intro (amber) | Probably an alternate scenario of a bot you already have. |
| Same intro, different description (amber) | Same opening, rewritten bot. |
| Looks similar (yellow) | Partial overlap. |
| Same name, different content (blue) | Only the name matches. Probably not a duplicate. |

Open **Compare intro messages** on a banner to read both intros side by side. Thresholds are in the Extensions panel.

## Notes

- A new profile picture is cropped to 512×768 (2:3), keeping the top of the image. The card data is embedded in the new PNG.
- Lorebook links use the card's linked-lorebook setting, so the lorebook must already exist in SillyTavern.
- Tags are added to SillyTavern's tag list and also written into the card.
- The first duplicate check on a large library takes a moment while it is indexed. After that it is cached until you reload the page.
