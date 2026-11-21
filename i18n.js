/* Bot Importer: translations. English is the source text, so only Russian needs a table. */

/** Index of the plural form for a number. English: 0 = one, 1 = other. Russian: 0 = one, 1 = few, 2 = many. */
export function pluralIndex(lang, n) {
    if (lang !== 'ru') return n === 1 ? 0 : 1;
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 0;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 1;
    return 2;
}

/** Plural phrases. {n} is replaced with the number. */
export const PL = {
    importN: { en: ['Import {n} bot', 'Import {n} bots'], ru: ['Импортировать {n} бота', 'Импортировать {n} бота', 'Импортировать {n} ботов'] },
    dupN: { en: [', {n} possible duplicate', ', {n} possible duplicates'], ru: [', {n} возможный дубликат', ', {n} возможных дубликата', ', {n} возможных дубликатов'] },
    greetN: { en: ['{n} extra greeting', '{n} extra greetings'], ru: ['{n} доп. приветствие', '{n} доп. приветствия', '{n} доп. приветствий'] },
    readN: { en: ['Reading {n} file…', 'Reading {n} files…'], ru: ['Читаю {n} файл…', 'Читаю {n} файла…', 'Читаю {n} файлов…'] },
    skipN: {
        en: ['{n} file skipped. Only .png and .json cards work here.', '{n} files skipped. Only .png and .json cards work here.'],
        ru: ['Пропущен {n} файл. Здесь работают только карточки .png и .json.', 'Пропущено {n} файла. Здесь работают только карточки .png и .json.', 'Пропущено {n} файлов. Здесь работают только карточки .png и .json.'],
    },
    tagAddedN: { en: ['Tag added to {n} card.', 'Tag added to {n} cards.'], ru: ['Тег добавлен в {n} карточку.', 'Тег добавлен в {n} карточки.', 'Тег добавлен в {n} карточек.'] },
    lbSetN: { en: ['Lorebook set on {n} card.', 'Lorebook set on {n} cards.'], ru: ['Лорбук задан для {n} карточки.', 'Лорбук задан для {n} карточек.', 'Лорбук задан для {n} карточек.'] },
    lbAddedN: { en: ['Lorebook added to {n} card.', 'Lorebook added to {n} cards.'], ru: ['Лорбук добавлен в {n} карточку.', 'Лорбук добавлен в {n} карточки.', 'Лорбук добавлен в {n} карточек.'] },
    removedN: { en: ['Removed from {n} card.', 'Removed from {n} cards.'], ru: ['Убрано у {n} карточки.', 'Убрано у {n} карточек.', 'Убрано у {n} карточек.'] },
    poolTitle: {
        en: ['Remove "{name}" from {n} selected card', 'Remove "{name}" from {n} selected cards'],
        ru: ['Убрать «{name}» у {n} выбранной карточки', 'Убрать «{name}» у {n} выбранных карточек', 'Убрать «{name}» у {n} выбранных карточек'],
    },
    failedN: {
        en: ['{n} card failed and stayed in the list.', '{n} cards failed and stayed in the list.'],
        ru: ['{n} карточка не импортирована и осталась в списке.', '{n} карточки не импортированы и остались в списке.', '{n} карточек не импортировано и осталось в списке.'],
    },
    importedN: {
        en: ['Imported {n} bot. Add more or close this window.', 'Imported {n} bots. Add more or close this window.'],
        ru: ['Импортирован {n} бот. Добавьте ещё или закройте окно.', 'Импортировано {n} бота. Добавьте ещё или закройте окно.', 'Импортировано {n} ботов. Добавьте ещё или закройте окно.'],
    },
    importedToast: { en: ['Imported {n} bot', 'Imported {n} bots'], ru: ['Импортирован {n} бот', 'Импортировано {n} бота', 'Импортировано {n} ботов'] },
};

