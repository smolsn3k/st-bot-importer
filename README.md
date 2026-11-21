# Bot Importer for SillyTavern

English | [Русский](README.ru.md)

Import many character cards at once. Set each bot's profile picture, tags and lorebooks before importing, without opening any bot. Works on desktop and on phones.

## Install from GitHub

1. In SillyTavern, open the **Extensions** panel (the stacked-blocks icon).
2. Press **Install extension**.
3. Paste this address and confirm:

   ```
   https://github.com/smolsn3k/st-bot-importer
   ```

4. Choose whether to install it for just you or for all users, then reload the page.

To update later, open the Extensions panel and press the update button next to Bot Importer (or use **Manage extensions**).

### Manual install

Clone the repository into your extensions folder, then reload SillyTavern:

```
cd SillyTavern/data/<your-user>/extensions
git clone https://github.com/smolsn3k/st-bot-importer
```

You can also download the repository as a ZIP and unpack it into the same folder. Make sure `manifest.json` ends up directly inside the `st-bot-importer` folder, next to `index.js`, `lib.js`, `i18n.js` and `style.css`.

## Language

The extension is available in English and Russian. By default it follows your SillyTavern (or browser) language, so a Russian setup gets the Russian interface. You can switch at any time:

- with the **EN / RU** button in the header of the Bot Importer window
- with the **Language** list in the Extensions panel, under Bot Importer

## Open it

- the **Bot Importer** entry in the magic wand menu (next to the chat box)
- the box icon next to the "Import character" button in the character list
- **Open Bot Importer** in the Extensions panel

## Use it

1. Drop PNG or JSON cards on the window, or tap the drop area to browse. Pick as many as you like.
2. On each card:
   - tap the picture to choose a new profile picture (or drop an image on it)
   - add or remove tags (type, then Enter or comma)
   - choose a main lorebook, or leave the card's own setting
   - add any number of additional lorebooks
3. Use the bulk bar to work on all selected cards at once (see below).
4. Press **Import**. Imported cards leave the list; failed ones stay with the reason.

## Bulk bar

- **Add tags**: type one or more tags, separated by commas, and add them to every selected card.
- **Remove tags**: type one or more tags, separated by commas, and remove them from every selected card. Under the field you also see every tag found on the selected cards with a count. Tap one to remove it from all of them.
- **Main lorebook** and **additional lorebook**: choose a lorebook to set or add it on every selected card.
- **Select all, Select none, Only unique, Clear list**: quick selection helpers.

## Ignoring tags

- Tick **Ignore tags that come with the cards** (in the bulk bar or the Extensions panel) and every card starts with no tags. Tags you add yourself are kept. Untick it to bring the card's own tags back.
- In the Extensions panel, **Always ignore these tags** takes a comma-separated list. Those tags are dropped from every card, and the rest are kept.

Ignored tags are also removed from the card data that gets imported.

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
- The main lorebook is saved as the card's linked lorebook. Additional lorebooks are saved in SillyTavern's lorebook settings for that character. Lorebooks must already exist in SillyTavern.
- Tags are added to SillyTavern's tag list and also written into the card.
- The first duplicate check on a large library takes a moment while it is indexed. After that it is cached until you reload the page.