/** Russian strings, keyed by the English source text. */
export const RU = {
    /* errors (some come from lib.js) */
    'no character data inside this PNG': 'в этом PNG нет данных персонажа',
    'not valid JSON': 'некорректный JSON',
    'unsupported file type': 'неподдерживаемый тип файла',
    'this does not look like a character card': 'это не похоже на карточку персонажа',
    'not a valid PNG file': 'некорректный PNG-файл',
    'PNG file is truncated': 'PNG-файл повреждён (обрезан)',
    'the character data inside this PNG is corrupted': 'данные персонажа в этом PNG повреждены',
    'not a character card': 'это не карточка персонажа',
    'the server rejected this card': 'сервер отклонил эту карточку',
    'the server answered {status}': 'сервер ответил {status}',
    'could not read the chosen picture': 'не удалось прочитать выбранную картинку',
    'could not process the chosen picture': 'не удалось обработать выбранную картинку',
    'lorebook settings are not reachable': 'настройки лорбуков недоступны',
    'Duplicate check failed. See the browser console for details.': 'Не удалось проверить дубликаты. Подробности в консоли браузера.',
    '{name} was imported, but its additional lorebooks could not be set.': '{name} импортирован, но дополнительные лорбуки задать не удалось.',
    ' Failed: {error}': ' Ошибка: {error}',

    /* duplicate banners (labels come from lib.js) */
    'Exact duplicate': 'Точный дубликат',
    'Near-identical card': 'Почти идентичная карточка',
    'Same description, different intro. Could be an alternate scenario': 'То же описание, другое вступление. Возможно, альтернативный сценарий',
    'Same intro message, different description': 'То же вступительное сообщение, другое описание',
    'Looks similar': 'Похоже на другую',
    'Same name, but the content is different. Probably another bot': 'То же имя, но содержимое другое. Скорее всего, другой бот',
    'In your library': 'В вашей библиотеке',
    'In this batch': 'В этой пачке',
    '(no name)': '(без имени)',
    ', description {d}, intro {i}': ', описание {d}, вступление {i}',
    'Compare intro messages': 'Сравнить вступительные сообщения',
    'This card': 'Эта карточка',
    'Match': 'Совпадение',
    '(empty)': '(пусто)',

    /* status */
    'Checking your library for duplicates…': 'Проверяю библиотеку на дубликаты…',
    'Indexing your library for duplicate checks: {done} of {total}': 'Индексирую библиотеку для поиска дубликатов: {done} из {total}',
    ' Importing…': ' Импорт…',
    ' Imported': ' Импортировано',
    'Wait for the current import to finish.': 'Дождитесь окончания текущего импорта.',
    'Nothing could be imported. Open the failed cards for details.': 'Ничего не удалось импортировать. Подробности — в карточках с ошибками.',
    '; and {n} more': '; и ещё {n}',
    ', {fail} failed': ', с ошибками: {fail}',
    'No cards added yet': 'Карточки ещё не добавлены',
    '{sel} of {total} selected': 'Выбрано {sel} из {total}',
    'Select some cards first.': 'Сначала выберите карточки.',
    'None of the selected cards had those tags.': 'Ни у одной из выбранных карточек нет этих тегов.',

    /* card */
    'Change profile picture': 'Сменить аватар',
    'Go back to the original picture': 'Вернуть исходную картинку',
    'Add a tag': 'Добавить тег',
    'Lorebook': 'Лорбук',
    'Import {name}': 'Импортировать {name}',
    'Remove {name} from the list': 'Убрать {name} из списка',
    'Remove from this list': 'Убрать из списка',
    'PNG card': 'PNG-карточка',
    'JSON card': 'JSON-карточка',
    'Has its own lorebook': 'Есть свой лорбук',
    'No description': 'Нет описания',
    'Tags': 'Теги',
    'Main lorebook': 'Основной лорбук',
    'Additional lorebooks': 'Дополнительные лорбуки',
    'Remove tag': 'Удалить тег',
    'Remove tag {t}': 'Удалить тег {t}',
    'Remove lorebook': 'Убрать лорбук',
    'Remove lorebook {w}': 'Убрать лорбук {w}',
    'Add an additional lorebook': 'Добавить дополнительный лорбук',
    'Add a lorebook': 'Добавить лорбук',
    'Choose a lorebook': 'Выберите лорбук',
    'Keep the card’s setting': 'Оставить настройку карточки',
    'Keep the card’s lorebook ({own})': 'Оставить лорбук карточки ({own})',
    'No linked lorebook': 'Без привязанного лорбука',

    /* window */
    'Import many bots at once without opening each one': 'Импорт множества ботов без открытия каждого',
    'Close': 'Закрыть',
    'Language': 'Язык',
    'Automatic': 'Автоматически',
    'Add character cards': 'Добавьте карточки персонажей',
    'Drop PNG or JSON files here, or tap to browse. You can pick as many as you like.': 'Перетащите PNG или JSON сюда или нажмите, чтобы выбрать файлы. Можно выбрать сколько угодно.',
    'Cards you add show up here. Set a picture, tags and a lorebook on each one, then import them together.': 'Добавленные карточки появятся здесь. Задайте каждой картинку, теги и лорбук, затем импортируйте все вместе.',
    'Select all': 'Выбрать все',
    'Select none': 'Снять выбор',
    'Only unique': 'Только уникальные',
    'Clear list': 'Очистить список',
    'Tag for selected cards': 'Тег для выбранных карточек',
    'Add tags': 'Добавить теги',
    'Tags to remove, separated by commas': 'Теги для удаления, через запятую',
    'Remove tags': 'Удалить теги',
    'Tags on the selected cards. Tap one to remove it from all of them': 'Теги выбранных карточек. Нажмите на тег, чтобы убрать его у всех',
    'Lorebook for selected cards': 'Лорбук для выбранных карточек',
    'Additional lorebook for selected cards': 'Дополнительный лорбук для выбранных карточек',
    'Ignore tags that come with the cards': 'Игнорировать теги из карточек',
    'Import': 'Импорт',
    'Bulk import with Bot Importer': 'Массовый импорт через Bot Importer',

    /* cropper */
    'Crop picture': 'Обрезать картинку',
    'Crop profile picture': 'Обрезка аватара',
    'Drag to move. Pinch, scroll or use the slider to zoom.': 'Перетаскивайте, чтобы сдвинуть. Масштаб: щипок, колесо мыши или ползунок.',
    'Zoom': 'Масштаб',
    'Reset': 'Сбросить',
    'Show whole image': 'Показать целиком',
    'Cancel': 'Отмена',
    'Apply crop': 'Применить',
    'Open the cropper when choosing a picture': 'Открывать обрезку при выборе картинки',

    /* settings panel */
    'Open Bot Importer': 'Открыть Bot Importer',
    'Duplicate threshold:': 'Порог дубликата:',
    'Similar threshold:': 'Порог схожести:',
    'Untick exact duplicates automatically': 'Автоматически снимать галочку с точных дубликатов',
    'Always ignore these tags (separated by commas)': 'Всегда игнорировать эти теги (через запятую)',
    'Cards are compared by description and intro messages, never by name alone. New thresholds apply to cards added from now on.':
        'Карточки сравниваются по описанию и вступительным сообщениям, а не только по имени. Новые пороги действуют для карточек, добавленных после изменения.',
};
